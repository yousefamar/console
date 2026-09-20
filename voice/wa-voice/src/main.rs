//! wa-voice: WhatsApp voice-call sidecar for the Console hub.
//!
//! A second linked device on AL's WhatsApp account (Baileys in the hub stays
//! device #1 for text). Exposes calls over a local WebSocket: JSON control in
//! text frames, 16 kHz s16le mono PCM in binary frames prefixed with a 1-byte
//! call slot. See `proto.rs` for the contract.
//!
//! Env: `WA_VOICE_PORT` (default 9878), `WA_VOICE_STORE_DIR`
//! (default `~/.config/console/wa-voice`), `RUST_LOG`.

mod calls;
mod proto;
mod ws;

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result, anyhow};
use log::{error, info, warn};
use whatsapp_rust::prelude::*;
use whatsapp_rust::types::events::Event;

use calls::CallManager;
use ws::Broadcaster;

fn store_dir() -> PathBuf {
    if let Ok(d) = std::env::var("WA_VOICE_STORE_DIR") {
        return PathBuf::from(d);
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    PathBuf::from(home).join(".config").join("console").join("wa-voice")
}

#[tokio::main]
async fn main() -> Result<()> {
    env_logger::Builder::from_env(
        env_logger::Env::default().default_filter_or("info,webrtc_sctp=error,webrtc_dtls=error,rtc_dtls=error,rtc_sctp=error"),
    )
    .format(|buf, record| {
        use std::io::Write;
        writeln!(buf, "[wa-voice] {:<5} {}", record.level(), record.args())
    })
    .init();

    let port: u16 = std::env::var("WA_VOICE_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(9878);
    let addr: SocketAddr = ([127, 0, 0, 1], port).into();
    let dir = store_dir();
    std::fs::create_dir_all(&dir).with_context(|| format!("create {}", dir.display()))?;
    let db_path = dir.join("whatsapp.db");

    let bcast = Broadcaster::new();
    let calls = Arc::new(CallManager::new(bcast.clone()));

    let server = {
        let bcast = bcast.clone();
        let calls = calls.clone();
        tokio::spawn(async move {
            if let Err(e) = ws::serve(addr, bcast, calls).await {
                error!("control socket died: {e}");
                std::process::exit(2);
            }
        })
    };

    let mut backoff = Duration::from_secs(2);
    loop {
        match run_once(&db_path, calls.clone()).await {
            Ok(Exit::Shutdown) => break,
            Ok(Exit::Restart(why)) => {
                info!("restarting WhatsApp client: {why}");
                backoff = Duration::from_secs(2);
                if why.contains("QR") {
                    // Nobody scanned a whole batch; do not hammer the pairing
                    // endpoint (and the hub's QR relay) — the next batch can wait.
                    info!("pairing batch unused; next QR batch in 3 min");
                    tokio::time::sleep(Duration::from_secs(180)).await;
                }
            }
            Ok(Exit::LoggedOut) => {
                warn!("logged out — wiping the device store so the next run pairs afresh");
                for suffix in ["", "-wal", "-shm", "-journal"] {
                    let p = dir.join(format!("whatsapp.db{suffix}"));
                    let _ = std::fs::remove_file(p);
                }
                backoff = Duration::from_secs(2);
            }
            Err(e) => {
                error!("client run failed: {e:#}; retrying in {backoff:?}");
                tokio::time::sleep(backoff).await;
                backoff = (backoff * 2).min(Duration::from_secs(60));
            }
        }
        calls.set_client(None).await;
    }
    server.abort();
    Ok(())
}

enum Exit {
    Shutdown,
    Restart(String),
    LoggedOut,
}

async fn run_once(db_path: &std::path::Path, calls: Arc<CallManager>) -> Result<Exit> {
    let store = SqliteStore::new(db_path.to_str().ok_or_else(|| anyhow!("non-utf8 store path"))?)
        .await
        .map_err(|e| anyhow!("sqlite store: {e}"))?;

    let (restart_tx, mut restart_rx) = tokio::sync::mpsc::channel::<Exit>(4);

    let bot = {
        let qr_calls = calls.clone();
        let conn_calls = calls.clone();
        let lo_tx = restart_tx.clone();
        let lo_calls = calls.clone();
        let ev_calls = calls.clone();
        let ev_tx = restart_tx.clone();
        Bot::builder()
            .with_backend(store)
            .on_qr_code(move |code, timeout| {
                let calls = qr_calls.clone();
                async move {
                    info!("pairing QR issued (valid {}s) — scan from the AL phone: Linked devices → Link a device", timeout.as_secs());
                    calls.qr(code, timeout);
                }
            })
            .on_connected(move |client| {
                let calls = conn_calls.clone();
                async move {
                    let jid = client.pn().map(|j| j.to_string());
                    info!("connected as {}", jid.clone().unwrap_or_else(|| "?".into()));
                    calls.set_connected(jid);
                }
            })
            .on_logged_out(move |info| {
                let tx = lo_tx.clone();
                let calls = lo_calls.clone();
                async move {
                    warn!("logged out: {:?}", info.reason);
                    calls.set_logged_out();
                    let _ = tx.send(Exit::LoggedOut).await;
                }
            })
            .on_event(move |event, _client| {
                let calls = ev_calls.clone();
                let tx = ev_tx.clone();
                async move {
                    match &*event {
                        Event::IncomingCall(call) => calls.on_incoming_call(call),
                        Event::MissedCall(mc) => info!("missed call {} from {} (offline-delivered)", mc.call_id, mc.from),
                        Event::Disconnected(d) => calls.set_disconnected(&format!("{:?}", d.reason)),
                        Event::PairSuccess(_) => info!("paired as linked device"),
                        Event::PairingQrCodesExhausted(_) => {
                            let _ = tx.send(Exit::Restart("QR codes exhausted".into())).await;
                        }
                        _ => {}
                    }
                }
            })
            .build()
            .await
            .map_err(|e| anyhow!("build bot: {e}"))?
    };
    let client = bot.client();
    calls.set_client(Some(client.clone())).await;
    let mut handle = bot.spawn();

    let exit = tokio::select! {
        _ = &mut handle => Exit::Restart("client run loop ended".into()),
        _ = shutdown_signal() => Exit::Shutdown,
        Some(x) = restart_rx.recv() => x,
    };
    calls.set_disconnected("client stopped");
    handle.shutdown().await;
    Ok(exit)
}
