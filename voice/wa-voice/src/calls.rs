//! Call slots: the bridge between the control socket and whatsapp-rust's
//! call facade. Each live call owns a 60 ms ticker that feeds the engine one
//! 960-sample frame per tick (queued PCM from the socket, else near-silence —
//! the engine emits one RTP packet per mic frame, so the ticker IS the RTP
//! clock) and a drain that re-chunks the peer's decoded audio into 960-sample
//! frames on the socket.
//!
//! Idle frames are comfort noise at a realistic room-noise level (~-60 dBFS,
//! low-passed), never digital silence. Two reasons, both learnt on the live
//! test calls of 2026-09-20 ("when you said great, I only heard the T";
//! "count to five" → "I never heard the number one"):
//! - wacore's `encode_mlow_frame` treats an exactly all-zero frame as OS
//!   mic-mute and sends a one-byte DTX comfort-noise packet instead of speech,
//!   so the peer sat in comfort-noise mode between utterances;
//! - ±1 LSB dither (-90 dBFS) fixed the DTX but not the cut-off: the encoder
//!   codes it as active speech (TOC 0x50), yet the phone still lost the first
//!   word — its receive path adapts to an idle level no real microphone ever
//!   produces. A phone mic sits around -60 dBFS in a quiet room; giving the
//!   peer that floor keeps every adaptive stage on its side (gate, NS, AGC,
//!   audio path) in the state a human caller would leave it in.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use bytes::Bytes;
use log::{debug, error, info, warn};
use tokio::sync::RwLock;
use whatsapp_rust::voip::audio::WaOpusDecoder;
use whatsapp_rust::voip::{CallEvent, CallHandle, CallTermination};
use whatsapp_rust::wacore::types::call::{CallAction, IncomingCall};
use whatsapp_rust::{Client, Jid};

use crate::proto::{CallSummary, Command, Event};
use crate::wire::WIRE;
use crate::ws::Broadcaster;

pub const FRAME_SAMPLES: usize = 960;
const TICK: Duration = Duration::from_millis(60);
/// ~24 s of queued outbound speech; beyond this the producer is misbehaving.
const MAX_QUEUE_FRAMES: usize = 400;

/// Idle-frame comfort noise: xorshift white noise through a one-pole low-pass
/// (a soft hiss rather than a bright one), scaled to `WA_VOICE_IDLE_NOISE_DB`
/// dBFS RMS (default -60; `-inf`/`off` = ±1 LSB dither only). No crate, no
/// allocation beyond the frame.
pub struct IdleNoise {
    x: u32,
    lp: f32,
    gain: f32,
}

const IDLE_NOISE_DEFAULT_DB: f32 = -60.0;
const DITHER_ONLY: f32 = -1000.0;

impl IdleNoise {
    pub fn new() -> Self {
        Self::with_level_db(Self::configured_level_db())
    }

    pub fn configured_level_db() -> f32 {
        match std::env::var("WA_VOICE_IDLE_NOISE_DB") {
            Ok(v) if matches!(v.trim().to_ascii_lowercase().as_str(), "off" | "-inf" | "none") => DITHER_ONLY,
            Ok(v) => v.trim().parse::<f32>().unwrap_or(IDLE_NOISE_DEFAULT_DB).clamp(-100.0, -30.0),
            Err(_) => IDLE_NOISE_DEFAULT_DB,
        }
    }

    /// `level_db` = target RMS in dBFS (full scale = 32767); `DITHER_ONLY` (any
    /// value < -100) gives ±1 LSB dither.
    pub fn with_level_db(level_db: f32) -> Self {
        let gain = if level_db < -100.0 {
            0.0
        } else {
            // The low-pass below has ~0.28 RMS gain on unit-variance input; uniform
            // noise in [-1, 1] has RMS 0.577.
            32767.0 * 10f32.powf(level_db / 20.0) / (0.577 * 0.28)
        };
        Self { x: 0x9E37_79B9, lp: 0.0, gain }
    }

    fn next_u32(&mut self) -> u32 {
        let mut x = self.x;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.x = x;
        x
    }

    fn next_sample(&mut self) -> i16 {
        let white = (self.next_u32() as f32 / u32::MAX as f32) * 2.0 - 1.0;
        if self.gain == 0.0 {
            return ((self.next_u32() % 3) as i16) - 1;
        }
        self.lp += 0.15 * (white - self.lp);
        (self.lp * self.gain).round().clamp(-2000.0, 2000.0) as i16
    }

    /// A full idle frame (never all zeros).
    pub fn frame(&mut self) -> Vec<i16> {
        let mut f = vec![0i16; FRAME_SAMPLES];
        self.apply(&mut f);
        f
    }

