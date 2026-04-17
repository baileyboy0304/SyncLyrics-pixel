"""
UDP Audio Capture Module

Receives PCM audio over UDP for fingerprinting, with optional RTP support.
Designed for Home Assistant integration where audio is streamed
from an external source (e.g., ESPHome, snapcast, or other HA audio pipeline).

Supported formats:
  - Raw PCM: 16kHz, 16-bit signed little-endian, mono (legacy)
  - RTP-encapsulated PCM: auto-detected via RTP version field

When RTP is detected, packets are reordered via a small jitter buffer and
lost packets are replaced with silence so the recogniser receives a coherent
stream with correct timing.

Multi-instance support:
  A single listener socket multiplexes traffic from multiple senders. Each
  (source IP, SSRC) pair is resolved to a "player" via the player registry;
  each player has its own jitter buffer and rolling PCM buffer so several
  RecognitionEngine instances can run in parallel over one UDP port.
"""

import asyncio
import struct
import time
from typing import Dict, Optional, Tuple

import numpy as np

from logging_config import get_logger
from .capture import AudioChunk
from .player_registry import PlayerRegistry, get_registry

logger = get_logger(__name__)

# Rolling buffer limit (seconds of audio to retain)
MAX_BUFFER_SECONDS = 30

# RTP constants
RTP_VERSION = 2
RTP_HEADER_MIN_SIZE = 12  # bytes (V/P/X/CC, M/PT, seq, ts, SSRC)

# Jitter buffer defaults
DEFAULT_JITTER_BUFFER_MS = 60  # milliseconds of buffering for reorder
MAX_JITTER_BUFFER_PACKETS = 50  # safety cap


class RtpPacket:
    """Parsed RTP packet."""

    __slots__ = ('version', 'padding', 'extension', 'cc', 'marker',
                 'payload_type', 'sequence', 'timestamp', 'ssrc', 'payload')

    def __init__(self, data: bytes):
        if len(data) < RTP_HEADER_MIN_SIZE:
            raise ValueError("Packet too short for RTP header")

        byte0, byte1 = data[0], data[1]
        self.version = (byte0 >> 6) & 0x03
        if self.version != RTP_VERSION:
            raise ValueError(f"Not an RTP packet (version={self.version})")

        self.padding = bool((byte0 >> 5) & 0x01)
        self.extension = bool((byte0 >> 4) & 0x01)
        self.cc = byte0 & 0x0F
        self.marker = bool((byte1 >> 7) & 0x01)
        self.payload_type = byte1 & 0x7F

        self.sequence, self.timestamp, self.ssrc = struct.unpack_from(
            '!HII', data, 2
        )

        # Skip CSRC list (4 bytes each)
        header_len = RTP_HEADER_MIN_SIZE + self.cc * 4

        # Skip extension header if present
        if self.extension and len(data) >= header_len + 4:
            ext_len = struct.unpack_from('!HH', data, header_len)[1]
            header_len += 4 + ext_len * 4

        # Handle padding
        payload_end = len(data)
        if self.padding and payload_end > header_len:
            pad_len = data[-1]
            payload_end -= pad_len

        self.payload = data[header_len:payload_end]


def _seq_distance(a: int, b: int) -> int:
    """Signed distance from sequence *a* to *b*, handling 16-bit wrap."""
    diff = (b - a) & 0xFFFF
    if diff >= 0x8000:
        return diff - 0x10000  # negative: b is behind a
    return diff


