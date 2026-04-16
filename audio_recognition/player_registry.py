"""
Player Registry & Stream Discovery

A "player" is a named logical endpoint that consumes exactly one audio stream
(typically an RTP stream from a speaker group). Each running RecognitionEngine
is bound to one player so multiple speaker groups can be recognised in parallel
on a single UDP port.

The registry:
  * Holds the configured list of players (from config.yaml / settings.json).
  * Watches incoming packet sources (IP, SSRC) and binds them to players
    either by explicit config (source_ip / rtp_ssrc) or by auto-discovery.
  * Surfaces discovered-but-unassigned streams for the settings UI.

The registry is pure/synchronous; callers that care about thread safety should
hold the registry lock or use the provided public methods which already lock.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from typing import Dict, Iterable, List, Optional, Tuple

from logging_config import get_logger

logger = get_logger(__name__)


DEFAULT_PLAYER_NAME = "default"


@dataclass
class PlayerConfig:
    """User-configured binding for a logical player."""
    name: str
    source_ip: Optional[str] = None
    rtp_ssrc: Optional[int] = None
    music_assistant_player_id: Optional[str] = None
    description: Optional[str] = None
    # True when this player was synthesised at runtime (e.g. the fallback
    # "default" player used when no players are configured). These are
    # excluded from config persistence helpers.
    auto: bool = False

    def matches(self, source_ip: Optional[str], ssrc: Optional[int]) -> bool:
        if self.rtp_ssrc is not None and ssrc is not None and self.rtp_ssrc == ssrc:
            return True
        if self.source_ip and source_ip and self.source_ip == source_ip:
            return True
        return False

    @property
    def has_explicit_filter(self) -> bool:
        return self.source_ip is not None or self.rtp_ssrc is not None


@dataclass
class DiscoveredStream:
    """A stream observed on the UDP socket that hasn't been bound yet."""
    source_ip: str
    source_port: int
    ssrc: Optional[int]
    payload_type: Optional[int]
    first_seen: float
    last_seen: float
    packet_count: int = 0
    bound_player: Optional[str] = None

    @property
    def key(self) -> Tuple[str, Optional[int]]:
        return (self.source_ip, self.ssrc)

    def to_dict(self) -> dict:
        return {
            "source_ip": self.source_ip,
            "source_port": self.source_port,
            "ssrc": f"0x{self.ssrc:08X}" if self.ssrc is not None else None,
            "payload_type": self.payload_type,
            "first_seen": self.first_seen,
            "last_seen": self.last_seen,
            "packet_count": self.packet_count,
            "bound_player": self.bound_player,
            "active": (time.time() - self.last_seen) < 10.0,
        }