    /// Guarantee `frame` is not exactly all-zero (the engine's mute fast-path)
    /// by filling it with comfort noise. Frames with any signal are untouched.
    pub fn apply(&mut self, frame: &mut [i16]) {
        if frame.iter().any(|&s| s != 0) {
            return;
        }
        for s in frame.iter_mut() {
            *s = self.next_sample();
        }
        if frame.iter().all(|&s| s == 0) {
            frame[0] = 1;
        }
    }
}

impl Default for IdleNoise {
    fn default() -> Self {
        Self::new()
    }
}

/// A/B levers for the first-word cut-off (research/voice-cutoff-investigation.md),
/// read once per call from the environment (`~/.config/console/voice.env` is
/// loaded at startup) so a test call needs `pm2 restart wa-voice`, not a rebuild:
/// - `WA_VOICE_DTX=1`: idle frames are exact zeros, so the engine sends 1-byte SID
///   packets with the DTX extension and a marker on the first speech frame (the
///   framing of calls 1-2 on 20 Sept);
/// - `WA_VOICE_ONSET_PREROLL_MS=<n>` + `WA_VOICE_ONSET_PREROLL=tone|noise`
///   [+ `WA_VOICE_ONSET_PREROLL_DB`, default -30]: when the queue goes from empty
///   to non-empty, <n> ms of pre-roll go out BEFORE the queued speech (a 440 Hz
///   tone is the diagnostic: whether it is heard whole says whether a level gate
///   sits between the wire and the phone's speaker; noise is the production shape).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Preroll {
    Off,
    Tone,
    Noise,
}

#[derive(Clone, Copy, Debug)]
pub struct Levers {
    pub dtx: bool,
    pub preroll: Preroll,
    pub preroll_frames: usize,
    pub preroll_db: f32,
}

impl Levers {
    pub fn from_env() -> Self {
        let flag = |k: &str| std::env::var(k).map(|v| !matches!(v.trim(), "" | "0" | "off" | "false" | "no")).unwrap_or(false);
        let ms: usize = std::env::var("WA_VOICE_ONSET_PREROLL_MS").ok().and_then(|v| v.trim().parse().ok()).unwrap_or(0);
        let kind = match std::env::var("WA_VOICE_ONSET_PREROLL").map(|v| v.trim().to_ascii_lowercase()) {
            Ok(v) if v == "tone" => Preroll::Tone,
            Ok(v) if v == "noise" => Preroll::Noise,
            _ => Preroll::Off,
        };
        let preroll = if ms == 0 { Preroll::Off } else { kind };
        Self {
            dtx: flag("WA_VOICE_DTX"),
            preroll,
            preroll_frames: if preroll == Preroll::Off { 0 } else { ms.div_ceil(60) },
            preroll_db: std::env::var("WA_VOICE_ONSET_PREROLL_DB")
                .ok()
                .and_then(|v| v.trim().parse().ok())
                .unwrap_or(-30.0f32)
                .clamp(-60.0, -10.0),
        }
    }