class JitterBuffer:
    """
    Small reorder buffer that emits packets in sequence-number order.

    Lost packets are detected when their slot is skipped and the buffer
    deadline expires.  The caller is told how many packets were lost so
    it can insert equivalent silence.
    """

    def __init__(self, max_packets: int, sample_rate: int,
                 frame_size: int):
        self._max_packets = max_packets
        self._sample_rate = sample_rate
        self._frame_size = frame_size  # bytes per sample-frame

        # Packets waiting to be emitted, keyed by sequence number
        self._pending: dict[int, RtpPacket] = {}
        self._next_seq: Optional[int] = None
        self._samples_per_packet: Optional[int] = None
        self._initialized = False

    def reset(self) -> None:
        self._pending.clear()
        self._next_seq = None
        self._samples_per_packet = None
        self._initialized = False

    def push(self, pkt: RtpPacket) -> list[tuple[Optional[bytes], int]]:
        """
        Insert a packet and return a (possibly empty) list of
        ``(payload_or_None, lost_count)`` tuples ready for consumption.

        * ``payload`` is the PCM bytes for one packet, or ``None`` if
          that slot was lost (in which case ``lost_count`` tells how
          many consecutive packets were lost *before* this payload).
        * Results are returned in strict sequence order.
        """
        if not self._initialized:
            self._next_seq = pkt.sequence
            self._samples_per_packet = len(pkt.payload) // self._frame_size
            self._initialized = True
            logger.info(
                f"RTP jitter buffer initialised: seq={pkt.sequence}, "
                f"samples/pkt={self._samples_per_packet}, "
                f"PT={pkt.payload_type}, SSRC=0x{pkt.ssrc:08X}"
            )

        dist = _seq_distance(self._next_seq, pkt.sequence)

        # Too old — already emitted
        if dist < 0:
            return []

        # Duplicate
        if pkt.sequence in self._pending:
            return []

        self._pending[pkt.sequence] = pkt

        # Emit as many consecutive packets as possible
        return self._drain()

    def flush_stale(self, max_gap: int) -> list[tuple[Optional[bytes], int]]:
        """
        Force-emit if the buffer has grown too large (sender burst or
        sustained loss).  ``max_gap`` is the maximum number of missing
        packets we'll tolerate before flushing.
        """
        if not self._initialized or not self._pending:
            return []

        # Find the smallest seq in pending
        min_seq = min(self._pending, key=lambda s: _seq_distance(self._next_seq, s))
        gap = _seq_distance(self._next_seq, min_seq)
        if gap > max_gap:
            # Skip ahead — declare everything in between as lost
            return self._skip_to(min_seq)
        return []

    # ------------------------------------------------------------------

    def _drain(self) -> list[tuple[Optional[bytes], int]]:
        results: list[tuple[Optional[bytes], int]] = []

        while True:
            seq = self._next_seq & 0xFFFF
            if seq in self._pending:
                pkt = self._pending.pop(seq)
                results.append((pkt.payload, 0))
                self._next_seq = (self._next_seq + 1) & 0xFFFF
            elif len(self._pending) >= self._max_packets:
                # Buffer full — skip missing packet (declare lost)
                results.extend(self._skip_missing())
            else:
                break

        return results

    def _skip_missing(self) -> list[tuple[Optional[bytes], int]]:
        """Skip past missing packets until we hit one we have."""
        if not self._pending:
            return []

        # Find next packet we actually have
        target = min(self._pending,
                     key=lambda s: _seq_distance(self._next_seq, s))
        return self._skip_to(target)

    def _skip_to(self, target_seq: int) -> list[tuple[Optional[bytes], int]]:
        """Advance _next_seq to target_seq, emitting loss + found packet."""
        lost = _seq_distance(self._next_seq, target_seq)
        if lost <= 0:
            return []

        results: list[tuple[Optional[bytes], int]] = []

        # Report the lost packets
        logger.debug(f"RTP: {lost} packet(s) lost (seq {self._next_seq}-"
                     f"{(self._next_seq + lost - 1) & 0xFFFF})")
        results.append((None, lost))

        # Advance past the gap
        self._next_seq = target_seq & 0xFFFF

        # Now drain any consecutive packets starting at target
        while True:
            seq = self._next_seq & 0xFFFF
            if seq in self._pending:
                pkt = self._pending.pop(seq)
                results.append((pkt.payload, 0))
                self._next_seq = (self._next_seq + 1) & 0xFFFF
            else:
                break

        return results

    @property
    def samples_per_packet(self) -> Optional[int]:
        return self._samples_per_packet


