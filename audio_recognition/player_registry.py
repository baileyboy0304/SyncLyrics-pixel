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

import json
import os
import threading
import time
from dataclasses import dataclass, field
from typing import Callable, Dict, Iterable, List, Optional, Tuple

from logging_config import get_logger

logger = get_logger(__name__)


DEFAULT_PLAYER_NAME = "default"
AUTO_PLAYER_PREFIX = "player-"


@dataclass
class PlayerConfig:
    """User-configured binding for a logical player."""
    name: str
    source_ip: Optional[str] = None
    rtp_ssrc: Optional[int] = None
    music_assistant_player_id: Optional[str] = None
    description: Optional[str] = None
    # True when this player was synthesised at runtime (auto-discovered or the
    # legacy default fallback). Auto-players are persisted across restarts via
    # the registry's JSON store, but are still distinguishable from
    # hand-configured entries in the UI.
    auto: bool = False
    # Display name shown in the UI. May be derived from Music Assistant or
    # set manually via /api/players/<name>/rename. Defaults to ``name``.
    display_name: Optional[str] = None
    # True once a user has explicitly renamed the player via the UI. Stream-
    # supplied names (RTP header extension) must not overwrite a manual
    # rename — only the user can undo that.
    display_name_is_manual: bool = False

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
        # When True (default once load_from_config is called with an empty
        # list), unknown streams auto-create a named player. The UX-first
        # flow relies on this so users never have to edit YAML.
        self._auto_create_players: bool = True
        # Observers notified when a new player is added. The PlayerManager
        # uses this to spawn an engine on demand.
        self._on_player_added: List[Callable[[PlayerConfig], None]] = []
        # Next numeric suffix for auto-named players (player-1, player-2, ...).
        self._auto_counter: int = 0
        # On-disk path for persisted friendly names + auto-player metadata.
        # Populated by ``set_persistence_path``; writes no-op until set.
        self._persistence_path: Optional[str] = None

    # ------------------------------------------------------------------
    # Configuration

    def load_from_config(self, entries: Iterable[dict], auto_discover: bool = True) -> None:
        """Replace the configured players with the supplied list."""
        entries_list = list(entries or [])
        with self._lock:
            # Keep any auto-generated players so that callers who already
            # resolved one keep the same name (and the UI-renamed friendly
            # label survives a config reload).
            preserved = {name: p for name, p in self._players.items() if p.auto}
            self._players.clear()
            self._players.update(preserved)
            for entry in entries_list:
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
            # If the user didn't configure any players explicitly, assume
            # they want the UX-first flow: unknown streams become new
            # auto-players automatically. Explicit YAML wiring disables this
            # so that config remains authoritative when present.
            self._auto_create_players = not any(not p.auto for p in self._players.values())
            # Drop any learned bindings that point at players we no longer know.
            stale = [key for key, (pn, _) in self._learned.items() if pn not in self._players]
            for key in stale:
                self._learned.pop(key, None)
            logger.info(
                f"Player registry loaded: {len(self._players)} configured, "
                f"auto_discover={self._auto_discover}, "
                f"auto_create={self._auto_create_players}"
            )

    # ------------------------------------------------------------------
    # Observers

    def add_player_added_listener(self, cb: Callable[[PlayerConfig], None]) -> None:
        """Register a callback fired whenever a new player enters the registry."""
        with self._lock:
            if cb not in self._on_player_added:
                self._on_player_added.append(cb)

    def _notify_player_added(self, player: PlayerConfig) -> None:
        # Invoke listeners outside the lock to avoid deadlock — the manager's
        # callback grabs its own asyncio lock.
        listeners = list(self._on_player_added)
        for cb in listeners:
            try:
                cb(player)
            except Exception as exc:
                logger.debug(f"player-added listener error: {exc}")

    # ------------------------------------------------------------------
    # Rename + persistence

    def set_persistence_path(self, path: Optional[str]) -> None:
        """Point the registry at a JSON file for auto-player + rename storage."""
        with self._lock:
            self._persistence_path = path or None
        if path:
            self._load_persisted()

    def rename(self, player_name: str, new_display_name: str) -> bool:
        """Set the friendly display name shown in the UI. Persists to disk."""
        new_label = (new_display_name or "").strip()
        with self._lock:
            p = self._players.get(player_name)
            if p is None:
                return False
            p.display_name = new_label or None
            # Manual rename pins the label against later stream-supplied names.
            # Clearing the label releases the pin so stream updates can resume.
            p.display_name_is_manual = bool(new_label)
        self._save_persisted()
        return True

    def apply_stream_identity(
        self,
        source_ip: str,
        ssrc: Optional[int],
        display_name: Optional[str] = None,
        ma_player_id: Optional[str] = None,
    ) -> bool:
        """
        Update a player's display_name / MA player id from data carried in
        the stream (e.g. an RTP header extension).

        Does nothing if no player matches ``(source_ip, ssrc)`` — the caller
        must have already resolved / auto-created the player via ``resolve``.
        A manual UI rename is preserved; stream names only fill gaps.

        Returns True when any field changed (so the caller can log).
        """
        display = (display_name or "").strip() or None
        ma_id = (ma_player_id or "").strip() or None
        if display is None and ma_id is None:
            return False

        changed = False
        with self._lock:
            learned = self._learned.get((source_ip, ssrc))
            if learned is None:
                return False
            pname, _ = learned
            p = self._players.get(pname)
            if p is None:
                return False

            if display and not p.display_name_is_manual and p.display_name != display:
                p.display_name = display
                changed = True
            if ma_id and p.music_assistant_player_id != ma_id:
                p.music_assistant_player_id = ma_id
                changed = True

        if changed:
            self._save_persisted()
        return changed

    def _load_persisted(self) -> None:
        path = self._persistence_path
        if not path or not os.path.exists(path):
            return
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f) or {}
        except Exception as exc:
            logger.debug(f"Could not read persisted players ({path}): {exc}")
            return
        auto_players = data.get("auto_players") or []
        counter = int(data.get("auto_counter") or 0)
        renames = data.get("display_names") or {}
        manual_renames = set(data.get("manual_renames") or [])
        with self._lock:
            for entry in auto_players:
                name = (entry.get("name") or "").strip()
                if not name or name in self._players:
                    continue
                self._players[name] = PlayerConfig(
                    name=name,
                    source_ip=entry.get("source_ip") or None,
                    rtp_ssrc=entry.get("rtp_ssrc"),
                    music_assistant_player_id=entry.get("music_assistant_player_id") or None,
                    description=entry.get("description") or None,
                    auto=True,
                    display_name=entry.get("display_name") or None,
                    display_name_is_manual=bool(entry.get("display_name_is_manual")),
                )
            if counter > self._auto_counter:
                self._auto_counter = counter
            for name, label in renames.items():
                p = self._players.get(name)
                if p is not None and label:
                    p.display_name = str(label)
                    if name in manual_renames:
                        p.display_name_is_manual = True
        logger.info(
            f"Player registry restored from {path}: "
            f"{len(auto_players)} auto-players, {len(renames)} renames"
        )

    def _save_persisted(self) -> None:
        path = self._persistence_path
        if not path:
            return
        with self._lock:
            auto_players = [
                {
                    "name": p.name,
                    "source_ip": p.source_ip,
                    "rtp_ssrc": p.rtp_ssrc,
                    "music_assistant_player_id": p.music_assistant_player_id,
                    "description": p.description,
                    "display_name": p.display_name,
                    "display_name_is_manual": p.display_name_is_manual,
                }
                for p in self._players.values()
                if p.auto
            ]
            renames = {
                p.name: p.display_name
                for p in self._players.values()
                if p.display_name
            }
            manual_renames = [
                p.name
                for p in self._players.values()
                if p.display_name_is_manual
            ]
            data = {
                "auto_counter": self._auto_counter,
                "auto_players": auto_players,
                "display_names": renames,
                "manual_renames": manual_renames,
            }
        try:
            tmp = f"{path}.tmp"
            os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2)
            os.replace(tmp, path)
        except Exception as exc:
            logger.debug(f"Could not persist players to {path}: {exc}")

    def set_music_assistant_player(self, player_name: str, ma_player_id: Optional[str]) -> bool:
        """Bind an MA player_id to one of our logical players (for MA-derived names)."""
        with self._lock:
            p = self._players.get(player_name)
            if p is None:
                return False
            p.music_assistant_player_id = (ma_player_id or None)
        self._save_persisted()
        return True

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
        new_player: Optional[PlayerConfig] = None

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

            # Explicit filter match (SSRC wins over IP).
            #
            # IP-only matching must skip players that are pinned to a
            # *different* SSRC: a single host (e.g. Music Assistant) may
            # emit several independent RTP sessions from the same source
            # IP, one per speaker group. Treating them as the same player
            # would make the per-player jitter buffer flip between SSRCs
            # and trash both streams.
            by_ssrc = None
            by_ip = None
            unfiltered: List[PlayerConfig] = []
            for p in self._players.values():
                if p.rtp_ssrc is not None and ssrc is not None and p.rtp_ssrc == ssrc:
                    by_ssrc = p
                    break
                if p.source_ip and p.source_ip == source_ip:
                    if (
                        p.rtp_ssrc is not None
                        and ssrc is not None
                        and p.rtp_ssrc != ssrc
                    ):
                        # Same IP but a different RTP session — let it
                        # fall through to auto-create / unassigned.
                        continue
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

            # UX-first auto-create: if no configured players match, spin up a
            # new auto-player for this source so the user never has to edit
            # YAML. Display name falls back to the source IP until an MA
            # resolver or a manual rename fills it in.
            if self._auto_create_players:
                self._auto_counter += 1
                name = f"{AUTO_PLAYER_PREFIX}{self._auto_counter}"
                while name in self._players:
                    self._auto_counter += 1
                    name = f"{AUTO_PLAYER_PREFIX}{self._auto_counter}"
                new_player = PlayerConfig(
                    name=name,
                    source_ip=source_ip,
                    rtp_ssrc=ssrc,
                    auto=True,
                    display_name=source_ip,
                )
                self._players[name] = new_player
                self._bind_locked(key, name, now)
                logger.info(
                    f"Auto-created player '{name}' for {source_ip}:{source_port} "
                    f"(SSRC={'0x%08X' % ssrc if ssrc is not None else 'n/a'})"
                )

            # Fallback: if there's exactly one player total (including auto), use it.
            elif len(self._players) == 1:
                only = next(iter(self._players.values()))
                self._bind_locked(key, only.name, now)
                return only.name
            else:
                # Otherwise unassigned — leave in _streams for UI and return None.
                return None

        # Notify + persist outside the lock (listeners may take their own locks).
        if new_player is not None:
            self._save_persisted()
            self._notify_player_added(new_player)
            return new_player.name
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