    /// The whole pre-roll as frames: a 440 Hz tone or low-passed noise at
    /// `preroll_db`, with a 20 ms raised-cosine fade at both ends.
    pub fn preroll_frames(&self) -> VecDeque<Vec<i16>> {
        let n = self.preroll_frames * FRAME_SAMPLES;
        if n == 0 {
            return VecDeque::new();
        }
        let amp = 32767.0 * 10f32.powf(self.preroll_db / 20.0);
        let mut noise = IdleNoise::with_level_db(self.preroll_db);
        let fade = 320usize;
        let mut buf: Vec<i16> = Vec::with_capacity(n);
        for i in 0..n {
            let mut v = match self.preroll {
                Preroll::Tone => (amp * 1.414) * (2.0 * std::f32::consts::PI * 440.0 * i as f32 / 16000.0).sin(),
                Preroll::Noise => noise.next_sample() as f32,
                Preroll::Off => 0.0,
            };
            let env = if i < fade {
                0.5 - 0.5 * (std::f32::consts::PI * i as f32 / fade as f32).cos()
            } else if i >= n - fade {
                0.5 - 0.5 * (std::f32::consts::PI * (n - 1 - i) as f32 / fade as f32).cos()
            } else {
                1.0
            };
            v *= env;
            buf.push(v.round().clamp(-32767.0, 32767.0) as i16);
        }
        buf.chunks(FRAME_SAMPLES).map(|c| c.to_vec()).collect()
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Direction {
    In,
    Out,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Phase {
    /// Inbound offer waiting for `answer`/`reject`.
    Offered,
    /// Outbound offer sent, peer not yet accepted.
    Ringing,
    Live,
}

struct Slot {
    call_id: String,
    peer: String,
    direction: Direction,
    phase: Phase,
    started: Instant,
    live_at: Option<Instant>,
    queue: Arc<Mutex<VecDeque<Vec<i16>>>>,
    incoming: Option<Arc<IncomingCall>>,
    handle: Option<CallHandle>,
    ended_sent: bool,
}

#[derive(Default)]
struct State {
    connected: bool,
    paired: bool,
    jid: Option<String>,
    slots: HashMap<u8, Slot>,
    /// The QR currently valid for pairing, replayed to late-joining clients.
    qr: Option<(Event, Instant, Duration)>,
}

pub struct CallManager {
    bcast: Broadcaster,
    client: RwLock<Option<Arc<Client>>>,
    state: Mutex<State>,
    /// Fired by `repair`; main's run loop restarts the client for a fresh QR batch.
    pub repair: tokio::sync::Notify,
}

impl CallManager {
    pub fn new(bcast: Broadcaster) -> Self {
        Self {
            bcast,
            client: RwLock::new(None),
            state: Mutex::new(State::default()),
            repair: tokio::sync::Notify::new(),
        }
    }

    fn st(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }

    // ---- connection state (driven by main's bot loop) ----

    pub async fn set_client(&self, client: Option<Arc<Client>>) {
        *self.client.write().await = client;
    }

    pub fn set_connected(&self, jid: Option<String>) {
        let mut st = self.st();
        st.connected = true;
        st.paired = true;
        st.jid = jid.clone();
        st.qr = None;
        drop(st);
        self.bcast.event(&Event::Ready { jid: jid.unwrap_or_default() });
    }

    pub fn set_disconnected(&self, reason: &str) {
        let mut st = self.st();
        st.connected = false;
        drop(st);
        self.bcast.event(&Event::Disconnected { reason: reason.to_string() });
    }

    pub fn set_logged_out(&self) {
        let mut st = self.st();
        st.connected = false;
        st.paired = false;
        st.jid = None;
        drop(st);
        self.bcast.event(&Event::LoggedOut);
    }

    pub fn qr(&self, code: String, timeout: Duration) {
        let data_url = qr_svg_data_url(&code);
        let ev = Event::Qr { code, data_url, timeout_secs: timeout.as_secs() };
        {
            let mut st = self.st();
            st.paired = false;
            st.qr = Some((ev.clone(), Instant::now(), timeout));
        }
        self.bcast.event(&ev);
    }

    /// What a freshly connected client needs to catch up: `ready` if we are
    /// connected, else the QR that is still valid for pairing.
    pub async fn catch_up_events(&self) -> Vec<Event> {
        let st = self.st();
        if st.connected {
            return vec![Event::Ready { jid: st.jid.clone().unwrap_or_default() }];
        }
        match &st.qr {
            Some((ev, at, ttl)) if at.elapsed() < *ttl => vec![ev.clone()],
            _ => vec![],
        }
    }

    pub async fn status(&self, id: Option<String>) -> Event {
        let st = self.st();
        let calls = st
            .slots
            .iter()
            .map(|(slot, s)| CallSummary {
                call_id: s.call_id.clone(),
                slot: *slot,
                peer: s.peer.clone(),
                direction: match s.direction {
                    Direction::In => "in",
                    Direction::Out => "out",
                },
                state: match s.phase {
                    Phase::Offered => "offered",
                    Phase::Ringing => "ringing",
                    Phase::Live => "live",
                },
            })
            .collect();
        Event::Status { connected: st.connected, paired: st.paired, jid: st.jid.clone(), calls, id }
    }

    // ---- media in (socket → engine) ----

    pub fn push_audio(&self, slot: u8, pcm_le: &[u8]) {
        let queue = {
            let st = self.st();
            match st.slots.get(&slot) {
                Some(s) => s.queue.clone(),
                None => return,
            }
        };
        let mut samples: Vec<i16> = pcm_le
            .chunks_exact(2)
            .map(|b| i16::from_le_bytes([b[0], b[1]]))
            .collect();
        let mut q = queue.lock().unwrap_or_else(|p| p.into_inner());
        // Re-chunk to exactly 960 samples; carry a remainder frame forward.
        if let Some(mut tail) = q.pop_back().filter(|f| f.len() < FRAME_SAMPLES) {
            tail.append(&mut samples);
            samples = tail;
        }
        for chunk in samples.chunks(FRAME_SAMPLES) {
            q.push_back(chunk.to_vec());
        }
        while q.len() > MAX_QUEUE_FRAMES {
            q.pop_front();
        }
    }

    // ---- commands ----

    pub async fn handle_command(self: &Arc<Self>, cmd: Command) {
        match cmd {
            Command::Call { to, id } => self.clone().cmd_call(to, id).await,
            Command::Answer { call_id, id } => self.clone().cmd_answer(call_id, id).await,
            Command::Reject { call_id, id } => self.cmd_reject(call_id, id).await,
            Command::Hangup { call_id, id } => self.cmd_hangup(call_id, id).await,
            Command::Flush { call_id } => {
                let q = self.st().slots.values().find(|s| s.call_id == call_id).map(|s| s.queue.clone());
                if let Some(q) = q {
                    q.lock().unwrap_or_else(|p| p.into_inner()).clear();
                }
            }
            Command::Status { id } => {
                let ev = self.status(id).await;
                self.bcast.event(&ev);
            }
            Command::Repair { id } => {
                if self.st().paired {
                    return self.err(None, id, "already paired; nothing to repair");
                }
                self.bcast.event(&Event::Ack { cmd: "repair", call_id: None, slot: None, id });
                self.repair.notify_one();
            }
            Command::Ping => self.bcast.event(&Event::Pong),
        }
    }

    fn err(&self, call_id: Option<String>, id: Option<String>, message: impl Into<String>) {
        let message = message.into();
        warn!("{message}");
        self.bcast.event(&Event::Error { call_id, message, id });
    }

    fn alloc_slot(&self, st: &mut State) -> Option<u8> {
        (0u8..=255).find(|s| !st.slots.contains_key(s))
    }

    fn slot_of(&self, call_id: &str) -> Option<u8> {
        self.st().slots.iter().find(|(_, s)| s.call_id == call_id).map(|(k, _)| *k)
    }

    async fn cmd_call(self: Arc<Self>, to: String, id: Option<String>) {
        let Some(client) = self.client.read().await.clone() else {
            return self.err(None, id, "not connected to WhatsApp");
        };
        if !self.st().connected {
            return self.err(None, id, "not connected to WhatsApp");
        }
        let jid = match parse_jid(&to) {
            Ok(j) => j,
            Err(e) => return self.err(None, id, format!("bad destination {to:?}: {e}")),
        };
        let queue: Arc<Mutex<VecDeque<Vec<i16>>>> = Arc::default();
        // Reserve the slot before the (awaited) offer so a concurrent inbound
        // offer cannot land on the same one.
        let slot = {
            let mut st = self.st();
            let Some(slot) = self.alloc_slot(&mut st) else {
                drop(st);
                return self.err(None, id, "no free call slot");
            };
            st.slots.insert(
                slot,
                Slot {
                    call_id: String::new(),
                    peer: jid.to_string(),
                    direction: Direction::Out,
                    phase: Phase::Ringing,
                    started: Instant::now(),
                    live_at: None,
                    queue: queue.clone(),
                    incoming: None,
                    handle: None,
                    ended_sent: false,
                },
            );
            slot
        };
        let (mic_tx, mic_rx) = async_channel::bounded::<Vec<i16>>(4);
        let (spk_tx, spk_rx) = async_channel::bounded::<Vec<i16>>(16);

        info!("placing call to {jid} (slot {slot})");
        let started = client.voip().call(&jid).audio(mic_rx, spk_tx.clone()).start().await;
        let handle = match started {
            Ok(h) => h,
            Err(e) => {
                self.st().slots.remove(&slot);
                return self.err(None, id, format!("call failed: {e}"));
            }
        };
        let call_id = handle.call_id().to_string();
        {
            let mut st = self.st();
            if let Some(s) = st.slots.get_mut(&slot) {
                s.call_id = call_id.clone();
                s.handle = Some(handle.clone());
            }
        }
        self.bcast.event(&Event::Ack { cmd: "call", call_id: Some(call_id.clone()), slot: Some(slot), id });
        self.bcast.event(&Event::Ringing { call_id: call_id.clone(), slot });
        self.spawn_media_tasks(slot, call_id, handle, queue, mic_tx, spk_rx, spk_tx);
    }

    async fn cmd_answer(self: Arc<Self>, call_id: String, id: Option<String>) {
        let Some(client) = self.client.read().await.clone() else {
            return self.err(Some(call_id), id, "not connected to WhatsApp");
        };
        let (slot, incoming, queue) = {
            let st = self.st();
            match st.slots.iter().find(|(_, s)| s.call_id == call_id) {
                Some((k, s)) if s.phase == Phase::Offered => match &s.incoming {
                    Some(inc) => (*k, inc.clone(), s.queue.clone()),
                    None => return self.err(Some(call_id), id, "offer has no stanza"),
                },
                Some(_) => return self.err(Some(call_id), id, "call is not awaiting an answer"),
                None => return self.err(Some(call_id), id, "unknown callId"),
            }
        };
        let (mic_tx, mic_rx) = async_channel::bounded::<Vec<i16>>(4);
        let (spk_tx, spk_rx) = async_channel::bounded::<Vec<i16>>(16);
        info!("answering {call_id} (slot {slot})");
        let started = client.voip().accept(&incoming).audio(mic_rx, spk_tx.clone()).start().await;
        let handle = match started {
            Ok(h) => h,
            Err(e) => {
                // Local media never came up: decline so the caller's phone stops ringing.
                let _ = client.voip().reject(&incoming).await;
                self.end_slot(slot, Some(format!("answer failed: {e}")));
                return self.err(Some(call_id), id, format!("answer failed: {e}"));
            }
        };
        {
            let mut st = self.st();
            if let Some(s) = st.slots.get_mut(&slot) {
                s.handle = Some(handle.clone());
                s.phase = Phase::Live;
                s.live_at = Some(Instant::now());
                s.incoming = None;
            }
        }
        self.bcast.event(&Event::Ack { cmd: "answer", call_id: Some(call_id.clone()), slot: Some(slot), id });
        self.bcast.event(&Event::Accepted { call_id: call_id.clone(), slot });
        self.spawn_media_tasks(slot, call_id, handle, queue, mic_tx, spk_rx, spk_tx);
    }

    async fn cmd_reject(&self, call_id: String, id: Option<String>) {
        let Some(client) = self.client.read().await.clone() else {
            return self.err(Some(call_id), id, "not connected to WhatsApp");
        };
        let (slot, incoming) = {
            let st = self.st();
            match st.slots.iter().find(|(_, s)| s.call_id == call_id) {
                Some((k, s)) if s.phase == Phase::Offered => match &s.incoming {
                    Some(inc) => (*k, inc.clone()),
                    None => return self.err(Some(call_id), id, "offer has no stanza"),
                },
                Some(_) => return self.err(Some(call_id), id, "call is not awaiting an answer"),
                None => return self.err(Some(call_id), id, "unknown callId"),
            }
        };
        info!("rejecting {call_id}");
        if let Err(e) = client.voip().reject(&incoming).await {
            self.err(Some(call_id.clone()), id.clone(), format!("reject failed: {e}"));
        } else {
            self.bcast.event(&Event::Ack { cmd: "reject", call_id: Some(call_id.clone()), slot: Some(slot), id });
        }
        self.end_slot(slot, Some("rejected".into()));
    }

    async fn cmd_hangup(&self, call_id: String, id: Option<String>) {
        let handle = {
            let st = self.st();
            match st.slots.values().find(|s| s.call_id == call_id) {
                Some(s) => s.handle.clone(),
                None => return self.err(Some(call_id), id, "unknown callId"),
            }
        };
        let Some(handle) = handle else {
            // An unanswered inbound offer: hanging up means declining.
            return self.cmd_reject(call_id, id).await;
        };
        info!("hanging up {call_id}");
        match handle.terminate().await {
            CallTermination::LocalOnly(e) => warn!("terminate unconfirmed by peer ({e}); ended locally"),
            CallTermination::PartlyNotified { notified, unconfirmed } => {
                warn!("terminate reached {notified} device(s), {unconfirmed} unconfirmed")
            }
            _ => {}
        }
        self.bcast.event(&Event::Ack { cmd: "hangup", call_id: Some(call_id.clone()), slot: self.slot_of(&call_id), id });
        if let Some(slot) = self.slot_of(&call_id) {
            self.end_slot(slot, Some("local".into()));
        }
    }

    // ---- signaling events (from the client's event stream) ----

    pub fn on_incoming_call(&self, call: &IncomingCall) {
        match &call.action {
            CallAction::Offer { call_id, is_video, caller_pn, group_jid, .. } => {
                if group_jid.is_some() {
                    info!("ignoring group call offer {call_id}");
                    return;
                }
                let from = caller_pn.clone().unwrap_or_else(|| call.from.clone()).to_string();
                let slot = {
                    let mut st = self.st();
                    if st.slots.values().any(|s| &s.call_id == call_id) {
                        return;
                    }
                    let Some(slot) = self.alloc_slot(&mut st) else {
                        warn!("no free slot for incoming {call_id}");
                        return;
                    };
                    st.slots.insert(
                        slot,
                        Slot {
                            call_id: call_id.clone(),
                            peer: from.clone(),
                            direction: Direction::In,
                            phase: Phase::Offered,
                            started: Instant::now(),
                            live_at: None,
                            queue: Arc::default(),
                            incoming: Some(Arc::new(call.clone())),
                            handle: None,
                            ended_sent: false,
                        },
                    );
                    slot
                };
                info!("incoming call {call_id} from {from} (video={is_video}, slot {slot})");
                self.bcast.event(&Event::Incoming { call_id: call_id.clone(), from, video: *is_video, slot });
            }
            CallAction::Accept { call_id, .. } => {
                let slot = {
                    let mut st = self.st();
                    let hit = st.slots.iter_mut().find(|(_, s)| &s.call_id == call_id && s.direction == Direction::Out);
                    match hit {
                        Some((k, s)) if s.phase == Phase::Ringing => {
                            s.phase = Phase::Live;
                            s.live_at = Some(Instant::now());
                            Some(*k)
                        }
                        _ => None,
                    }
                };
                if let Some(slot) = slot {
                    info!("peer accepted {call_id}");
                    self.bcast.event(&Event::Accepted { call_id: call_id.clone(), slot });
                }
            }
            CallAction::Reject { call_id, reason, .. } => {
                // `busy`/`enc` speak for one device; a bare reject is the decline.
                if reason.is_none() {
                    if let Some(slot) = self.slot_of(call_id) {
                        info!("peer declined {call_id}");
                        self.end_slot(slot, Some("declined".into()));
                    }
                }
            }
            CallAction::Terminate { call_id, reason, .. } => {
                if let Some(slot) = self.slot_of(call_id) {
                    let phase = self.st().slots.get(&slot).map(|s| s.phase);
                    let why = match (phase, reason.as_deref()) {
                        (Some(Phase::Offered), _) => "cancelled",
                        (_, Some("timeout")) => "timeout",
                        (_, Some(r)) => r,
                        (_, None) => "peer",
                    };
                    info!("peer ended {call_id} ({why})");
                    self.end_slot(slot, Some(why.to_string()));
                }
            }
            _ => {}
        }
    }

    // ---- lifecycle ----

    fn end_slot(&self, slot: u8, reason: Option<String>) {
        let removed = {
            let mut st = self.st();
            st.slots.remove(&slot)
        };
        if let Some(s) = removed {
            if s.ended_sent {
                return;
            }
            let duration_ms = s.live_at.map(|t| t.elapsed().as_millis() as u64).unwrap_or(0);
            let _ = s.started;
            self.bcast.event(&Event::Ended { call_id: s.call_id, slot, reason, duration_ms });
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn spawn_media_tasks(
        self: &Arc<Self>,
        slot: u8,
        call_id: String,
        handle: CallHandle,
        queue: Arc<Mutex<VecDeque<Vec<i16>>>>,
        mic_tx: async_channel::Sender<Vec<i16>>,
        spk_rx: async_channel::Receiver<Vec<i16>>,
        spk_tx: async_channel::Sender<Vec<i16>>,
    ) {
        WIRE.open(&call_id);
        // Mic ticker: one frame every 60 ms, queued speech else comfort noise
        // (see the module doc: an all-zero frame is "mic muted" to the engine,
        // and digital silence starves the peer's adaptive receive path).
        let ticker_queue = queue.clone();
        let ticker_mic = mic_tx.clone();
        let ticker_handle = handle.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(TICK);
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            let mut idle = IdleNoise::new();
            let levers = Levers::from_env();
            info!(
                "idle comfort noise at {} dBFS; levers {levers:?}",
                if levers.dtx { "DTX (zeros)".to_string() } else { IdleNoise::configured_level_db().to_string() }
            );
            WIRE.line(&format!("levers {levers:?} idle_db={}", IdleNoise::configured_level_db()));
            // Idle -> (Preroll ->) Speaking -> Idle, per queue transition.
            let mut speaking = false;
            let mut preroll: VecDeque<Vec<i16>> = VecDeque::new();
            let mut spoken_frames = 0usize;
            let mut tick_no = 0u64;
            let mut last_tick = Instant::now();
            loop {
                interval.tick().await;
                tick_no += 1;
                let now = Instant::now();
                let gap = now.duration_since(last_tick).as_millis();
                last_tick = now;
                if gap > 90 {
                    WIRE.line(&format!("tick gap {gap} ms at tick {tick_no}"));
                }
                if ticker_mic.is_closed() {
                    break;
                }
                let (popped, depth) = {
                    let mut q = ticker_queue.lock().unwrap_or_else(|p| p.into_inner());
                    let depth = q.len();
                    if !speaking && depth > 0 && preroll.is_empty() && levers.preroll_frames > 0 {
                        preroll = levers.preroll_frames();
                        WIRE.line(&format!("preroll start q_depth={depth} frames={}", preroll.len()));
                    }
                    if !preroll.is_empty() {
                        (None, depth)
                    } else {
                        let f = match q.pop_front() {
                            Some(f) if f.len() == FRAME_SAMPLES => Some(f),
                            Some(mut f) => {
                                WIRE.line(&format!("partial frame {} samples padded", f.len()));
                                f.resize(FRAME_SAMPLES, 0);
                                Some(f)
                            }
                            None => None,
                        };
                        (f, depth)
                    }
                };
                let frame = if let Some(pre) = preroll.pop_front() {
                    pre
                } else if let Some(mut f) = popped {
                    if !speaking {
                        speaking = true;
                        spoken_frames = 0;
                        let rms = (f.iter().map(|&s| (s as f32) * (s as f32)).sum::<f32>() / f.len() as f32).sqrt();
                        WIRE.line(&format!(
                            "onset q_depth={depth} first_frame_dbfs={:.1}",
                            if rms > 0.0 { 20.0 * (rms / 32767.0).log10() } else { -120.0 }
                        ));
                    }
                    spoken_frames += 1;
                    if !levers.dtx {
                        idle.apply(&mut f);
                    }
                    f
                } else {
                    if speaking {
                        speaking = false;
                        WIRE.line(&format!("idle after {spoken_frames} speech frames"));
                    }
                    if levers.dtx { vec![0i16; FRAME_SAMPLES] } else { idle.frame() }
                };
                WIRE.tx_pcm(&frame);
                if ticker_mic.try_send(frame).is_err() {
                    debug!("mic channel full/closed for {}", ticker_handle.call_id());
                    WIRE.line("mic channel full: frame dropped");
                }
            }
        });

        // Speaker drain: peer PCM → 960-sample frames on the socket.
        let bcast = self.bcast.clone();
        let drain_id = call_id.clone();
        tokio::spawn(async move {
            let mut acc: Vec<i16> = Vec::with_capacity(FRAME_SAMPLES * 2);
            while let Ok(pcm) = spk_rx.recv().await {
                WIRE.rx_pcm(&pcm);
                acc.extend_from_slice(&pcm);
                while acc.len() >= FRAME_SAMPLES {
                    let frame: Vec<i16> = acc.drain(..FRAME_SAMPLES).collect();
                    bcast.audio(slot, &frame);
                }
            }
            debug!("speaker drain ended for {drain_id}");
        });

        // Engine events: log diagnostics; decode the Opus fallback if the peer
        // is outside the MLow rollout.
        let ev_handle = handle.clone();
        let fallback = spawn_fallback_opus_decoder(spk_tx);
        let ev_id = call_id.clone();
        tokio::spawn(async move {
            let events = ev_handle.events();
            while let Ok(ev) = events.recv().await {
                if !matches!(ev, CallEvent::ForeignAudio(_)) {
                    WIRE.line(&format!("event {ev:?}"));
                }
                match ev {
                    CallEvent::RelayAllocated => info!("{ev_id}: relay allocated, media path live"),
                    CallEvent::RelayAllocateFailed(code) => warn!("{ev_id}: relay rejected allocate ({code})"),
                    CallEvent::RelayAllocateTimedOut => warn!("{ev_id}: relay allocate timed out"),
                    CallEvent::MediaSetupFailed(m) => warn!("{ev_id}: media setup failed: {m}"),
                    CallEvent::ForeignAudio(payload) => {
                        if let Some(tx) = &fallback {
                            let _ = tx.try_send(payload);
                        }
                    }
                    CallEvent::AudioFormatMismatch { expected_rate, received_rates } => {
                        error!("{ev_id}: audio format mismatch (expected {expected_rate}, got {received_rates:?})")
                    }
                    CallEvent::AudioSilent { .. } => warn!("{ev_id}: inbound audio arriving but decoding to silence"),
                    CallEvent::AudioReceptionStalled { silent_for_ms } => {
                        warn!("{ev_id}: no inbound audio for {silent_for_ms:?}")
                    }
                    CallEvent::AudioCodecSwitched { .. } => info!("{ev_id}: audio codec switched"),
                    CallEvent::Closed(reason) => info!("{ev_id}: media closed ({reason:?})"),
                    _ => {}
                }
            }
        });

        // End of call, whichever side ended it.
        let me = self.clone();
        tokio::spawn(async move {
            handle.wait_ended().await;
            drop(mic_tx);
            let stats = handle.media_stats();
            info!("{call_id}: media stats {stats:?}");
            WIRE.line(&format!("media_stats {stats:?}"));
            WIRE.close(&call_id);
            me.end_slot(slot, Some("ended".into()));
            info!("{call_id}: ended");
        });
    }
}

fn spawn_fallback_opus_decoder(speaker: async_channel::Sender<Vec<i16>>) -> Option<async_channel::Sender<Bytes>> {
    let mut decoder = match WaOpusDecoder::new() {
        Ok(d) => d,
        Err(e) => {
            error!("no fallback Opus decoder: {e}");
            return None;
        }
    };
    let (tx, rx) = async_channel::bounded::<Bytes>(8);
    tokio::task::spawn_blocking(move || {
        while let Ok(payload) = rx.recv_blocking() {
            match decoder.decode_mlow_escape(&payload) {
                Ok(pcm) => {
                    let _ = speaker.try_send(pcm.to_vec());
                }
                Err(e) => debug!("opus fallback decode failed: {e}"),
            }
        }
    });
    Some(tx)
}

pub fn parse_jid(to: &str) -> anyhow::Result<Jid> {
    let t = to.trim().trim_start_matches('+');
    if t.contains('@') {
        return t.parse::<Jid>().map_err(|e| anyhow::anyhow!("{e}"));
    }
    if t.is_empty() || !t.chars().all(|c| c.is_ascii_digit()) {
        anyhow::bail!("expected digits or a JID");
    }
    format!("{t}@s.whatsapp.net").parse::<Jid>().map_err(|e| anyhow::anyhow!("{e}"))
}

fn qr_svg_data_url(code: &str) -> String {
    use base64::Engine;
    use qrcode::render::svg;
    let svg = match qrcode::QrCode::new(code.as_bytes()) {
        Ok(qr) => qr
            .render::<svg::Color>()
            .min_dimensions(300, 300)
            .dark_color(svg::Color("#000000"))
            .light_color(svg::Color("#ffffff"))
            .build(),
        Err(e) => {
            warn!("QR render failed: {e}");
            return String::new();
        }
    };
    format!("data:image/svg+xml;base64,{}", base64::engine::general_purpose::STANDARD.encode(svg))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rms(f: &[i16]) -> f32 {
        (f.iter().map(|&s| (s as f32) * (s as f32)).sum::<f32>() / f.len() as f32).sqrt()
    }

    #[test]
    fn idle_frames_are_room_noise_not_silence() {
        let mut n = IdleNoise::with_level_db(-60.0);
        let _ = n.frame(); // let the low-pass settle
        for _ in 0..20 {
            let f = n.frame();
            assert_eq!(f.len(), FRAME_SAMPLES);
            assert!(f.iter().any(|&s| s != 0), "an all-zero frame reads as mic-mute (DTX) to the engine");
            let db = 20.0 * (rms(&f) / 32767.0).log10();
            assert!((-66.0..=-54.0).contains(&db), "idle level {db:.1} dBFS, wanted about -60");
            assert!(f.iter().all(|&s| s.abs() < 400), "comfort noise must stay far below speech");
        }
    }

    #[test]
    fn preroll_is_whole_frames_at_the_asked_level_with_quiet_edges() {
        let l = Levers { dtx: false, preroll: Preroll::Tone, preroll_frames: 5, preroll_db: -30.0 };
        let frames = l.preroll_frames();
        assert_eq!(frames.len(), 5);
        assert!(frames.iter().all(|f| f.len() == FRAME_SAMPLES));
        let mid = &frames[2];
        let db = 20.0 * (rms(mid) / 32767.0).log10();
        assert!((-31.0..=-29.0).contains(&db), "tone level {db:.1} dBFS, wanted -30");
        assert!(frames[0][0].abs() < 50 && frames[4][FRAME_SAMPLES - 1].abs() < 50, "faded edges");
        let n = Levers { dtx: false, preroll: Preroll::Noise, preroll_frames: 2, preroll_db: -35.0 };
        let nf = n.preroll_frames();
        assert_eq!(nf.len(), 2);
        assert!(nf[1].iter().any(|&s| s != 0));
        assert!(Levers { dtx: true, preroll: Preroll::Off, preroll_frames: 0, preroll_db: -30.0 }.preroll_frames().is_empty());
    }

    #[test]
    fn dither_only_mode_stays_within_one_lsb() {
        let mut n = IdleNoise::with_level_db(DITHER_ONLY);
        for _ in 0..50 {
            let f = n.frame();
            assert!(f.iter().any(|&s| s != 0));
            assert!(f.iter().all(|&s| (-1..=1).contains(&s)));
        }
    }

    #[test]
    fn real_audio_is_never_touched_and_zero_frames_are_filled() {
        let mut n = IdleNoise::with_level_db(-60.0);
        let mut speech: Vec<i16> = (0..FRAME_SAMPLES as i16).map(|i| (i % 200) - 100).collect();
        let before = speech.clone();
        n.apply(&mut speech);
        assert_eq!(speech, before);

        let mut zeros = vec![0i16; FRAME_SAMPLES];
        n.apply(&mut zeros);
        assert!(zeros.iter().any(|&s| s != 0));

        let mut quiet = vec![0i16; FRAME_SAMPLES];
        quiet[500] = 1;
        let before = quiet.clone();
        n.apply(&mut quiet);
        assert_eq!(quiet, before, "a frame with any signal is not touched");
    }
}
