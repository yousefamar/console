"""Runtime configuration: `~/.config/console/voice.env` + `cartesia.env` +
the hub's `voice` bearer from `local-tokens.json`. Process env wins over the
files so pm2 / a shell can override anything."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path

CONFIG_DIR = Path(os.environ.get("CONSOLE_CONFIG_DIR", Path.home() / ".config" / "console"))

# Owner-tagged inference profiles (server/src/bedrock-profiles.ts). Haiku is the
# default: measured 1.1 s end-of-speech → first audio vs 2.1–2.5 s on Sonnet 5
# (2026-09-20), and the spec's ceiling is 1.2 s. VOICE_LLM_MODEL overrides.
DEFAULT_LLM_MODEL = "arn:aws:bedrock:us-east-1:637423377122:application-inference-profile/5we3084lce1f"  # haiku-4-5
SONNET_LLM_MODEL = "arn:aws:bedrock:us-east-1:637423377122:application-inference-profile/56dbk0s0u5no"  # sonnet-5


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
    llm_model: str = DEFAULT_LLM_MODEL
    aws_profile: str = "bedrock-amar"
    aws_region: str = "us-east-1"
    turn_stop: str = "timeout"  # timeout | smart
    user_speech_timeout: float = 0.5
    inbound_greet_after_secs: float = 2.0
    delegate_timeout_secs: float = 27.0
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
            llm_model=env.get("VOICE_LLM_MODEL", DEFAULT_LLM_MODEL),
            aws_profile=env.get("AWS_PROFILE", "bedrock-amar"),
            aws_region=env.get("AWS_REGION", "us-east-1"),
            turn_stop=env.get("VOICE_TURN_STOP", "timeout"),
            user_speech_timeout=float(env.get("VOICE_USER_SPEECH_TIMEOUT", "0.5")),
            inbound_greet_after_secs=float(env.get("VOICE_INBOUND_GREET_AFTER", "2.0")),
            delegate_timeout_secs=float(env.get("VOICE_DELEGATE_TIMEOUT", "27")),
            max_call_secs=int(env.get("VOICE_MAX_CALL_SECS", str(30 * 60))),
            inbound_enabled=env.get("VOICE_INBOUND", "1") not in ("0", "false", "off"),
        )
        # The Bedrock client reads the standard AWS env; make the hub's profile the default.
        os.environ.setdefault("AWS_PROFILE", cfg.aws_profile)
        os.environ.setdefault("AWS_REGION", cfg.aws_region)
        os.environ.setdefault("AWS_DEFAULT_REGION", cfg.aws_region)
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
