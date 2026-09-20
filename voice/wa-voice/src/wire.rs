//! Per-call ground truth for the first-word cut-off investigation
//! (research/voice-cutoff-investigation.md): a wire log of every relay packet
//! in both directions (RTP header fields, sizes, cadence — payloads are SRTP
//! ciphertext, so the TOC is not visible here) plus the PCM actually fed to the
//! encoder and decoded from the peer, so a recording of what the phone played
//! can be aligned against what left this machine.
//!
//! `WA_VOICE_WIRE_LOG=0` disables the log; `WA_VOICE_CAPTURE=1` enables the two
//! wavs. Files: `~/.cache/console/voice-wire/<call_id>.log|-tx.wav|-rx.wav`.

use std::fs::{self, File};
use std::io::{BufWriter, Seek, SeekFrom, Write};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Instant;

use log::{info, warn};
use whatsapp_rust::TokioRuntime;
use whatsapp_rust::voip::transport::RelayMediaChannelFactory;
use whatsapp_rust::wacore::runtime::Runtime;
use whatsapp_rust::wacore::voip::demux::{RelayPacketKind, classify_relay_packet};
use whatsapp_rust::wacore::voip::rtp::{parse_rtp_header, rtp_extension_profile_and_data};
use whatsapp_rust::wacore::voip::tap::{PacketDir, PacketTap, TappedFactory};
use whatsapp_rust::wacore::voip_control::transport::{
    RelayEndpointParams, RelayTransportFactory, RelayTransportProvider,
};

pub static WIRE: LazyLock<Arc<WireLog>> = LazyLock::new(|| Arc::new(WireLog::default()));

fn dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    PathBuf::from(home)
        .join(".cache")
        .join("console")
        .join("voice-wire")
}

pub fn enabled() -> bool {
    env_flag("WA_VOICE_WIRE_LOG", true)
}

fn env_flag(name: &str, default: bool) -> bool {
    match std::env::var(name) {
        Ok(v) => !matches!(v.trim(), "0" | "false" | "off" | "no" | ""),
        Err(_) => default,
    }
}

struct Wav {
    w: BufWriter<File>,
    samples: u32,
}

impl Wav {
    fn create(path: PathBuf) -> std::io::Result<Self> {
        let mut w = BufWriter::new(File::create(path)?);
        w.write_all(&[0u8; 44])?;
        Ok(Self { w, samples: 0 })
    }

    fn push(&mut self, pcm: &[i16]) {
        for s in pcm {
            let _ = self.w.write_all(&s.to_le_bytes());
        }
        self.samples += pcm.len() as u32;
    }

    fn finish(mut self) {
        let data = self.samples * 2;
        let mut h = Vec::with_capacity(44);
        h.extend_from_slice(b"RIFF");
        h.extend_from_slice(&(36 + data).to_le_bytes());
        h.extend_from_slice(b"WAVEfmt ");
        h.extend_from_slice(&16u32.to_le_bytes());
        h.extend_from_slice(&1u16.to_le_bytes());
        h.extend_from_slice(&1u16.to_le_bytes());
        h.extend_from_slice(&16000u32.to_le_bytes());
        h.extend_from_slice(&32000u32.to_le_bytes());
        h.extend_from_slice(&2u16.to_le_bytes());
        h.extend_from_slice(&16u16.to_le_bytes());
        h.extend_from_slice(b"data");
        h.extend_from_slice(&data.to_le_bytes());
        let _ = self.w.flush();
        if let Ok(mut f) = self.w.into_inner() {
            let _ = f.seek(SeekFrom::Start(0));
            let _ = f.write_all(&h);
        }
    }
}

struct Open {
    call_id: String,
    t0: Instant,
    log: Option<BufWriter<File>>,
    tx: Option<Wav>,
    rx: Option<Wav>,
}

#[derive(Default)]
pub struct WireLog {
    open: Mutex<Option<Open>>,
}

impl WireLog {
    fn lock(&self) -> std::sync::MutexGuard<'_, Option<Open>> {
        self.open.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Start a call's files. One call at a time is logged; a second live call
    /// shares the open one's log lines.
    pub fn open(&self, call_id: &str) {
        let want_log = env_flag("WA_VOICE_WIRE_LOG", true);
        let want_pcm = env_flag("WA_VOICE_CAPTURE", false);
        if !want_log && !want_pcm {
            return;
        }
        let d = dir();
        if let Err(e) = fs::create_dir_all(&d) {
            warn!("wire log: cannot create {}: {e}", d.display());
            return;
        }
        let mut g = self.lock();
        if g.is_some() {
            return;
        }
        let log = want_log
            .then(|| {
                File::create(d.join(format!("{call_id}.log")))
                    .ok()
                    .map(BufWriter::new)
            })
            .flatten();
        let (tx, rx) = if want_pcm {
            (
                Wav::create(d.join(format!("{call_id}-tx.wav"))).ok(),
                Wav::create(d.join(format!("{call_id}-rx.wav"))).ok(),
            )
        } else {
            (None, None)
        };
        info!(
            "wire log for {call_id}: {} (log={}, pcm={})",
            d.display(),
            log.is_some(),
            tx.is_some()
        );
        *g = Some(Open {
            call_id: call_id.to_string(),
            t0: Instant::now(),
            log,
            tx,
            rx,
        });
        drop(g);
        self.line(&format!("open call={call_id} unix_ms={}", unix_ms()));
    }