class _PlayerStream:
    """
    Per-player state: one jitter buffer and one rolling PCM buffer.

    Each configured player gets its own instance, created lazily on first
    packet. ``get_audio()`` is awaited by the RecognitionEngine bound to
    this player.
    """

    def __init__(self, name: str, sample_rate: int, frame_size: int,
                 jitter_buffer_ms: int):
        self.name = name
        self._sample_rate = sample_rate
        self._frame_size = frame_size
        self._jitter_buffer_ms = jitter_buffer_ms
        self._max_bytes = int(MAX_BUFFER_SECONDS * sample_rate * frame_size)

        self._buffer = bytearray()
        self._total_bytes_received = 0
        self._last_read_total = 0
        self._last_data_time = 0.0

        self._jitter_buffer: Optional[JitterBuffer] = None
        self._rtp_detected: Optional[bool] = None

        self._packets_received = 0
        self._packets_lost = 0

        self._data_event = asyncio.Event()

    @property
    def buffer_seconds(self) -> float:
        return len(self._buffer) / (self._sample_rate * self._frame_size)

    @property
    def has_recent_data(self) -> bool:
        return self._last_data_time > 0 and (time.time() - self._last_data_time) < 10.0

    @property
    def packet_loss_rate(self) -> float:
        total = self._packets_received + self._packets_lost
        return (self._packets_lost / total) if total else 0.0

    def reset(self) -> None:
        self._buffer.clear()
        self._total_bytes_received = 0
        self._last_read_total = 0
        self._rtp_detected = None
        if self._jitter_buffer:
            self._jitter_buffer.reset()
            self._jitter_buffer = None
        self._packets_received = 0
        self._packets_lost = 0
        self._data_event.set()

    # -- Ingest -------------------------------------------------------

    def handle_packet(self, data: bytes, is_rtp: bool) -> None:
        if is_rtp:
            if self._jitter_buffer is None:
                self._init_jitter_buffer(data)
            self._handle_rtp(data)
        else:
            self._append(data)
            self._packets_received += 1

    def _init_jitter_buffer(self, data: bytes) -> None:
        try:
            pkt = RtpPacket(data)
            payload_samples = len(pkt.payload) // self._frame_size
            if payload_samples > 0:
                packet_duration_ms = (payload_samples / self._sample_rate) * 1000
                max_pkts = max(2, int(self._jitter_buffer_ms / packet_duration_ms))
                max_pkts = min(max_pkts, MAX_JITTER_BUFFER_PACKETS)
            else:
                max_pkts = 5
        except (ValueError, ZeroDivisionError):
            max_pkts = 5

        self._jitter_buffer = JitterBuffer(
            max_packets=max_pkts,
            sample_rate=self._sample_rate,
            frame_size=self._frame_size,
        )
        self._rtp_detected = True
        # Remember the first packet's RTP timestamp + wallclock so we can
        # sanity-check the sender's sample rate against our configured one.
        # A common failure mode is a sender running at 48 kHz while the
        # addon is configured for 16 kHz — the raw PCM decodes, but at the
        # wrong rate so Shazam never matches.
        self._first_rtp_ts: Optional[int] = getattr(pkt, 'timestamp', None)
        self._first_rtp_wall: float = time.time()
        self._sr_check_done: bool = False
        logger.info(
            f"Player '{self.name}': RTP jitter buffer holds up to {max_pkts} packets"
        )

    def _handle_rtp(self, data: bytes) -> None:
        try:
            pkt = RtpPacket(data)
        except ValueError as exc:
            logger.debug(f"RTP parse error on player '{self.name}': {exc}")
            return

        self._packets_received += 1

        # After ~3 seconds of wall-clock, compare RTP timestamp advance to
        # the configured sample rate. A big mismatch means the sender is
        # running at a different rate than this addon expects — log a loud
        # warning so the user can see it.
        if (not self._sr_check_done and self._first_rtp_ts is not None
                and self._packets_received > 10):
            elapsed = time.time() - self._first_rtp_wall
            if elapsed >= 3.0:
                ts_delta = (pkt.timestamp - self._first_rtp_ts) & 0xFFFFFFFF
                if ts_delta > 0:
                    observed_rate = ts_delta / elapsed
                    ratio = observed_rate / self._sample_rate
                    logger.info(
                        f"Player '{self.name}': RTP clock check — "
                        f"configured {self._sample_rate} Hz, "
                        f"observed {observed_rate:.0f} Hz "
                        f"({ratio:.2f}x) over {elapsed:.1f}s"
                    )
                    if ratio < 0.8 or ratio > 1.25:
                        logger.warning(
                            f"Player '{self.name}': sender sample rate "
                            f"({observed_rate:.0f} Hz) doesn't match configured "
                            f"{self._sample_rate} Hz — Shazam will not match. "
                            f"Set udp_audio_sample_rate to {int(round(observed_rate))} "
                            f"in the addon config."
                        )
                self._sr_check_done = True
        results = self._jitter_buffer.push(pkt)
        if not results:
            results = self._jitter_buffer.flush_stale(
                max_gap=self._jitter_buffer._max_packets * 2
            )

        for payload, lost_count in results:
            if lost_count > 0:
                self._packets_lost += lost_count
                samples_per_pkt = self._jitter_buffer.samples_per_packet or 160
                silence_bytes = lost_count * samples_per_pkt * self._frame_size
                self._append(b'\x00' * silence_bytes)
                logger.debug(
                    f"Player '{self.name}': inserted {lost_count * samples_per_pkt} "
                    f"silence samples for {lost_count} lost packet(s)"
                )
            if payload is not None:
                self._append(payload)

    def _append(self, data: bytes) -> None:
        self._buffer.extend(data)
        self._total_bytes_received += len(data)
        self._last_data_time = time.time()

        if len(self._buffer) > self._max_bytes:
            excess = len(self._buffer) - self._max_bytes
            del self._buffer[:excess]

        self._data_event.set()

    # -- Consume ------------------------------------------------------

    async def get_audio(
        self,
        duration: float,
        channels: int,
        should_continue,
    ) -> Optional[AudioChunk]:
        needed_bytes = int(duration * self._sample_rate * self._frame_size)
        while should_continue():
            new_bytes = self._total_bytes_received - self._last_read_total
            if new_bytes >= needed_bytes and len(self._buffer) >= needed_bytes:
                break
            self._data_event.clear()
            try:
                await asyncio.wait_for(self._data_event.wait(), timeout=1.0)
            except asyncio.TimeoutError:
                if not should_continue():
                    return None
                if self._last_data_time > 0 and (time.time() - self._last_data_time) > 10.0:
                    logger.debug(
                        f"Player '{self.name}': UDP stream appears dead (no data for 10s)"
                    )
                    return None

        if not should_continue():
            return None

        self._last_read_total = self._total_bytes_received
        audio_bytes = bytes(self._buffer[-needed_bytes:])
        audio_data = np.frombuffer(audio_bytes, dtype=np.int16)
        if channels > 1:
            audio_data = audio_data.reshape(-1, channels)

        capture_start = self._last_data_time - duration
        return AudioChunk(
            data=audio_data,
            sample_rate=self._sample_rate,
            channels=channels,
            duration=duration,
            capture_start_time=capture_start,
        )

    def to_status_dict(self) -> dict:
        return {
            "name": self.name,
            "buffer_seconds": round(self.buffer_seconds, 2),
            "packets_received": self._packets_received,
            "packets_lost": self._packets_lost,
            "packet_loss_rate": round(self.packet_loss_rate, 4),
            "rtp_active": self._rtp_detected is True,
            "last_data_age": (time.time() - self._last_data_time) if self._last_data_time else None,
        }


