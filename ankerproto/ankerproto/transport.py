"""In-memory transports: replay, capture and loopback.

Useful for developing against the protocol without a device, and for turning a
real session into a regression fixture.

``ReplayTransport`` feeds a scripted list of device responses, so the whole
handshake can be exercised in CI. ``RecordingTransport`` wraps a real transport
and writes every byte in both directions to a file that ``ReplayTransport`` can
later consume.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Iterable, Iterator

from .session import Transport

__all__ = ["ReplayTransport", "RecordingTransport", "LoopbackTransport"]


class ReplayTransport:
    """Serve canned inbound bytes; record what the client writes.

    >>> t = ReplayTransport([b"\\xff\\x09\\x06\\x00\\x03\\x00\\x01\\x08\\x01\\x00\\x00"])
    >>> t.receive()
    b'\\xff\\x09\\x06\\x00\\x03\\x00\\x01\\x08\\x01\\x00\\x00'
    """

    def __init__(self, responses: Iterable[bytes] = ()) -> None:
        self._responses = list(responses)
        self.sent: list[bytes] = []

    def send(self, data: bytes) -> None:
        self.sent.append(bytes(data))

    def receive(self, timeout: float = 2.0) -> bytes:
        if not self._responses:
            raise TimeoutError("replay exhausted")
        return self._responses.pop(0)

    # -- persistence ----------------------------------------------------
    def save(self, path: str | Path) -> None:
        Path(path).write_text(
            json.dumps({"responses": [r.hex() for r in self._responses]}, indent=2)
        )

    @classmethod
    def load(cls, path: str | Path) -> "ReplayTransport":
        data = json.loads(Path(path).read_text())
        return cls(bytes.fromhex(h) for h in data["responses"])


class RecordingTransport:
    """Wrap a transport and record the full duplex byte stream to JSON."""

    def __init__(self, inner: Transport) -> None:
        self.inner = inner
        self.log: list[dict[str, str]] = []

    def send(self, data: bytes) -> None:
        self.log.append({"dir": "tx", "hex": bytes(data).hex()})
        self.inner.send(data)

    def receive(self, timeout: float = 2.0) -> bytes:
        data = self.inner.receive(timeout)
        self.log.append({"dir": "rx", "hex": bytes(data).hex()})
        return data

    def save(self, path: str | Path) -> None:
        Path(path).write_text(json.dumps(self.log, indent=2))

    def device_frames(self) -> Iterator[bytes]:
        """The inbound frames only, in order - a ready-made replay script."""
        for entry in self.log:
            if entry["dir"] == "rx":
                yield bytes.fromhex(entry["hex"])


class LoopbackTransport:
    """Echo every write back as a response frame (protocol smoke tests)."""

    def __init__(self) -> None:
        self._queue: list[bytes] = []

    def send(self, data: bytes) -> None:
        self._queue.append(bytes(data))

    def receive(self, timeout: float = 2.0) -> bytes:
        if not self._queue:
            raise TimeoutError("loopback empty")
        return self._queue.pop(0)
