"""
Player Manager

Coordinates multiple RecognitionEngine instances — one per configured player —
sharing a single UdpAudioCapture listener. The capture demuxes incoming RTP
packets to the right player's jitter/ring buffer via the PlayerRegistry.

Lifecycle:
  manager = PlayerManager()
  await manager.start(player_configs, shared_enrichers)  # creates N engines
  ...
  await manager.stop()

Query:
  manager.get_engine(player_name)  # or None
  manager.list_engine_status()     # status dict per player
  manager.get_current_song(player_name)
  manager.get_current_position(player_name)
"""

from __future__ import annotations

import asyncio
from typing import Any, Callable, Dict, Iterable, List, Optional

from logging_config import get_logger

from .engine import RecognitionEngine
from .player_registry import PlayerConfig, get_registry
from .udp_capture import UdpAudioCapture

logger = get_logger(__name__)


class PlayerManager:
    """Owns the shared UDP capture and the per-player recognition engines."""

    def __init__(self) -> None:
        self._udp_capture: Optional[UdpAudioCapture] = None
        self._engines: Dict[str, RecognitionEngine] = {}
        self._lock = asyncio.Lock()
        self._running = False

    # ------------------------------------------------------------------
    # Lifecycle

    async def start(
        self,
        players: Iterable[PlayerConfig],
        *,
        udp_port: int,
        sample_rate: int,
        jitter_buffer_ms: int,
        recognition_interval: float = 5.0,
        capture_duration: float = 5.0,
        latency_offset: float = 0.0,
        metadata_enricher: Optional[Callable[[str], Any]] = None,
        title_search_enricher: Optional[Callable[[str, str, Optional[str]], Any]] = None,
        on_song_change: Optional[Callable[[str, Any], None]] = None,
    ) -> None:
        """Start the shared UDP capture and spawn one engine per player."""
        async with self._lock:
            if self._running:
                logger.debug("PlayerManager already running")
                return

            registry = get_registry()
            player_list: List[PlayerConfig] = list(players)
            if not player_list:
                default = registry.ensure_default_player()
                player_list = [default]

            self._udp_capture = UdpAudioCapture(
                port=udp_port,
                sample_rate=sample_rate,
                jitter_buffer_ms=jitter_buffer_ms,
                registry=registry,
            )
            try:
                await self._udp_capture.start()
            except Exception as exc:
                logger.error(f"PlayerManager: failed to start UDP listener: {exc}")
                self._udp_capture = None
                return

            for p in player_list:
                if p.name in self._engines:
                    continue
                engine = RecognitionEngine(
                    recognition_interval=recognition_interval,
                    capture_duration=capture_duration,
                    latency_offset=latency_offset,
                    metadata_enricher=metadata_enricher,
                    title_search_enricher=title_search_enricher,
                    on_song_change=_wrap_song_change(on_song_change, p.name),
                    player_name=p.name,
                    shared_udp_capture=self._udp_capture,
                )
                try:
                    await engine.start()
                except Exception as exc:
                    logger.error(
                        f"PlayerManager: failed to start engine for player '{p.name}': {exc}"
                    )
                    continue
                self._engines[p.name] = engine
                logger.info(f"PlayerManager: engine started for player '{p.name}'")

            self._running = bool(self._engines)

    async def stop(self) -> None:
        async with self._lock:
            if not self._running:
                return
            logger.info("PlayerManager: stopping engines...")
            await asyncio.gather(
                *(_safe_stop(e) for e in self._engines.values()),
                return_exceptions=True,
            )
            self._engines.clear()

            if self._udp_capture is not None:
                try:
                    await self._udp_capture.stop()
                except Exception as exc:
                    logger.debug(f"PlayerManager: UDP capture stop error: {exc}")
                self._udp_capture = None
            self._running = False
            logger.info("PlayerManager: stopped")

    # ------------------------------------------------------------------
    # Query

    @property
    def is_running(self) -> bool:
        return self._running

    def get_engine(self, player_name: str) -> Optional[RecognitionEngine]:
        return self._engines.get(player_name)

    def list_engines(self) -> Dict[str, RecognitionEngine]:
        return dict(self._engines)

    def list_engine_status(self) -> list[dict]:
        out = []
        for name, engine in self._engines.items():
            status = engine.get_status()
            status["player_name"] = name
            out.append(status)
        return out

    def list_streams(self) -> list[dict]:
        return self._udp_capture.list_streams() if self._udp_capture else []

    def get_current_song(self, player_name: str) -> Optional[dict]:
        engine = self._engines.get(player_name)
        return engine.get_current_song() if engine else None

    def get_current_position(self, player_name: str) -> Optional[float]:
        engine = self._engines.get(player_name)
        return engine.get_current_position() if engine else None


async def _safe_stop(engine: RecognitionEngine) -> None:
    try:
        await engine.stop()
    except Exception as exc:
        logger.debug(f"Engine stop error: {exc}")


def _wrap_song_change(
    user_cb: Optional[Callable[[str, Any], None]],
    player_name: str,
) -> Optional[Callable[[Any], None]]:
    """Translate engine's (result) callback into (player_name, result)."""
    if user_cb is None:
        return None

    def _cb(result: Any) -> None:
        try:
            user_cb(player_name, result)
        except Exception as exc:
            logger.debug(f"on_song_change callback error for '{player_name}': {exc}")

    return _cb


# Process-global singleton.
_manager: Optional[PlayerManager] = None


def get_player_manager() -> PlayerManager:
    global _manager
    if _manager is None:
        _manager = PlayerManager()
    return _manager
