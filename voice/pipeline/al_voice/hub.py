"""The three hub routes the pipeline talks to, all under the `voice` bearer."""

from __future__ import annotations

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

    async def context(self, jid: str, task: str | None = None, direction: str = "in") -> dict[str, Any]:
        """{answer, why, systemPrompt, displayName, user, jid}"""
        params: dict[str, str] = {"jid": jid, "direction": direction}
        if task:
            params["task"] = task
        r = await self._http.get("/voice/context", params=params)
        r.raise_for_status()
        return r.json()

    async def delegate(self, request: str, caller: str, call_id: str, timeout: float) -> str:
        r = await self._http.post(
            "/voice/delegate",
            json={"request": request, "callerPhone": caller, "callId": call_id},
            timeout=httpx.Timeout(5.0, read=timeout + 5),
        )
        r.raise_for_status()
        return str(r.json().get("response") or "").strip()

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