    pub fn close(&self, call_id: &str) {
        let taken = {
            let mut g = self.lock();
            match g.as_ref() {
                Some(o) if o.call_id == call_id => g.take(),
                _ => None,
            }
        };
        if let Some(mut o) = taken {
            if let Some(l) = o.log.as_mut() {
                let _ = writeln!(l, "{:>9} close", o.t0.elapsed().as_millis());
                let _ = l.flush();
            }
            if let Some(w) = o.tx.take() {
                w.finish();
            }
            if let Some(w) = o.rx.take() {
                w.finish();
            }
        }
    }

    /// One annotated line (queue onsets, media stats, codec events).
    pub fn line(&self, s: &str) {
        let mut g = self.lock();
        if let Some(o) = g.as_mut()
            && let Some(l) = o.log.as_mut()
        {
            let _ = writeln!(l, "{:>9} {s}", o.t0.elapsed().as_millis());
        }
    }

    pub fn tx_pcm(&self, pcm: &[i16]) {
        let mut g = self.lock();
        if let Some(o) = g.as_mut()
            && let Some(w) = o.tx.as_mut()
        {
            w.push(pcm);
        }
    }

    pub fn rx_pcm(&self, pcm: &[i16]) {
        let mut g = self.lock();
        if let Some(o) = g.as_mut()
            && let Some(w) = o.rx.as_mut()
        {
            w.push(pcm);
        }
    }
}

fn unix_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

impl PacketTap for WireLog {
    fn on_packet(&self, dir: PacketDir, data: &[u8]) {
        let mut g = self.lock();
        let Some(o) = g.as_mut() else { return };
        let Some(l) = o.log.as_mut() else { return };
        let t = o.t0.elapsed().as_millis();
        let d = match dir {
            PacketDir::Outbound => "out",
            PacketDir::Inbound => "in ",
        };
        match classify_relay_packet(data) {
            RelayPacketKind::Rtp => {
                let Some(h) = parse_rtp_header(data) else {
                    let _ = writeln!(l, "{t:>9} {d} rtp? len={}", data.len());
                    return;
                };
                let ext = match rtp_extension_profile_and_data(data) {
                    Some((Some(p), e)) => {
                        let mut s = format!("{p:04x}:");
                        for b in e {
                            s.push_str(&format!("{b:02x}"));
                        }
                        s
                    }
                    _ => "-".to_string(),
                };
                let _ = writeln!(
                    l,
                    "{t:>9} {d} rtp pt={} seq={} ts={} m={} ext={ext} len={}",
                    h.payload_type,
                    h.sequence_number,
                    h.timestamp,
                    h.marker as u8,
                    data.len()
                );
            }
            RelayPacketKind::Rtcp => {
                let _ = writeln!(
                    l,
                    "{t:>9} {d} rtcp pt={} len={}",
                    data.get(1).copied().unwrap_or(0),
                    data.len()
                );
            }
            RelayPacketKind::Stun => {
                let _ = writeln!(l, "{t:>9} {d} stun len={}", data.len());
            }
            RelayPacketKind::Other => {
                let _ = writeln!(
                    l,
                    "{t:>9} {d} other b0={:02x} len={}",
                    data.first().copied().unwrap_or(0),
                    data.len()
                );
            }
        }
    }
}

/// The native relay dialler wrapped in the packet tap.
pub struct TappedNativeRelay;

#[async_trait::async_trait]
impl RelayTransportProvider for TappedNativeRelay {
    async fn factory(
        &self,
        relay: &RelayEndpointParams,
    ) -> anyhow::Result<Arc<dyn RelayTransportFactory>> {
        let addr: SocketAddr = relay.addr;
        let rt: Arc<dyn Runtime> = Arc::new(TokioRuntime);
        let inner: Arc<dyn RelayTransportFactory> =
            Arc::new(RelayMediaChannelFactory::new(addr, rt.clone()));
        Ok(Arc::new(TappedFactory::new(inner, WIRE.clone(), rt)))
    }
}
