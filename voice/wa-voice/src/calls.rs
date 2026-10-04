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
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
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
/// Speech frames dropped by the overflow guard, for the wire log's running total.
static QUEUE_DROPS: AtomicUsize = AtomicUsize::new(0);

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
///   sits between the wire and the phone's speaker; noise is the production shape);
/// - `WA_VOICE_SWEEP=<spec>,<spec>,…`: instead of one lever set per call, the
///   mic clock rotates through these, one per talkspurt (advancing when an
///   utterance ends, so an entry governs the idle gap before its onset too), and
///   tags every `onset`/`preroll start` wire-log line with the entry in force.
///   With the room capture (`wire.rs`) that turns ONE call into a full A/B.
///   Spec atoms joined by `+`: `base` (the call's env levers), `dtx`,
///   `floor:<dBFS>`, `tone:<ms>[@<dBFS>]`, `noise:<ms>[@<dBFS>]`.
#[derive(Clone, Debug, PartialEq)]
pub enum Preroll {
    Off,
    Tone,
    Noise,
    /// A rendered clip (16 kHz mono s16 wav) played before the utterance — a
    /// breath in the clone's voice: at speech level, so the phone's receive chain
    /// has adapted before the first word arrives (the 3 Oct sweep: every first
    /// word after a 300 ms burst played whole, every one from idle lost its
    /// tail), and natural, so the listener does not register it. `name`
    /// resolves under `~/.config/console/voice-clips/<name>.wav`; an absolute
    /// path is used as is. `db` rescales the clip to that RMS, else as rendered.
    Clip { name: String, db: Option<f32> },
}

#[derive(Clone, Debug, PartialEq)]
pub struct Levers {
    pub dtx: bool,
    /// Idle comfort-noise floor in dBFS (ignored when `dtx`: idle frames are zeros).
    pub idle_db: f32,
    pub preroll: Preroll,
    pub preroll_frames: usize,
    pub preroll_db: f32,
}

impl Levers {
    pub fn from_env() -> Self {
        let flag = |k: &str| std::env::var(k).map(|v| !matches!(v.trim(), "" | "0" | "off" | "false" | "no")).unwrap_or(false);
        let ms: usize = std::env::var("WA_VOICE_ONSET_PREROLL_MS").ok().and_then(|v| v.trim().parse().ok()).unwrap_or(0);
        let kind = match std::env::var("WA_VOICE_ONSET_PREROLL").map(|v| v.trim().to_string()) {
            Ok(v) if v.eq_ignore_ascii_case("tone") => Preroll::Tone,
            Ok(v) if v.eq_ignore_ascii_case("noise") => Preroll::Noise,
            Ok(v) if v.to_ascii_lowercase().starts_with("clip:") => match parse_clip_spec(&v[5..]) {
                Ok(p) => p,
                Err(e) => {
                    warn!("WA_VOICE_ONSET_PREROLL={v}: {e}; pre-roll off");
                    Preroll::Off
                }
            },
            _ => Preroll::Off,
        };
        let preroll = match kind {
            Preroll::Clip { .. } => kind,
            _ if ms == 0 => Preroll::Off,
            _ => kind,
        };
        let preroll_frames = match &preroll {
            Preroll::Off => 0,
            Preroll::Clip { name, db } => clip_frames(name, *db).map(|f| f.len()).unwrap_or(0),
            _ => ms.div_ceil(60),
        };
        Self {
            dtx: flag("WA_VOICE_DTX"),
            idle_db: IdleNoise::configured_level_db(),
            preroll,
            preroll_frames,
            preroll_db: std::env::var("WA_VOICE_ONSET_PREROLL_DB")
                .ok()
                .and_then(|v| v.trim().parse().ok())
                .unwrap_or(-30.0f32)
                .clamp(-60.0, -10.0),
        }
    }

