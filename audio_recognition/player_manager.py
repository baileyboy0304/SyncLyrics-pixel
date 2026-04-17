"""
Player Manager

Coordinates multiple RecognitionEngine instances — one per known player —
sharing a single UdpAudioCapture listener. The capture demuxes incoming RTP
packets to the right player's jitter/ring buffer via the PlayerRegistry.

In the UX-first (no-YAML) flow, the registry auto-creates a player the first
time a new RTP stream arrives. A registry observer wired up in ``start()``
tells the manager to spawn an engine for that player on the fly.

Lifecycle:
  manager = PlayerManager()
  await manager.start(player_configs, ...)     # zero or more players
  ...                                          # engines spawn dynamically
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
        # Cached engine-construction args so dynamic spawns match the
        # configuration the caller supplied at start().
        self._engine_kwargs: Dict[str, Any] = {}
        self._on_song_change: Optional[Callable[[str, Any], None]] = None
        # Event loop for thread-safe spawn scheduling from the UDP thread.
        self._loop: Optional[asyncio.AbstractEventLoop] = None

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
        """Start the shared UDP capture and spawn an engine for every player
        that's already in the registry. New auto-players will get engines
        spawned on demand via the registry observer."""
        async with self._lock:
            if self._running:
                logger.debug("PlayerManager already running")
                return

            registry = get_registry()
            player_list: List[PlayerConfig] = list(players)

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

            self._engine_kwargs = {
                "recognition_interval": recognition_interval,
                "capture_duration": capture_duration,
                "latency_offset": latency_offset,
                "metadata_enricher": metadata_enricher,
                "title_search_enricher": title_search_enricher,
            }
            self._on_song_change = on_song_change
            self._loop = asyncio.get_running_loop()

            # Spawn engines for the players that already exist (either from
            # config or restored from the persisted auto-player JSON).
            for p in player_list:
                await self._spawn_engine_locked(p.name)

            # Wire the observer so newly auto-created players get engines.
            registry.add_player_added_listener(self._on_player_added_from_registry)

            # Consider ourselves running as soon as the socket is up, even if
            # no engines exist yet — the first RTP packet will create one.
            self._running = True
            logger.info(
                f"PlayerManager: running with {len(self._engines)} engine(s); "
                f"awaiting auto-detection for additional streams"
            )

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
            self._loop = None
            logger.info("PlayerManager: stopped")

    # ------------------------------------------------------------------
    # Dynamic engine spawning

    def _on_player_added_from_registry(self, player: PlayerConfig) -> None:
        """Registry observer — runs on the UDP / thread pool thread.

        Schedules an async spawn on the manager's event loop so we don't
        create asyncio objects from arbitrary threads.
        """
        loop = self._loop
        if loop is None or loop.is_closed():
            return
        try:
            loop.call_soon_threadsafe(
                asyncio.ensure_future, self._spawn_engine_async(player.name)
            )
        except Exception as exc:
            logger.debug(f"PlayerManager: could not schedule spawn for '{player.name}': {exc}")

    async def _spawn_engine_async(self, player_name: str) -> None:
        async with self._lock:
            await self._spawn_engine_locked(player_name)

    async def _spawn_engine_locked(self, player_name: str) -> None:
        if player_name in self._engines:
            return
        if self._udp_capture is None:
            return
        engine = RecognitionEngine(
            on_song_change=_wrap_song_change(self._on_song_change, player_name),
            player_name=player_name,
            shared_udp_capture=self._udp_capture,
            **self._engine_kwargs,
        )
        try:
            await engine.start()
        except Exception as exc:
            logger.error(
                f"PlayerManager: failed to start engine for player '{player_name}': {exc}"
            )
            return
        self._engines[player_name] = engine
        logger.info(f"PlayerManager: engine started for player '{player_name}'")

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