class UdpAudioProtocol(asyncio.DatagramProtocol):
    """asyncio datagram protocol that forwards received data to the capture buffer."""

    def __init__(self, capture: 'UdpAudioCapture'):
        self._capture = capture

    def datagram_received(self, data: bytes, addr: tuple) -> None:
        self._capture.receive_data(data, addr)

    def error_received(self, exc: Exception) -> None:
        logger.warning(f"UDP audio socket error: {exc}")

    def connection_lost(self, exc: Optional[Exception]) -> None:
        if exc:
            logger.warning(f"UDP audio connection lost: {exc}")


class UdpAudioCapture:
    """
    Receives PCM audio over UDP (raw or RTP-encapsulated) and provides
    AudioChunks for one or more recognition engines, demuxed per player.

    Packet routing:
      * RTP packets are parsed for SSRC and forwarded to the player registry
        for binding. Raw PCM falls back to (source_ip, None).
      * If the registry returns a player name, the packet is appended to
        that player's jitter / rolling buffer. Unassigned packets are
        dropped (with the stream recorded for discovery).
    """

    def __init__(self, port: int = 6056, sample_rate: int = 16000,
                 channels: int = 1,
                 jitter_buffer_ms: int = DEFAULT_JITTER_BUFFER_MS,
                 registry: Optional[PlayerRegistry] = None):
        self._port = port
        self._sample_rate = sample_rate
        self._channels = channels
        self._bytes_per_sample = 2  # int16
        self._frame_size = self._bytes_per_sample * self._channels
        self._jitter_buffer_ms = jitter_buffer_ms

        self._registry = registry or get_registry()
        self._streams: Dict[str, _PlayerStream] = {}
        self._streams_lock = asyncio.Lock()  # guards _streams mutation (rarely contended)

        self._transport: Optional[asyncio.DatagramTransport] = None
        self._running = False
        self._dropped_unassigned = 0
        self._last_unassigned_log = 0.0

    # ------------------------------------------------------------------
    # Properties — aggregate across all player streams for legacy callers

    @property
    def is_running(self) -> bool:
        return self._running

    @property
    def has_data(self) -> bool:
        return any(s.has_recent_data for s in self._streams.values())

    @property
    def buffer_seconds(self) -> float:
        if not self._streams:
            return 0.0
        return max((s.buffer_seconds for s in self._streams.values()), default=0.0)

    @property
    def rtp_active(self) -> bool:
        return any(s._rtp_detected is True for s in self._streams.values())

    @property
    def packet_loss_rate(self) -> float:
        total_recv = sum(s._packets_received for s in self._streams.values())
        total_lost = sum(s._packets_lost for s in self._streams.values())
        total = total_recv + total_lost
        return (total_lost / total) if total else 0.0

    def list_streams(self) -> list[dict]:
        return [s.to_status_dict() for s in self._streams.values()]

    # ------------------------------------------------------------------
    # Lifecycle

    async def start(self) -> None:
        if self._running:
            return
        loop = asyncio.get_running_loop()
        self._transport, _ = await loop.create_datagram_endpoint(
            lambda: UdpAudioProtocol(self),
            local_addr=('0.0.0.0', self._port),
        )
        self._running = True
        logger.info(
            f"UDP audio listener started on port {self._port} "
            f"({self._sample_rate}Hz, {self._channels}ch, 16-bit, "
            f"RTP auto-detect, jitter buffer {self._jitter_buffer_ms}ms, "
            f"multi-player demux enabled)"
        )

    async def stop(self) -> None:
        if self._transport:
            self._transport.close()
            self._transport = None
        self._running = False
        for stream in self._streams.values():
            stream.reset()
        self._streams.clear()
        logger.info("UDP audio listener stopped")

    # ------------------------------------------------------------------
    # Packet routing (called from the datagram protocol)

    def receive_data(self, data: bytes, addr: Tuple[str, int]) -> None:
        source_ip, source_port = addr[0], addr[1]

        # Peek RTP header (if any) without mutating state
        is_rtp = _looks_like_rtp(data)
        ssrc: Optional[int] = None
        payload_type: Optional[int] = None
        if is_rtp:
            try:
                ssrc = struct.unpack_from('!I', data, 8)[0]
                payload_type = data[1] & 0x7F
            except (struct.error, IndexError):
                ssrc = None

        player_name = self._registry.resolve(source_ip, source_port, ssrc, payload_type)
        if player_name is None:
            self._dropped_unassigned += 1
            now = time.time()
            # Rate-limit the "unassigned" warning to once every 30s
            if now - self._last_unassigned_log > 30.0:
                logger.info(
                    f"UDP packet from {source_ip}:{source_port} "
                    f"(SSRC={'0x%08X' % ssrc if ssrc is not None else 'n/a'}) "
                    f"is unassigned — configure a player or enable auto-discover. "
                    f"Total dropped: {self._dropped_unassigned}"
                )
                self._last_unassigned_log = now
            return

        stream = self._streams.get(player_name)
        if stream is None:
            stream = _PlayerStream(
                name=player_name,
                sample_rate=self._sample_rate,
                frame_size=self._frame_size,
                jitter_buffer_ms=self._jitter_buffer_ms,
            )
            self._streams[player_name] = stream
            logger.info(
                f"Player stream created: '{player_name}' "
                f"(first packet from {source_ip}:{source_port})"
            )

        stream.handle_packet(data, is_rtp)

    # ------------------------------------------------------------------
    # Consumer API

    async def get_audio(self, duration: float,
                         player_name: Optional[str] = None) -> Optional[AudioChunk]:
        """
        Return ``duration`` seconds of fresh audio for the given player.

        Legacy callers that omit ``player_name`` get the default player
        (first known stream, or the registry-provided default).
        """
        target = player_name or self._default_player_name()
        if target is None:
            return None

        stream = self._streams.get(target)
        if stream is None:
            # No packets seen for this player yet — block briefly to see if
            # they arrive. We register an empty stream so receive_data() can
            # populate it as soon as the first packet lands.
            stream = _PlayerStream(
                name=target,
                sample_rate=self._sample_rate,
                frame_size=self._frame_size,
                jitter_buffer_ms=self._jitter_buffer_ms,
            )
            self._streams[target] = stream

        return await stream.get_audio(
            duration=duration,
            channels=self._channels,
            should_continue=lambda: self._running,
        )

    def _default_player_name(self) -> Optional[str]:
        if self._streams:
            return next(iter(self._streams.keys()))
        players = self._registry.list_players()
        if not players:
            default = self._registry.ensure_default_player()
            return default.name
        return players[0].name


def _looks_like_rtp(data: bytes) -> bool:
    """Cheap header-only RTP heuristic used for routing decisions."""
    if len(data) < RTP_HEADER_MIN_SIZE:
        return False
    if ((data[0] >> 6) & 0x03) != RTP_VERSION:
        return False
    pt = data[1] & 0x7F
    if pt > 127:
        return False
    cc = data[0] & 0x0F
    header_len = RTP_HEADER_MIN_SIZE + cc * 4
    if len(data) <= header_len:
        return False
    return True
