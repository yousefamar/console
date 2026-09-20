//! The control-socket contract. Text frames are one JSON object each; binary
//! frames are `[slot: u8][s16le mono 16 kHz PCM, 960 samples]`.

use serde::{Deserialize, Serialize};

/// Client → sidecar.
#[derive(Debug, Deserialize)]
#[serde(tag = "cmd", rename_all = "lowercase")]
pub enum Command {
    /// Place a call. `to` is a JID or a bare phone number.
    Call {
        to: String,
        #[serde(default)]
        id: Option<String>,
    },
    Answer {
        #[serde(rename = "callId")]
        call_id: String,
        #[serde(default)]
        id: Option<String>,
    },
    Reject {
        #[serde(rename = "callId")]
        call_id: String,
        #[serde(default)]
        id: Option<String>,
    },
    Hangup {
        #[serde(rename = "callId")]
        call_id: String,
        #[serde(default)]
        id: Option<String>,
    },
    /// Drop any outbound PCM still queued for this call (barge-in).
    Flush {
        #[serde(rename = "callId")]
        call_id: String,
    },
    Status {
        #[serde(default)]
        id: Option<String>,
    },
    Ping,
}

/// Sidecar → client.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "ev", rename_all = "lowercase")]
pub enum Event {
    Ready {
        jid: String,
    },
    Qr {
        code: String,
        #[serde(rename = "dataUrl")]
        data_url: String,
        #[serde(rename = "timeoutSecs")]
        timeout_secs: u64,
    },
    Disconnected {
        reason: String,
    },
    #[serde(rename = "loggedout")]
    LoggedOut,
    Incoming {
        #[serde(rename = "callId")]
        call_id: String,
        from: String,
        video: bool,
        slot: u8,
    },
    Ringing {
        #[serde(rename = "callId")]
        call_id: String,
        slot: u8,
    },
    Accepted {
        #[serde(rename = "callId")]
        call_id: String,
        slot: u8,
    },
    Ended {
        #[serde(rename = "callId")]
        call_id: String,
        slot: u8,
        #[serde(skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
        #[serde(rename = "durationMs")]
        duration_ms: u64,
    },
    Error {
        #[serde(rename = "callId", skip_serializing_if = "Option::is_none")]
        call_id: Option<String>,
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
    },
    Ack {
        cmd: &'static str,
        #[serde(rename = "callId", skip_serializing_if = "Option::is_none")]
        call_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        slot: Option<u8>,
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
    },
    Status {
        connected: bool,
        paired: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        jid: Option<String>,
        calls: Vec<CallSummary>,
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
    },
    Pong,
}

#[derive(Debug, Clone, Serialize)]
pub struct CallSummary {
    #[serde(rename = "callId")]
    pub call_id: String,
    pub slot: u8,
    pub peer: String,
    pub direction: &'static str,
    pub state: &'static str,
}

impl Event {
    pub fn json(&self) -> String {
        serde_json::to_string(self).expect("event serialises")
    }
}
