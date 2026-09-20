"""Runtime configuration: `~/.config/console/voice.env` + `cartesia.env` +
the hub's `voice` bearer from `local-tokens.json`. Process env wins over the
files so pm2 / a shell can override anything. The call's brain (a fork of AL)
and its model live hub-side (VOICE_FORK_MODEL / VOICE_FORK_CONTEXT in the same
voice.env are read by the hub, not here)."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path

CONFIG_DIR = Path(os.environ.get("CONSOLE_CONFIG_DIR", Path.home() / ".config" / "console"))

def _read_env_file(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    try:
        for raw in path.read_text().splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip().strip('"').strip("'")
    except FileNotFoundError:
        pass
    return out


@dataclass
class Config:
    sidecar_url: str = "ws://127.0.0.1:9878"
    listen_host: str = "127.0.0.1"
    listen_port: int = 9879
    hub_url: str = "https://127.0.0.1:9877"
    hub_token: str = ""
    cartesia_api_key: str = ""
    cartesia_voice_id: str = ""
    cartesia_tts_model: str = "sonic-3.6"
    cartesia_stt_model: str = "ink-whisper"
    stt_language: str = "auto"
    # TTS languages the clone can speak natively (Cartesia voice accents); the
    # language router only switches between these. Refreshed from the voice
    # record at startup when possible.
    tts_languages: tuple[str, ...] = ("en", "ar", "de")
    turn_stop: str = "timeout"  # timeout | smart
    # Words the caller must say over AL before it counts as a barge-in (a bare
    # "Hello?"/"yeah" no longer cancels the sentence); 1 word when AL is quiet.
    interrupt_min_words: int = 2
    user_speech_timeout: float = 0.4
    inbound_greet_after_secs: float = 2.0
    turn_timeout_secs: float = 200.0
    hangup_grace_secs: float = 8.0
    max_call_secs: int = 30 * 60
    log_dir: Path = field(default_factory=lambda: CONFIG_DIR / "voice-calls")
    inbound_enabled: bool = True

    @classmethod
    def load(cls) -> "Config":
        env = {**_read_env_file(CONFIG_DIR / "cartesia.env"), **_read_env_file(CONFIG_DIR / "voice.env"), **os.environ}
        token = env.get("CONSOLE_VOICE_TOKEN", "")
        if not token:
            try:
                token = json.loads((CONFIG_DIR / "local-tokens.json").read_text()).get("voice", "")
            except (FileNotFoundError, json.JSONDecodeError):
                token = ""
        cfg = cls(
            sidecar_url=env.get("WA_VOICE_URL", f"ws://127.0.0.1:{env.get('WA_VOICE_PORT', '9878')}"),
            listen_host=env.get("VOICE_PIPELINE_HOST", "127.0.0.1"),
            listen_port=int(env.get("VOICE_PIPELINE_PORT", "9879")),
            hub_url=env.get("CONSOLE_HUB_URL", "https://127.0.0.1:9877"),
            hub_token=token,
            cartesia_api_key=env.get("CARTESIA_API_KEY", ""),
            cartesia_voice_id=env.get("CARTESIA_VOICE_ID", ""),
            cartesia_tts_model=env.get("CARTESIA_MODEL", "sonic-3.6"),
            cartesia_stt_model=env.get("VOICE_STT_MODEL", "ink-whisper"),
            stt_language=env.get("VOICE_STT_LANGUAGE", "auto"),
            tts_languages=tuple(x.strip() for x in env.get("VOICE_TTS_LANGUAGES", "en,ar,de").split(",") if x.strip()) or ("en",),
            turn_stop=env.get("VOICE_TURN_STOP", "timeout"),
            interrupt_min_words=max(1, int(env.get("VOICE_INTERRUPT_MIN_WORDS", "2"))),
            user_speech_timeout=float(env.get("VOICE_USER_SPEECH_TIMEOUT", "0.4")),
            inbound_greet_after_secs=float(env.get("VOICE_INBOUND_GREET_AFTER", "2.0")),
            turn_timeout_secs=float(env.get("VOICE_TURN_TIMEOUT", "200")),
            hangup_grace_secs=float(env.get("VOICE_HANGUP_GRACE", "8")),
            max_call_secs=int(env.get("VOICE_MAX_CALL_SECS", str(30 * 60))),
            inbound_enabled=env.get("VOICE_INBOUND", "1") not in ("0", "false", "off"),
        )
        cfg.log_dir.mkdir(parents=True, exist_ok=True)
        return cfg

    def missing(self) -> list[str]:
        out = []
        if not self.hub_token:
            out.append("voice bearer (local-tokens.json → voice)")
        if not self.cartesia_api_key:
            out.append("CARTESIA_API_KEY")
        if not self.cartesia_voice_id:
            out.append("CARTESIA_VOICE_ID")
        return out
