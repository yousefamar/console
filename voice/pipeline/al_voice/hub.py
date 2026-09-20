"""The hub routes the pipeline talks to, all under the `voice` bearer.

session    → answer policy + fork AL for the call (ring time)
turn       → one utterance in, the fork's reply streamed back as NDJSON
interrupt  → barge-in: stop the fork's current turn
transcript → the post-call record (also closes the fork hub-side)"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from typing import Any

import httpx
from loguru import logger

from .config import Config


class HubClient:
    def __init__(self, cfg: Config):
        self._cfg = cfg
        self._http = httpx.AsyncClient(
            base_url=cfg.hub_url,
            verify=False,  # hub's own self-signed cert on loopback
            headers={"Authorization": f"Bearer {cfg.hub_token}", "X-Console-Agent": "al-voice"},
            timeout=httpx.Timeout(10.0, read=40.0),
        )

    async def close(self) -> None:
        await self._http.aclose()

    async def session(self, call_id: str, jid: str, direction: str, task: str | None = None) -> dict[str, Any]:
        """{answer, why, displayName, user, jid, forkSessionId?, forkKey?, model?}"""
        body: dict[str, Any] = {"callId": call_id, "jid": jid, "direction": direction}
        if task:
            body["task"] = task
        r = await self._http.post("/voice/session", json=body, timeout=httpx.Timeout(10.0, read=60.0))
        r.raise_for_status()
        return r.json()

    async def turn(self, call_id: str, text: str, *, cue: bool = False, interrupted_after: str | None = None) -> AsyncIterator[dict[str, Any]]:
        """Stream the fork's reply: {type: text|tool|result|error, …} per line."""
        body: dict[str, Any] = {"callId": call_id, "text": text, "cue": cue}
        if interrupted_after:
            body["interruptedAfter"] = interrupted_after
        async with self._http.stream("POST", "/voice/turn", json=body, timeout=httpx.Timeout(10.0, read=self._cfg.turn_timeout_secs)) as r:
            if r.status_code != 200:
                detail = (await r.aread()).decode("utf-8", "replace")[:200]
                yield {"type": "error", "message": f"hub /voice/turn {r.status_code}: {detail}"}
                return
            async for line in r.aiter_lines():
                line = line.strip()
                if not line:
                    continue
                try:
                    yield json.loads(line)
                except json.JSONDecodeError:
                    logger.warning(f"non-JSON line from /voice/turn: {line[:80]!r}")

    async def interrupt(self, call_id: str) -> None:
        try:
            r = await self._http.post("/voice/interrupt", json={"callId": call_id}, timeout=5.0)
            if r.status_code != 200:
                logger.warning(f"[{call_id}] interrupt → {r.status_code}")
        except Exception as e:  # noqa: BLE001
            logger.warning(f"[{call_id}] interrupt failed: {e!r}")

    async def transcript(self, payload: dict[str, Any]) -> None:
        try:
            r = await self._http.post("/voice/transcript", json=payload)
            r.raise_for_status()
        except Exception as e:  # noqa: BLE001
            logger.error(f"posting transcript for {payload.get('callId')} failed: {e!r}")
            raise

    async def health(self) -> bool:
        try:
            r = await self._http.get("/voice/health", timeout=3.0)
            return r.status_code == 200
        except Exception:  # noqa: BLE001
            return False
