//! Local WebSocket control/media socket. One process (the Pipecat pipeline, or
//! the hub for QR relay) connects; every event is broadcast to all clients and
//! every client may send commands and audio.

use std::net::SocketAddr;
use std::sync::Arc;

use anyhow::{Context, Result};
use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use log::{debug, info, warn};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::broadcast;
use tokio_tungstenite::tungstenite::Message;

use crate::calls::CallManager;
use crate::proto::{Command, Event};

#[derive(Clone, Debug)]
pub enum Outbound {
    Text(Arc<str>),
    Audio(Bytes),
}

/// Fan-out to every connected client. Audio is loss tolerant, so a slow client
/// that lags the ring buffer simply misses frames rather than stalling anyone.
#[derive(Clone)]
pub struct Broadcaster {
    tx: broadcast::Sender<Outbound>,
}

impl Broadcaster {
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel(1024);
        Self { tx }
    }

    pub fn event(&self, ev: &Event) {
        let json = ev.json();
        debug!("→ {json}");
        let _ = self.tx.send(Outbound::Text(Arc::from(json)));
    }

    pub fn audio(&self, slot: u8, pcm: &[i16]) {
        let mut buf = Vec::with_capacity(1 + pcm.len() * 2);
        buf.push(slot);
        for s in pcm {
            buf.extend_from_slice(&s.to_le_bytes());
        }
        let _ = self.tx.send(Outbound::Audio(Bytes::from(buf)));
    }

    fn subscribe(&self) -> broadcast::Receiver<Outbound> {
        self.tx.subscribe()
    }
}

pub async fn serve(addr: SocketAddr, bcast: Broadcaster, calls: Arc<CallManager>) -> Result<()> {
    let listener = TcpListener::bind(addr)
        .await
        .with_context(|| format!("bind {addr}"))?;
    info!("control socket listening on ws://{addr}");
    loop {
        let (stream, peer) = listener.accept().await?;
        let bcast = bcast.clone();
        let calls = calls.clone();
        tokio::spawn(async move {
            if let Err(e) = handle_client(stream, peer, bcast, calls).await {
                warn!("client {peer}: {e}");
            }
        });
    }
}

async fn handle_client(
    stream: TcpStream,
    peer: SocketAddr,
    bcast: Broadcaster,
    calls: Arc<CallManager>,
) -> Result<()> {
    let ws = tokio_tungstenite::accept_async(stream).await?;
    info!("client connected: {peer}");
    let (mut sink, mut source) = ws.split();
    let mut rx = bcast.subscribe();

    // A late-joining client learns the current connection state immediately.
    let status = calls.status(None).await;
    sink.send(Message::Text(status.json().into())).await?;
    for ev in calls.catch_up_events().await {
        sink.send(Message::Text(ev.json().into())).await?;
    }

    loop {
        tokio::select! {
            out = rx.recv() => match out {
                Ok(Outbound::Text(t)) => sink.send(Message::Text(t.to_string().into())).await?,
                Ok(Outbound::Audio(b)) => sink.send(Message::Binary(b)).await?,
                Err(broadcast::error::RecvError::Lagged(n)) => {
                    warn!("client {peer} lagged {n} frames");
                }
                Err(broadcast::error::RecvError::Closed) => break,
            },
            msg = source.next() => match msg {
                Some(Ok(Message::Text(t))) => {
                    match serde_json::from_str::<Command>(&t) {
                        Ok(Command::Ping) => sink.send(Message::Text(Event::Pong.json().into())).await?,
                        Ok(cmd) => {
                            debug!("← {t}");
                            calls.handle_command(cmd).await;
                        }
                        Err(e) => {
                            let ev = Event::Error { call_id: None, message: format!("bad command: {e}"), id: None };
                            sink.send(Message::Text(ev.json().into())).await?;
                        }
                    }
                }
                Some(Ok(Message::Binary(b))) => {
                    if let Some((&slot, pcm)) = b.split_first() {
                        calls.push_audio(slot, pcm);
                    }
                }
                Some(Ok(Message::Ping(p))) => sink.send(Message::Pong(p)).await?,
                Some(Ok(Message::Close(_))) | None => break,
                Some(Ok(_)) => {}
                Some(Err(e)) => return Err(e.into()),
            },
        }
    }
    info!("client disconnected: {peer}");
    Ok(())
}