class PlayerRegistry:
    """
    Tracks configured players and observed streams, resolving packets to players.

    Thread-safe: a single RLock guards both tables since the hot path
    (resolve on each datagram) and the admin path (list / bind) must not race.
    """

    # How long to remember a learned (source_ip, ssrc) -> player binding after
    # it last emitted a packet. Covers brief silences / session resets.
    LEARNED_BINDING_TTL = 5 * 60.0  # seconds

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._players: Dict[str, PlayerConfig] = {}
        # Learned bindings: (source_ip, ssrc) -> (player_name, last_seen)
        self._learned: Dict[Tuple[str, Optional[int]], Tuple[str, float]] = {}
        self._streams: Dict[Tuple[str, Optional[int]], DiscoveredStream] = {}
        self._auto_discover: bool = True

    # ------------------------------------------------------------------
    # Configuration

    def load_from_config(self, entries: Iterable[dict], auto_discover: bool = True) -> None:
        """Replace the configured players with the supplied list."""
        with self._lock:
            # Keep any auto-generated players (e.g. the default fallback) so
            # that callers who already resolved one keep the same name.
            preserved = {name: p for name, p in self._players.items() if p.auto}
            self._players.clear()
            self._players.update(preserved)
            for entry in entries or []:
                name = str(entry.get("name", "")).strip()
                if not name or name in self._players:
                    continue
                ssrc = entry.get("rtp_ssrc")
                if isinstance(ssrc, str):
                    try:
                        ssrc = int(ssrc, 0) & 0xFFFFFFFF
                    except (ValueError, TypeError):
                        ssrc = None
                self._players[name] = PlayerConfig(
                    name=name,
                    source_ip=(entry.get("source_ip") or None),
                    rtp_ssrc=ssrc if isinstance(ssrc, int) else None,
                    music_assistant_player_id=entry.get("music_assistant_player_id") or None,
                    description=entry.get("description") or None,
                )
            self._auto_discover = bool(auto_discover)
            # Drop any learned bindings that point at players we no longer know.
            stale = [key for key, (pn, _) in self._learned.items() if pn not in self._players]
            for key in stale:
                self._learned.pop(key, None)
            logger.info(
                f"Player registry loaded: {len(self._players)} configured, "
                f"auto_discover={self._auto_discover}"
            )

    def ensure_default_player(self) -> PlayerConfig:
        """
        Guarantee at least one player exists. In single-player (legacy) mode
        this synthesises a catch-all so the rest of the pipeline can address
        it by name.
        """
        with self._lock:
            if self._players:
                # Prefer an existing auto-default, else the first configured player.
                for p in self._players.values():
                    if p.auto:
                        return p
                return next(iter(self._players.values()))
            default = PlayerConfig(name=DEFAULT_PLAYER_NAME, auto=True)
            self._players[default.name] = default
            return default

    def list_players(self) -> List[PlayerConfig]:
        with self._lock:
            return list(self._players.values())

    def get(self, name: str) -> Optional[PlayerConfig]:
        with self._lock:
            return self._players.get(name)

    def list_discovered(self) -> List[DiscoveredStream]:
        with self._lock:
            # Shallow copies so callers can read without locking.
            return [
                DiscoveredStream(**vars(s)) for s in self._streams.values()
            ]

    # ------------------------------------------------------------------
    # Packet resolution (hot path)

    def resolve(
        self,
        source_ip: str,
        source_port: int,
        ssrc: Optional[int],
        payload_type: Optional[int],
    ) -> Optional[str]:
        """
        Decide which player a packet belongs to. Returns the player name
        or None if the packet should be dropped.

        Lookup order:
          1. Previously learned binding for (source_ip, ssrc).
          2. Explicit config filter (rtp_ssrc > source_ip).
          3. If auto-discover is enabled and exactly one player has no
             explicit filter, bind that player to this stream.
          4. Drop (unassigned) but record as a discovered stream.
        """
        now = time.time()
        key = (source_ip, ssrc)

        with self._lock:
            self._record_stream(key, source_ip, source_port, ssrc, payload_type, now)

            learned = self._learned.get(key)
            if learned is not None:
                pname, _ = learned
                if pname in self._players:
                    self._learned[key] = (pname, now)
                    self._streams[key].bound_player = pname
                    return pname
                self._learned.pop(key, None)

            # Explicit filter match (SSRC wins over IP)
            by_ssrc = None
            by_ip = None
            unfiltered: List[PlayerConfig] = []
            for p in self._players.values():
                if p.rtp_ssrc is not None and ssrc is not None and p.rtp_ssrc == ssrc:
                    by_ssrc = p
                    break
                if p.source_ip and p.source_ip == source_ip:
                    by_ip = by_ip or p
                elif not p.has_explicit_filter and not p.auto:
                    unfiltered.append(p)

            match = by_ssrc or by_ip
            if match is not None:
                self._bind_locked(key, match.name, now)
                return match.name

            if self._auto_discover and len(unfiltered) == 1:
                target = unfiltered[0]
                logger.info(
                    f"Auto-binding stream {source_ip}:{source_port} "
                    f"(SSRC={'0x%08X' % ssrc if ssrc is not None else 'n/a'}) "
                    f"to unfiltered player '{target.name}'"
                )
                self._bind_locked(key, target.name, now)
                return target.name

            # Fallback: if there's exactly one player total (including auto), use it.
            if len(self._players) == 1:
                only = next(iter(self._players.values()))
                self._bind_locked(key, only.name, now)
                return only.name

            # Otherwise unassigned — leave in _streams for UI and return None.
            return None

    def bind(self, source_ip: str, ssrc: Optional[int], player_name: str) -> bool:
        """Manually bind a discovered stream to a configured player."""
        with self._lock:
            if player_name not in self._players:
                return False
            key = (source_ip, ssrc)
            self._bind_locked(key, player_name, time.time())
            return True

    def forget_binding(self, source_ip: str, ssrc: Optional[int]) -> None:
        with self._lock:
            key = (source_ip, ssrc)
            self._learned.pop(key, None)
            s = self._streams.get(key)
            if s is not None:
                s.bound_player = None

    # ------------------------------------------------------------------
    # Internals

    def _record_stream(
        self,
        key: Tuple[str, Optional[int]],
        source_ip: str,
        source_port: int,
        ssrc: Optional[int],
        payload_type: Optional[int],
        now: float,
    ) -> None:
        s = self._streams.get(key)
        if s is None:
            s = DiscoveredStream(
                source_ip=source_ip,
                source_port=source_port,
                ssrc=ssrc,
                payload_type=payload_type,
                first_seen=now,
                last_seen=now,
                packet_count=0,
            )
            self._streams[key] = s
        s.last_seen = now
        s.packet_count += 1
        if payload_type is not None and s.payload_type is None:
            s.payload_type = payload_type

        # Periodically trim stale streams (not active in 5 minutes).
        if len(self._streams) > 32:
            cutoff = now - 300
            stale = [k for k, st in self._streams.items() if st.last_seen < cutoff]
            for k in stale:
                self._streams.pop(k, None)

    def _bind_locked(
        self,
        key: Tuple[str, Optional[int]],
        player_name: str,
        now: float,
    ) -> None:
        self._learned[key] = (player_name, now)
        s = self._streams.get(key)
        if s is not None:
            s.bound_player = player_name
        # Trim very stale learned bindings.
        if len(self._learned) > 128:
            cutoff = now - self.LEARNED_BINDING_TTL
            stale = [k for k, (_, ts) in self._learned.items() if ts < cutoff]
            for k in stale:
                self._learned.pop(k, None)


# Process-global singleton.
_registry: Optional[PlayerRegistry] = None


def get_registry() -> PlayerRegistry:
    global _registry
    if _registry is None:
        _registry = PlayerRegistry()
    return _registry