    /// The sweep schedule from `WA_VOICE_SWEEP`, or just `base` when unset. A
    /// malformed entry disables the whole sweep (logged by the caller) rather
    /// than silently running a different experiment from the one asked for.
    pub fn sweep_from_env(base: &Levers) -> Result<Vec<Levers>, String> {
        let Some(spec) = std::env::var("WA_VOICE_SWEEP").ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) else {
            return Ok(vec![base.clone()]);
        };
        spec.split(',').map(|e| Levers::parse(e, base)).collect()
    }

    /// One sweep entry. `base` supplies whatever the spec does not name.
    pub fn parse(spec: &str, base: &Levers) -> Result<Levers, String> {
        let mut l = base.clone();
        for atom in spec.split('+').map(str::trim).filter(|a| !a.is_empty()) {
            let (key, arg) = atom.split_once(':').map(|(k, a)| (k.trim(), Some(a.trim()))).unwrap_or((atom, None));
            match (key.to_ascii_lowercase().as_str(), arg) {
                ("base", None) => {}
                ("dtx", None) => l.dtx = true,
                ("floor", Some(db)) => {
                    l.dtx = false;
                    l.idle_db = db.parse::<f32>().map_err(|_| format!("{atom}: floor wants dBFS"))?.clamp(-100.0, -30.0);
                }
                ("tone" | "noise", Some(a)) => {
                    let (ms, db) = a.split_once('@').unwrap_or((a, ""));
                    let ms: usize = ms.trim().parse().map_err(|_| format!("{atom}: wants <ms>[@<dBFS>]"))?;
                    if !db.trim().is_empty() {
                        l.preroll_db = db.trim().parse::<f32>().map_err(|_| format!("{atom}: bad dBFS"))?.clamp(-60.0, -10.0);
                    }
                    l.preroll = if ms == 0 {
                        Preroll::Off
                    } else if key.eq_ignore_ascii_case("tone") {
                        Preroll::Tone
                    } else {
                        Preroll::Noise
                    };
                    l.preroll_frames = if l.preroll == Preroll::Off { 0 } else { ms.div_ceil(60) };
                }
                ("clip", Some(a)) => {
                    let p = parse_clip_spec(a).map_err(|e| format!("{atom}: {e}"))?;
                    let Preroll::Clip { name, db } = &p else { unreachable!() };
                    l.preroll_frames = clip_frames(name, *db).map_err(|e| format!("{atom}: {e}"))?.len();
                    l.preroll = p;
                }
                _ => return Err(format!(
                    "{atom}: unknown lever (base, dtx, floor:<dB>, tone:<ms>[@<dB>], noise:<ms>[@<dB>], clip:<name>[@<dB>])"
                )),
            }
        }
        Ok(l)
    }

    /// Canonical label for the wire log, e.g. `floor:-60`, `dtx+tone:300@-30`.
    pub fn label(&self) -> String {
        let mut parts = vec![if self.dtx {
            "dtx".to_string()
        } else if self.idle_db < -100.0 {
            "floor:off".to_string()
        } else {
            format!("floor:{:.0}", self.idle_db)
        }];
        match &self.preroll {
            Preroll::Off => {}
            Preroll::Tone => parts.push(format!("tone:{}@{:.0}", self.preroll_frames * 60, self.preroll_db)),
            Preroll::Noise => parts.push(format!("noise:{}@{:.0}", self.preroll_frames * 60, self.preroll_db)),
            Preroll::Clip { name, db } => parts.push(match db {
                Some(db) => format!("clip:{name}@{db:.0}"),
                None => format!("clip:{name}"),
            }),
        }
        parts.join("+")
    }

    /// The whole pre-roll as frames: a 440 Hz tone or low-passed noise at
    /// `preroll_db`, or the clip, with a 20 ms raised-cosine fade at both ends.
    pub fn preroll_frames(&self) -> VecDeque<Vec<i16>> {
        if let Preroll::Clip { name, db } = &self.preroll {
            return clip_frames(name, *db).unwrap_or_else(|e| {
                warn!("pre-roll clip {name}: {e}; no pre-roll this talkspurt");
                VecDeque::new()
            });
        }
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
                Preroll::Off | Preroll::Clip { .. } => 0.0,
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

/// `<name>[@<dBFS>]` → `Preroll::Clip`.
fn parse_clip_spec(a: &str) -> Result<Preroll, String> {
    let (name, db) = a.split_once('@').unwrap_or((a, ""));
    let name = name.trim();
    if name.is_empty() {
        return Err("clip wants <name>[@<dBFS>]".into());
    }
    let db = if db.trim().is_empty() {
        None
    } else {
        Some(db.trim().parse::<f32>().map_err(|_| format!("{a}: bad dBFS"))?.clamp(-60.0, -10.0))
    };
    Ok(Preroll::Clip { name: name.to_string(), db })
}

fn clip_path(name: &str) -> PathBuf {
    let p = PathBuf::from(name);
    if p.is_absolute() {
        return p;
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    PathBuf::from(home).join(".config").join("console").join("voice-clips").join(format!("{name}.wav"))
}

/// Read a 16 kHz mono 16-bit wav into samples (RIFF chunk walk; no crate).
fn read_wav_16k_mono(path: &std::path::Path) -> Result<Vec<i16>, String> {
    let b = std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
    if b.len() < 12 || &b[0..4] != b"RIFF" || &b[8..12] != b"WAVE" {
        return Err(format!("{}: not a RIFF/WAVE file", path.display()));
    }
    let (mut pos, mut fmt_ok, mut data) = (12usize, false, None::<&[u8]>);
    while pos + 8 <= b.len() {
        let id = &b[pos..pos + 4];
        let len = u32::from_le_bytes([b[pos + 4], b[pos + 5], b[pos + 6], b[pos + 7]]) as usize;
        let body = &b[pos + 8..(pos + 8 + len).min(b.len())];
        if id == b"fmt " && body.len() >= 16 {
            let ch = u16::from_le_bytes([body[2], body[3]]);
            let rate = u32::from_le_bytes([body[4], body[5], body[6], body[7]]);
            let bits = u16::from_le_bytes([body[14], body[15]]);
            if ch != 1 || rate != 16_000 || bits != 16 {
                return Err(format!("{}: want 16 kHz mono 16-bit, got {rate} Hz {ch} ch {bits}-bit", path.display()));
            }
            fmt_ok = true;
        } else if id == b"data" {
            data = Some(body);
        }
        pos += 8 + len + (len & 1);
    }
    match (fmt_ok, data) {
        (true, Some(d)) => Ok(d.chunks_exact(2).map(|c| i16::from_le_bytes([c[0], c[1]])).collect()),
        _ => Err(format!("{}: missing fmt/data chunk", path.display())),
    }
}

/// The clip as whole 60 ms frames: optionally rescaled to `db` RMS, 20 ms
/// raised-cosine fades, the last frame zero-padded.
fn clip_frames(name: &str, db: Option<f32>) -> Result<VecDeque<Vec<i16>>, String> {
    let mut pcm: Vec<f32> = read_wav_16k_mono(&clip_path(name))?.iter().map(|&s| s as f32).collect();
    if pcm.is_empty() {
        return Err(format!("{name}: empty clip"));
    }
    if let Some(db) = db {
        let rms = (pcm.iter().map(|s| s * s).sum::<f32>() / pcm.len() as f32).sqrt();
        if rms > 0.0 {
            let g = 32767.0 * 10f32.powf(db / 20.0) / rms;
            pcm.iter_mut().for_each(|s| *s *= g);
        }
    }
    let n = pcm.len();
    let fade = 320usize.min(n / 2);
    for (i, v) in pcm.iter_mut().enumerate() {
        let env = if i < fade {
            0.5 - 0.5 * (std::f32::consts::PI * i as f32 / fade as f32).cos()
        } else if i >= n - fade {
            0.5 - 0.5 * (std::f32::consts::PI * (n - 1 - i) as f32 / fade as f32).cos()
        } else {
            1.0
        };
        *v *= env;
    }
    let mut out: Vec<i16> = pcm.iter().map(|v| v.round().clamp(-32767.0, 32767.0) as i16).collect();
    out.resize(n.div_ceil(FRAME_SAMPLES) * FRAME_SAMPLES, 0);
    Ok(out.chunks(FRAME_SAMPLES).map(|c| c.to_vec()).collect())
}

/// Append socket PCM to a slot's outbound queue as 960-sample frames, merging into a partial
/// frame left at the back by the previous push.
///
/// Only a PARTIAL back frame may be taken back off the queue. The first version did
/// `q.pop_back().filter(|f| f.len() < FRAME_SAMPLES)`, which pops the back frame and drops it when
/// it is complete. The pipeline sends whole 60 ms frames and bursts ~5 of them at the start of
/// every sentence to build its 0.3 s lead, so each push deleted the one before it: ~240 ms gone
/// from the start of every sentence on every call since the first, which is the "never heard the
/// one" first-word loss chased on the phone side for two weeks (^jade-gull, 4 Oct 2026). Any
/// lead-in made it worse, because speech queued behind it was deleted the same way.
pub fn enqueue_pcm(q: &mut VecDeque<Vec<i16>>, mut samples: Vec<i16>) {
    if q.back().is_some_and(|f| f.len() < FRAME_SAMPLES)
        && let Some(mut tail) = q.pop_back()
    {
        tail.append(&mut samples);
        samples = tail;
    }
    for chunk in samples.chunks(FRAME_SAMPLES) {
        q.push_back(chunk.to_vec());
    }
}

/// How long the source waits, with the queue empty, before it calls the
/// utterance over. Without it a pipeline that hands over its TTS a little
/// slower than real time looks like the end of a talkspurt, and the next
/// chunk would get a fresh pre-roll spliced into the middle of a sentence.
const HANGOVER_TICKS: usize = 8;

/// One tick's worth of transition, for the wire log.
#[derive(Debug, PartialEq)]
pub enum MicEvent {
    PrerollStart { q_depth: usize, frames: usize },
    Onset { q_depth: usize, first_frame_dbfs: f32 },
    Idle { spoken_frames: usize },
    PartialFrame { samples: usize },
}

#[derive(Debug, PartialEq)]
enum MicState {
    Idle,
    /// Pre-roll for THIS talkspurt, armed once on the idle→speech transition.
    ///
    /// It is armed here and nowhere else, which is the whole lesson of call
    /// 00357d4b (21 Sept, Mai heard 56 s of hiss and no words): the first
    /// version re-armed whenever the pre-roll had drained and the queue was
    /// still non-empty, so every fifth tick built another pre-roll and the
    /// queued speech was never sent at all.
    Preroll(VecDeque<Vec<i16>>),
    Speaking { spoken_frames: usize, empty_ticks: usize },
}

/// The 60 ms mic clock's frame source: queued speech when there is any, comfort
/// noise otherwise, and the configured pre-roll in front of each talkspurt.
///
/// `sweep` is the per-talkspurt schedule (one entry = the whole call, the
/// production shape). It advances on the Speaking → Idle transition, so an entry
/// governs the idle gap that precedes its onset as well as the onset itself —
/// what the phone's receive path has adapted to by the time the first word
/// arrives IS the experiment.
pub struct MicSource {
    levers: Levers,
    sweep: Vec<Levers>,
    cursor: usize,
    idle: IdleNoise,
    state: MicState,
}

impl MicSource {
    pub fn new(levers: Levers) -> Self {
        Self::with_sweep(vec![levers])
    }

    pub fn with_sweep(sweep: Vec<Levers>) -> Self {
        let levers = sweep.first().cloned().unwrap_or_else(Levers::from_env);
        let sweep = if sweep.is_empty() { vec![levers.clone()] } else { sweep };
        let idle = IdleNoise::with_level_db(levers.idle_db);
        Self { levers, sweep, cursor: 0, idle, state: MicState::Idle }
    }

    /// The entry in force, for the wire log (`lever=<label> #<i>/<n>`).
    pub fn lever_tag(&self) -> String {
        if self.sweep.len() > 1 {
            format!("lever={} #{}/{}", self.levers.label(), self.cursor + 1, self.sweep.len())
        } else {
            format!("lever={}", self.levers.label())
        }
    }

    fn advance_sweep(&mut self) {
        if self.sweep.len() < 2 {
            return;
        }
        self.cursor = (self.cursor + 1) % self.sweep.len();
        let next = self.sweep[self.cursor].clone();
        if next.idle_db != self.levers.idle_db {
            self.idle = IdleNoise::with_level_db(next.idle_db);
        }
        self.levers = next;
    }

    fn idle_frame(&mut self) -> Vec<i16> {
        if self.levers.dtx { vec![0i16; FRAME_SAMPLES] } else { self.idle.frame() }
    }

    fn take_speech(&mut self, q: &mut VecDeque<Vec<i16>>, events: &mut Vec<MicEvent>) -> Option<Vec<i16>> {
        match q.pop_front() {
            Some(f) if f.len() == FRAME_SAMPLES => Some(f),
            Some(mut f) => {
                events.push(MicEvent::PartialFrame { samples: f.len() });
                f.resize(FRAME_SAMPLES, 0);
                Some(f)
            }
            None => None,
        }
    }

    /// The frame to send on this tick, plus whatever transitions it made.
    pub fn next_frame(&mut self, q: &mut VecDeque<Vec<i16>>) -> (Vec<i16>, Vec<MicEvent>) {
        let mut events = Vec::new();
        let depth = q.len();
        if self.state == MicState::Idle && depth > 0 && self.levers.preroll_frames > 0 {
            let frames = self.levers.preroll_frames();
            events.push(MicEvent::PrerollStart { q_depth: depth, frames: frames.len() });
            self.state = MicState::Preroll(frames);
        }
        if let MicState::Preroll(frames) = &mut self.state {
            if let Some(f) = frames.pop_front() {
                if frames.is_empty() {
                    self.state = MicState::Speaking { spoken_frames: 0, empty_ticks: 0 };
                }
                return (f, events);
            }
            self.state = MicState::Speaking { spoken_frames: 0, empty_ticks: 0 };
        }
        if let Some(mut f) = self.take_speech(q, &mut events) {
            match &mut self.state {
                MicState::Speaking { spoken_frames, empty_ticks } => {
                    *spoken_frames += 1;
                    *empty_ticks = 0;
                }
                _ => {
                    let rms = (f.iter().map(|&s| (s as f32) * (s as f32)).sum::<f32>() / f.len() as f32).sqrt();
                    events.push(MicEvent::Onset {
                        q_depth: depth,
                        first_frame_dbfs: if rms > 0.0 { 20.0 * (rms / 32767.0).log10() } else { -120.0 },
                    });
                    self.state = MicState::Speaking { spoken_frames: 1, empty_ticks: 0 };
                }
            }
            if !self.levers.dtx {
                self.idle.apply(&mut f);
            }
            return (f, events);
        }
        if let MicState::Speaking { spoken_frames, empty_ticks } = &mut self.state {
            *empty_ticks += 1;
            if *empty_ticks >= HANGOVER_TICKS {
                events.push(MicEvent::Idle { spoken_frames: *spoken_frames });
                self.state = MicState::Idle;
                self.advance_sweep();
            }
        }
        (self.idle_frame(), events)
    }
}

/// What `loopback` reports: the mic clock + MLow encoder run over a clip
/// with the live levers, no call, no network.
#[derive(Debug, Clone, PartialEq)]
pub struct LoopbackReport {
    pub frames: usize,
    pub speech_frames: usize,
    /// Ticks whose frame the encoder turned into at least one byte.
    pub encoded_frames: usize,
    pub encoded_bytes: usize,
    pub mean_speech_packet: f32,
    pub mean_idle_packet: f32,
    pub encode_ms_mean: f32,
    /// Nearest-rank 90th percentile of the per-frame encode time: what the
    /// encoder sustains. One pre-empted frame moves `encode_ms_max`, not this.
    pub encode_ms_p90: f32,
    pub encode_ms_max: f32,
    /// Tick index of the slowest encode — 0 means the fresh encoder's first
    /// frame (cold pages), anything else a stall mid-run.
    pub encode_ms_max_frame: usize,
    /// Frames whose encode took at least the 60 ms the frame itself lasts.
    pub encode_slow_frames: usize,
    pub input_dbfs: f32,
}

/// Nearest-rank percentile of `sorted` (ascending); 0 for an empty slice.
fn percentile(sorted: &[f32], pct: f32) -> f32 {
    if sorted.is_empty() {
        return 0.0;
    }
    let rank = ((pct / 100.0) * sorted.len() as f32).ceil() as usize;
    sorted[rank.clamp(1, sorted.len()) - 1]
}

/// The pre-call self-test behind `Command::Loopback`: queue `pcm` exactly as
/// the pipeline's frames are queued, tick `MicSource` until it has drained and
/// gone idle again, encode every tick's frame with a fresh `MlowEncoder`, and
/// describe the packets. Speech vs idle is judged on the INPUT frame's level
/// (idle comfort noise sits at -60 dBFS; anything above -50 dBFS is signal).
pub fn loopback(pcm: &[i16], levers: Levers) -> LoopbackReport {
    use whatsapp_rust::wacore::voip::mlow::MlowEncoder;

    let dbfs = |f: &[i16]| -> f32 {
        let rms = (f.iter().map(|&s| (s as f32) * (s as f32)).sum::<f32>() / f.len().max(1) as f32).sqrt();
        if rms > 0.0 { 20.0 * (rms / 32767.0).log10() } else { -120.0 }
    };
    let input_dbfs = dbfs(pcm);
    let mut q: VecDeque<Vec<i16>> = pcm.chunks(FRAME_SAMPLES).map(|c| c.to_vec()).collect();
    let input_frames = q.len();
    let preroll_frames = levers.preroll_frames;
    let mut source = MicSource::new(levers);
    let mut enc = MlowEncoder::new();
    let mut buf = Vec::new();
    let (mut frames, mut speech_frames, mut encoded_bytes, mut encoded_frames) = (0usize, 0usize, 0usize, 0usize);
    let (mut speech_bytes, mut idle_frames, mut idle_bytes) = (0usize, 0usize, 0usize);
    // Every input frame, then the pre-roll and the hangover, then a few idle ticks.
    let budget = input_frames + preroll_frames + HANGOVER_TICKS + 4;
    let mut encode_ms: Vec<f32> = Vec::with_capacity(budget);
    while frames < budget {
        let (frame, _events) = source.next_frame(&mut q);
        let t0 = Instant::now();
        buf.clear();
        if enc.encode_i16_into(&frame, &mut buf).is_err() {
            break;
        }
        encode_ms.push(t0.elapsed().as_secs_f32() * 1000.0);
        frames += 1;
        encoded_bytes += buf.len();
        if !buf.is_empty() {
            encoded_frames += 1;
        }
        if dbfs(&frame) > -50.0 {
            speech_frames += 1;
            speech_bytes += buf.len();
        } else {
            idle_frames += 1;
            idle_bytes += buf.len();
        }
    }
    let (encode_ms_max_frame, encode_ms_max) = encode_ms
        .iter()
        .copied()
        .enumerate()
        .fold((0usize, 0f32), |best, (i, ms)| if ms > best.1 { (i, ms) } else { best });
    let mut sorted = encode_ms.clone();
    sorted.sort_by(f32::total_cmp);
    LoopbackReport {
        frames,
        speech_frames,
        encoded_frames,
        encoded_bytes,
        mean_speech_packet: if speech_frames > 0 { speech_bytes as f32 / speech_frames as f32 } else { 0.0 },
        mean_idle_packet: if idle_frames > 0 { idle_bytes as f32 / idle_frames as f32 } else { 0.0 },
        encode_ms_mean: if encode_ms.is_empty() { 0.0 } else { encode_ms.iter().sum::<f32>() / encode_ms.len() as f32 },
        encode_ms_p90: percentile(&sorted, 90.0),
        encode_ms_max,
        encode_ms_max_frame,
        encode_slow_frames: encode_ms.iter().filter(|&&ms| ms >= 60.0).count(),
        input_dbfs,
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
        let (queue, call_id) = {
            let st = self.st();
            match st.slots.get(&slot) {
                Some(s) => (s.queue.clone(), s.call_id.clone()),
                None => return,
            }
        };
        let mut samples: Vec<i16> = pcm_le
            .chunks_exact(2)
            .map(|b| i16::from_le_bytes([b[0], b[1]]))
            .collect();
        let mut q = queue.lock().unwrap_or_else(|p| p.into_inner());
        enqueue_pcm(&mut q, samples);
        // Overflow is silence on the wire — the frames dropped here are speech
        // the peer will never hear — so it is logged rather than absorbed. Call
        // 00357d4b (21 Sept) discarded a whole call's audio through this branch
        // with nothing in any log to say so.
        let mut dropped = 0usize;
        while q.len() > MAX_QUEUE_FRAMES {
            q.pop_front();
            dropped += 1;
        }
        if dropped > 0 {
            let total = QUEUE_DROPS.fetch_add(dropped, Ordering::Relaxed) + dropped;
            if total == dropped || total % 100 < dropped {
                WIRE.line(&format!("queue overflow: {total} speech frames dropped (cap {MAX_QUEUE_FRAMES})"));
                warn!("outbound queue overflow: {total} speech frames dropped so far");
                self.bcast.event(&Event::Health {
                    call_id,
                    slot,
                    kind: "outbound-lost",
                    issue: format!("{total} frames of AL's speech were discarded before transmission — the caller is not hearing AL"),
                });
            }
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
            Command::Loopback { pcm, id } => {
                use base64::Engine;
                let bytes = match base64::engine::general_purpose::STANDARD.decode(pcm.trim()) {
                    Ok(b) if b.len() >= 2 => b,
                    Ok(_) => return self.err(None, id, "loopback: empty pcm"),
                    Err(e) => return self.err(None, id, format!("loopback: pcm is not base64: {e}")),
                };
                let samples: Vec<i16> = bytes.chunks_exact(2).map(|c| i16::from_le_bytes([c[0], c[1]])).collect();
                let levers = Levers::from_env();
                let bcast = self.bcast.clone();
                tokio::task::spawn_blocking(move || {
                    let r = loopback(&samples, levers);
                    info!(
                        "loopback: {} frames, {} speech ({:.0} B mean) / idle {:.0} B mean, encode mean {:.1} / p90 {:.1} / max {:.1} ms (frame {}, {} over 60 ms), input {:.1} dBFS",
                        r.frames, r.speech_frames, r.mean_speech_packet, r.mean_idle_packet, r.encode_ms_mean, r.encode_ms_p90,
                        r.encode_ms_max, r.encode_ms_max_frame, r.encode_slow_frames, r.input_dbfs
                    );
                    bcast.event(&Event::Loopback {
                        frames: r.frames,
                        speech_frames: r.speech_frames,
                        encoded_frames: r.encoded_frames,
                        encoded_bytes: r.encoded_bytes,
                        mean_speech_packet: r.mean_speech_packet,
                        mean_idle_packet: r.mean_idle_packet,
                        encode_ms_mean: r.encode_ms_mean,
                        encode_ms_p90: r.encode_ms_p90,
                        encode_ms_max: r.encode_ms_max,
                        encode_ms_max_frame: r.encode_ms_max_frame,
                        encode_slow_frames: r.encode_slow_frames,
                        input_dbfs: r.input_dbfs,
                        id,
                    });
                });
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
            let levers = Levers::from_env();
            info!(
                "idle comfort noise at {} dBFS; levers {levers:?}",
                if levers.dtx { "DTX (zeros)".to_string() } else { levers.idle_db.to_string() }
            );
            let sweep = match Levers::sweep_from_env(&levers) {
                Ok(s) => s,
                Err(e) => {
                    warn!("WA_VOICE_SWEEP ignored ({e}); running the env levers for the whole call");
                    WIRE.line(&format!("sweep ignored: {e}"));
                    vec![levers.clone()]
                }
            };
            WIRE.line(&format!(
                "levers {levers:?} sweep=[{}]",
                sweep.iter().map(Levers::label).collect::<Vec<_>>().join(",")
            ));
            let mut source = MicSource::with_sweep(sweep);
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
                let (frame, events) = {
                    let mut q = ticker_queue.lock().unwrap_or_else(|p| p.into_inner());
                    source.next_frame(&mut q)
                };
                for ev in events {
                    match ev {
                        MicEvent::PrerollStart { q_depth, frames } => {
                            WIRE.line(&format!("preroll start {} q_depth={q_depth} frames={frames}", source.lever_tag()))
                        }
                        MicEvent::Onset { q_depth, first_frame_dbfs } => WIRE.line(&format!(
                            "onset {} q_depth={q_depth} first_frame_dbfs={first_frame_dbfs:.1}",
                            source.lever_tag()
                        )),
                        MicEvent::Idle { spoken_frames } => {
                            WIRE.line(&format!("idle after {spoken_frames} speech frames; next {}", source.lever_tag()))
                        }
                        MicEvent::PartialFrame { samples } => {
                            WIRE.line(&format!("partial frame {samples} samples padded"))
                        }
                    }
                }
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
        let ev_bcast = self.bcast.clone();
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
                    CallEvent::AudioSilent { .. } => {
                        warn!("{ev_id}: inbound audio arriving but decoding to silence");
                        ev_bcast.event(&Event::Health {
                            call_id: ev_id.clone(),
                            slot,
                            kind: "inbound-silent",
                            issue: "the caller's audio is arriving but decodes to silence — AL cannot hear them".into(),
                        });
                    }
                    CallEvent::AudioReceptionStalled { silent_for_ms } => {
                        warn!("{ev_id}: no inbound audio for {silent_for_ms:?}");
                        ev_bcast.event(&Event::Health {
                            call_id: ev_id.clone(),
                            slot,
                            kind: "inbound-stalled",
                            issue: format!("no audio has arrived from the caller for {silent_for_ms:?}"),
                        });
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
        let l = Levers { dtx: false, idle_db: -60.0, preroll: Preroll::Tone, preroll_frames: 5, preroll_db: -30.0 };
        let frames = l.preroll_frames();
        assert_eq!(frames.len(), 5);
        assert!(frames.iter().all(|f| f.len() == FRAME_SAMPLES));
        let mid = &frames[2];
        let db = 20.0 * (rms(mid) / 32767.0).log10();
        assert!((-31.0..=-29.0).contains(&db), "tone level {db:.1} dBFS, wanted -30");
        assert!(frames[0][0].abs() < 50 && frames[4][FRAME_SAMPLES - 1].abs() < 50, "faded edges");
        let n = Levers { dtx: false, idle_db: -60.0, preroll: Preroll::Noise, preroll_frames: 2, preroll_db: -35.0 };
        let nf = n.preroll_frames();
        assert_eq!(nf.len(), 2);
        assert!(nf[1].iter().any(|&s| s != 0));
        assert!(Levers { dtx: true, idle_db: -60.0, preroll: Preroll::Off, preroll_frames: 0, preroll_db: -30.0 }.preroll_frames().is_empty());
    }

    /// Marked frames, so a test can tell queued speech from generated noise.
    fn speech(n: usize) -> VecDeque<Vec<i16>> {
        (0..n).map(|i| vec![1000 + i as i16; FRAME_SAMPLES]).collect()
    }

    fn levers(preroll_frames: usize) -> Levers {
        Levers {
            dtx: false,
            idle_db: -60.0,
            preroll: if preroll_frames == 0 { Preroll::Off } else { Preroll::Noise },
            preroll_frames,
            preroll_db: -30.0,
        }
    }

    /// The pipeline bursts whole frames at the start of a sentence (its 0.3 s lead); none of them
    /// may be lost, and the mic clock must hand every sample to the encoder exactly once, in order.
    /// This is the 4 Oct 2026 first-word loss: the old re-chunk dropped every complete back frame.
    #[test]
    fn a_burst_of_whole_frames_is_queued_without_loss() {
        let mut q: VecDeque<Vec<i16>> = VecDeque::new();
        for k in 0..5i16 {
            enqueue_pcm(&mut q, vec![1000 + k; FRAME_SAMPLES]);
        }
        assert_eq!(q.len(), 5, "five whole frames pushed back to back are five queued frames");
        assert_eq!(q.iter().map(|f| f[0]).collect::<Vec<_>>(), vec![1000, 1001, 1002, 1003, 1004]);
    }

    #[test]
    fn partial_pushes_are_merged_in_order() {
        let mut q: VecDeque<Vec<i16>> = VecDeque::new();
        let all: Vec<i16> = (0..(FRAME_SAMPLES as i16 * 3)).map(|i| i % 30000).collect();
        // Odd-sized pushes that straddle frame boundaries.
        let mut at = 0usize;
        for n in [500usize, 700, 960, 100, 620] {
            enqueue_pcm(&mut q, all[at..at + n].to_vec());
            at += n;
        }
        let flat: Vec<i16> = q.iter().flatten().copied().collect();
        assert_eq!(flat, all[..at].to_vec(), "every sample once, in order");
        assert!(q.iter().rev().skip(1).all(|f| f.len() == FRAME_SAMPLES), "only the back frame may be partial");
    }

    /// End to end through the mic clock, with and without a pre-roll: the pipeline's burst-then-pace
    /// pattern goes in, every speech sample must come out of `next_frame`, in order.
    #[test]
    fn burst_then_paced_speech_reaches_the_clock_intact() {
        for preroll in [0usize, 6] {
            let mut src = MicSource::new(levers(preroll));
            let mut q: VecDeque<Vec<i16>> = VecDeque::new();
            let utterance: Vec<Vec<i16>> = (0..20i16).map(|k| vec![1000 + k; FRAME_SAMPLES]).collect();
            let mut sent = Vec::new();
            // Burst: five frames before the first tick, then one push per tick.
            for f in &utterance[..5] {
                enqueue_pcm(&mut q, f.clone());
            }
            let mut next = 5;
            for _ in 0..60 {
                let (f, _) = src.next_frame(&mut q);
                if is_speech(&f) {
                    sent.push(f[0]);
                }
                if next < utterance.len() {
                    enqueue_pcm(&mut q, utterance[next].clone());
                    next += 1;
                }
            }
            assert_eq!(
                sent,
                (0..20).map(|k| 1000 + k as i16).collect::<Vec<_>>(),
                "pre-roll {preroll}: every frame of the utterance reaches the encoder, in order"
            );
        }
    }

    #[test]
    fn sweep_specs_parse_and_label_round_trip() {
        let base = levers(0);
        assert_eq!(Levers::parse("base", &base).unwrap(), base);
        let dtx = Levers::parse("dtx", &base).unwrap();
        assert!(dtx.dtx && dtx.preroll == Preroll::Off);
        assert_eq!(dtx.label(), "dtx");
        let floor = Levers::parse("floor:-45", &base).unwrap();
        assert!(!floor.dtx && floor.idle_db == -45.0);
        assert_eq!(floor.label(), "floor:-45");
        let tone = Levers::parse("tone:300", &base).unwrap();
        assert_eq!((tone.preroll.clone(), tone.preroll_frames, tone.preroll_db), (Preroll::Tone, 5, -30.0));
        assert_eq!(tone.label(), "floor:-60+tone:300@-30");
        let both = Levers::parse("dtx+noise:120@-40", &base).unwrap();
        assert!(both.dtx && both.preroll == Preroll::Noise && both.preroll_frames == 2 && both.preroll_db == -40.0);
        assert_eq!(both.label(), "dtx+noise:120@-40");
        assert!(Levers::parse("gate:3", &base).is_err());
        assert!(Levers::parse("floor:loud", &base).is_err());
        assert!(Levers::parse("tone:x", &base).is_err());
        // `floor` after `dtx` wins (and vice versa): the idle shape is one thing.
        assert!(!Levers::parse("dtx+floor:-50", &base).unwrap().dtx);
        assert!(Levers::parse("clip:does-not-exist", &base).is_err(), "a missing clip is a spec error, not a silent no-op");
    }

    /// A clip pre-roll comes out as whole frames at the asked level with faded
    /// edges, and the sweep spec resolves its length from the file.
    #[test]
    fn clip_preroll_is_whole_frames_at_the_asked_level() {
        let dir = std::env::temp_dir().join(format!("wa-voice-clip-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("breath.wav");
        // 250 ms of a 1 kHz tone at about -20 dBFS, 16 kHz mono 16-bit.
        let n = 4000usize;
        let pcm: Vec<i16> = (0..n).map(|i| (3277.0 * 1.414 * (2.0 * std::f32::consts::PI * 1000.0 * i as f32 / 16000.0).sin()) as i16).collect();
        let mut w = Vec::new();
        w.extend_from_slice(b"RIFF");
        w.extend_from_slice(&(36 + 2 * n as u32).to_le_bytes());
        w.extend_from_slice(b"WAVEfmt ");
        w.extend_from_slice(&16u32.to_le_bytes());
        w.extend_from_slice(&1u16.to_le_bytes());
        w.extend_from_slice(&1u16.to_le_bytes());
        w.extend_from_slice(&16000u32.to_le_bytes());
        w.extend_from_slice(&32000u32.to_le_bytes());
        w.extend_from_slice(&2u16.to_le_bytes());
        w.extend_from_slice(&16u16.to_le_bytes());
        w.extend_from_slice(b"data");
        w.extend_from_slice(&(2 * n as u32).to_le_bytes());
        for s in &pcm {
            w.extend_from_slice(&s.to_le_bytes());
        }
        std::fs::write(&path, w).unwrap();
        let spec = format!("clip:{}@-30", path.display());
        let l = Levers::parse(&spec, &levers(0)).unwrap();
        assert_eq!(l.preroll_frames, 5, "4000 samples → 5 frames (last one padded)");
        assert_eq!(l.label(), format!("floor:-60+clip:{}@-30", path.display()));
        let frames = l.preroll_frames();
        assert_eq!(frames.len(), 5);
        assert!(frames.iter().all(|f| f.len() == FRAME_SAMPLES));
        let db = 20.0 * (rms(&frames[2]) / 32767.0).log10();
        assert!((-31.0..=-29.0).contains(&db), "clip level {db:.1} dBFS, wanted -30");
        assert!(frames[0][0].abs() < 50, "faded in");
        assert!(frames[4][FRAME_SAMPLES - 1] == 0, "padded tail");
        // As rendered (no @dB): the original -20 dBFS level survives.
        let raw = Levers::parse(&format!("clip:{}", path.display()), &levers(0)).unwrap().preroll_frames();
        let db = 20.0 * (rms(&raw[2]) / 32767.0).log10();
        assert!((-21.0..=-19.0).contains(&db), "as rendered {db:.1}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The schedule advances at the END of each talkspurt, so entry k governs the
    /// idle gap before onset k as well as the onset itself; a single entry never
    /// advances (the production shape is untouched by the sweep machinery).
    #[test]
    fn sweep_rotates_per_talkspurt_and_governs_the_gap_before_each_onset() {
        let a = levers(0);
        let b = Levers::parse("dtx", &a).unwrap();
        let c = Levers::parse("tone:300", &a).unwrap();
        let mut src = MicSource::with_sweep(vec![a, b, c]);
        assert_eq!(src.lever_tag(), "lever=floor:-60 #1/3");
        let mut q: VecDeque<Vec<i16>> = VecDeque::new();
        let (idle, _) = src.next_frame(&mut q);
        assert!(idle.iter().any(|&s| s != 0), "entry 1: comfort noise idle");
        // Utterance 1 under `a`, then the hangover → Idle → entry 2 (dtx) governs the next gap.
        q.extend(speech(2));
        for _ in 0..(2 + HANGOVER_TICKS) {
            src.next_frame(&mut q);
        }
        assert_eq!(src.lever_tag(), "lever=dtx #2/3");
        let (idle, evs) = src.next_frame(&mut q);
        assert!(evs.is_empty());
        assert!(idle.iter().all(|&s| s == 0), "entry 2: exact zeros → the engine sends SID");
        // Utterance 2 goes straight out (no pre-roll under dtx), then entry 3 arms a tone pre-roll.
        q.extend(speech(1));
        let (f, evs) = src.next_frame(&mut q);
        assert!(is_speech(&f) && evs.iter().any(|e| matches!(e, MicEvent::Onset { .. })));
        for _ in 0..HANGOVER_TICKS {
            src.next_frame(&mut q);
        }
        assert_eq!(src.lever_tag(), "lever=floor:-60+tone:300@-30 #3/3");
        q.extend(speech(1));
        let (f, evs) = src.next_frame(&mut q);
        assert!(!is_speech(&f) && evs.iter().any(|e| matches!(e, MicEvent::PrerollStart { frames: 5, .. })));
        for _ in 0..(5 + HANGOVER_TICKS) {
            src.next_frame(&mut q);
        }
        assert_eq!(src.lever_tag(), "lever=floor:-60 #1/3", "wraps around");
        let mut single = MicSource::new(levers(0));
        single.next_frame(&mut q);
        assert_eq!(single.lever_tag(), "lever=floor:-60");
    }

    fn is_speech(f: &[i16]) -> bool {
        f[0] >= 1000
    }

    /// Call 00357d4b, 21 Sept: Mai heard 56 s of hiss and not one word, because
    /// the pre-roll re-armed every time it drained while the queue still held
    /// speech. Every queued frame must reach the wire, exactly once, in order.
    #[test]
    fn preroll_runs_once_and_never_starves_the_queue() {
        let mut src = MicSource::new(levers(5));
        let mut q = speech(20);
        let mut pre = 0;
        let mut sent: Vec<i16> = Vec::new();
        let mut prerolls_armed = 0;
        for _ in 0..40 {
            let (f, evs) = src.next_frame(&mut q);
            prerolls_armed += evs.iter().filter(|e| matches!(e, MicEvent::PrerollStart { .. })).count();
            if is_speech(&f) {
                sent.push(f[0]);
            } else if sent.is_empty() {
                pre += 1;
            }
        }
        assert_eq!(prerolls_armed, 1, "the pre-roll must be armed once per talkspurt, not per drain");
        assert_eq!(pre, 5, "300 ms of pre-roll, then speech");
        assert_eq!(sent, (0..20).map(|i| 1000 + i as i16).collect::<Vec<_>>(), "every queued frame, in order");
        assert!(q.is_empty());
    }

    #[test]
    fn with_no_preroll_the_first_queued_frame_goes_out_immediately() {
        let mut src = MicSource::new(levers(0));
        let mut q = speech(3);
        let (f, evs) = src.next_frame(&mut q);
        assert!(is_speech(&f));
        assert!(evs.iter().any(|e| matches!(e, MicEvent::Onset { .. })));
    }

    /// A gap shorter than the hangover is the pipeline lagging mid-sentence, not
    /// a new utterance: splicing pre-roll noise in there would be audible.
    #[test]
    fn a_short_gap_does_not_splice_preroll_into_a_sentence() {
        let mut src = MicSource::new(levers(5));
        let mut q = speech(2);
        for _ in 0..7 {
            src.next_frame(&mut q);
        }
        assert!(q.is_empty());
        let mut armed = 0;
        for _ in 0..(HANGOVER_TICKS - 1) {
            let (_, evs) = src.next_frame(&mut q);
            armed += evs.iter().filter(|e| matches!(e, MicEvent::PrerollStart { .. })).count();
        }
        q.extend(speech(2));
        let (f, evs) = src.next_frame(&mut q);
        armed += evs.iter().filter(|e| matches!(e, MicEvent::PrerollStart { .. })).count();
        assert_eq!(armed, 0, "no second pre-roll inside one utterance");
        assert!(is_speech(&f), "the continuation goes straight out");
    }

    /// After a real silence the next utterance gets its own pre-roll.
    #[test]
    fn preroll_rearms_for_the_next_utterance() {
        let mut src = MicSource::new(levers(5));
        let mut q = speech(2);
        for _ in 0..(7 + HANGOVER_TICKS) {
            src.next_frame(&mut q);
        }
        q.extend(speech(2));
        let (f, evs) = src.next_frame(&mut q);
        assert!(evs.iter().any(|e| matches!(e, MicEvent::PrerollStart { .. })), "second utterance, second pre-roll");
        assert!(!is_speech(&f));
    }

    #[test]
    fn an_idle_call_only_ever_sends_comfort_noise() {
        let mut src = MicSource::new(levers(5));
        let mut q: VecDeque<Vec<i16>> = VecDeque::new();
        for _ in 0..20 {
            let (f, evs) = src.next_frame(&mut q);
            assert!(evs.is_empty());
            assert!(f.iter().any(|&s| s != 0), "never an all-zero frame (the engine reads that as mic-mute)");
            assert!(!is_speech(&f));
        }
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

    #[test]
    fn percentile_is_nearest_rank_and_one_outlier_moves_only_the_max() {
        assert_eq!(percentile(&[], 90.0), 0.0);
        assert_eq!(percentile(&[7.0], 90.0), 7.0);
        // 47 frames at ~1 ms with one 80 ms stall (call 00AB3AFC): p90 stays at the floor.
        let mut run: Vec<f32> = (0..46).map(|i| 1.0 + i as f32 * 0.01).collect();
        run.push(80.0);
        run.sort_by(f32::total_cmp);
        assert!(percentile(&run, 90.0) < 2.0, "{}", percentile(&run, 90.0));
        assert_eq!(percentile(&run, 100.0), 80.0);
        // Six of 47 over budget = 13 % of ticks late: p90 crosses the line.
        let mut late = run.clone();
        for v in late.iter_mut().rev().take(6) {
            *v = 70.0;
        }
        late.sort_by(f32::total_cmp);
        assert!(percentile(&late, 90.0) >= 60.0);
    }

    #[test]
    fn loopback_encodes_every_input_frame_as_speech_sized_packets() {
        // 1 s of a 440 Hz tone at about -12 dBFS = 17 frames (the last one partial, padded).
        let n = 16_000;
        let tone: Vec<i16> = (0..n)
            .map(|i| (8000.0 * (2.0 * std::f32::consts::PI * 440.0 * i as f32 / 16000.0).sin()) as i16)
            .collect();
        let levers = Levers { dtx: false, idle_db: -60.0, preroll: Preroll::Off, preroll_frames: 0, preroll_db: -30.0 };
        let r = loopback(&tone, levers.clone());
        assert_eq!(r.speech_frames, 17, "every input frame went through the clock: {r:?}");
        assert_eq!(r.frames, 17 + HANGOVER_TICKS + 4, "then the hangover and a few idle ticks");
        assert_eq!(r.encoded_frames, r.frames, "every tick's frame became a packet: {r:?}");
        assert!(r.encoded_bytes > 0 && r.mean_speech_packet > 1.0, "{r:?}");
        // MLow is content-adaptive: a pure tone codes SMALLER than the -60 dBFS noise
        // floor (~80 B vs ~127 B here), so packet size says nothing about "speech".
        assert!(r.encode_ms_p90 < 60.0, "real-time capable: {r:?}");
        assert!(r.encode_ms_p90 <= r.encode_ms_max && r.encode_ms_max_frame < r.frames, "{r:?}");
        assert!((r.input_dbfs + 15.0).abs() < 2.0, "{r:?}");
        // With a pre-roll the clock adds those frames too — they carry signal, so they count as speech.
        let with = Levers { dtx: false, idle_db: -60.0, preroll: Preroll::Noise, preroll_frames: 5, preroll_db: -30.0 };
        let r2 = loopback(&tone, with);
        assert_eq!(r2.speech_frames, 17 + 5, "{r2:?}");
        // Silence in = only the idle floor out, nothing counted as speech.
        let r3 = loopback(&vec![0i16; n], levers);
        assert_eq!(r3.speech_frames, 0, "{r3:?}");
    }
}
