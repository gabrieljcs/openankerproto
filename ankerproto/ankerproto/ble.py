"""BLE transport built on ``bleak`` (cross-platform: macOS, Linux, Windows).

Install with ``pip install ankerproto[ble]``.

The Anker GATT layout is a single service with one write and one notify
characteristic (see :mod:`ankerproto.uuids`). Writes are
*without response*; responses arrive as notifications, so we buffer them in a
queue and let :class:`~ankerproto.session.AnkerSession` pull frames.
"""

from __future__ import annotations

import asyncio
import logging
import queue
import threading
from typing import Any, Iterable

from .uuids import PRIMARY_FAMILY, UUID_FAMILIES, UuidFamily

log = logging.getLogger("ankerproto.ble")

__all__ = ["BleTransport", "scan"]

try:  # pragma: no cover - optional dependency
    from bleak import BleakClient, BleakScanner
    from bleak.exc import BleakError

    _HAVE_BLEAK = True
except ImportError:  # pragma: no cover
    BleakClient = None  # type: ignore[assignment]
    BleakScanner = None  # type: ignore[assignment]
    BleakError = Exception  # type: ignore[assignment,misc]
    _HAVE_BLEAK = False


async def scan(
    timeout: float = 8.0,
    families: Iterable[UuidFamily] = UUID_FAMILIES,
) -> list[dict[str, Any]]:
    """Scan for advertising Anker devices, matching any known service family."""
    _require_bleak()
    wanted = {f.service.lower() for f in families}
    wanted_16 = {0x2215, 0x2540, 0xFF09, 0xEF0A, 0xEF0B}

    found: list[dict[str, Any]] = []
    devices = await BleakScanner.discover(timeout=timeout, return_adv=True)
    for device, adv in devices.values():
        uuids = {u.lower() for u in (adv.service_uuids or [])}
        match = bool(uuids & wanted)
        if not match:
            for u in uuids:
                tail = u.split("-")[0]
                if len(tail) == 8:
                    try:
                        if int(tail, 16) in wanted_16:
                            match = True
                            break
                    except ValueError:
                        pass
        if match:
            found.append(
                {
                    "address": device.address,
                    "name": device.name or adv.local_name,
                    "rssi": adv.rssi,
                    "service_uuids": sorted(uuids),
                }
            )
    return found


def _require_bleak() -> None:
    if not _HAVE_BLEAK:
        raise RuntimeError(
            "bleak is required for BLE access: pip install 'ankerproto[ble]'"
        )


class BleTransport:
    """Blocking, thread-backed BLE transport.

    The public API (:meth:`send`/:meth:`receive`/:meth:`close`) is synchronous so
    that :class:`~ankerproto.session.AnkerSession` stays simple and testable. A
    private asyncio loop runs on a daemon thread and owns the ``BleakClient``.
    """

    def __init__(
        self,
        family: UuidFamily = PRIMARY_FAMILY,
        *,
        address: str | None = None,
        name_hint: str | None = None,
        scan_timeout: float = 8.0,
        connect_timeout: float = 20.0,
    ) -> None:
        _require_bleak()
        self.family = family
        self.address = address
        self.name_hint = name_hint
        self.scan_timeout = scan_timeout
        self.connect_timeout = connect_timeout

        self._loop: asyncio.AbstractEventLoop | None = None
        self._thread: threading.Thread | None = None
        self._client: Any = None
        self._incoming: "queue.Queue[bytes]" = queue.Queue()
        self._ready = threading.Event()
        self._error: BaseException | None = None

    # -- lifecycle ------------------------------------------------------
    def __enter__(self) -> "BleTransport":
        self.connect()
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def connect(self) -> None:
        self._thread = threading.Thread(target=self._run_loop, daemon=True)
        self._thread.start()
        if not self._ready.wait(self.connect_timeout + self.scan_timeout):
            raise TimeoutError("BLE connection did not complete in time")
        if self._error is not None:
            raise self._error

    def _run_loop(self) -> None:
        self._loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self._loop)
        try:
            self._loop.run_until_complete(self._connect())
        except BaseException as exc:  # noqa: BLE001 - surfaced to caller
            self._error = exc
            self._ready.set()
            return
        self._ready.set()
        self._loop.run_forever()

    async def _connect(self) -> None:
        address = self.address
        if address is None:
            log.info("scanning for an Anker device (%s)...", self.family.name)
            candidates = await scan(self.scan_timeout, [self.family])
            if not candidates:
                raise RuntimeError(
                    "no Anker device found; pass address= explicitly or make sure "
                    "the device is awake and advertising"
                )
            if self.name_hint:
                for c in candidates:
                    if self.name_hint.lower() in (c["name"] or "").lower():
                        address = c["address"]
                        break
            address = address or candidates[0]["address"]
            log.info("using %s (%s)", address, candidates[0]["name"])

        self.address = address
        self._client = BleakClient(address, timeout=self.connect_timeout)
        await self._client.connect()
        log.info("connected to %s", address)
        await self._client.start_notify(self.family.notify, self._on_notify)

    def _on_notify(self, _sender: Any, data: bytearray) -> None:
        self._incoming.put(bytes(data))

    def close(self) -> None:
        client = self._client
        loop = self._loop
        if client is not None and loop is not None and loop.is_running():
            try:
                asyncio.run_coroutine_threadsafe(client.disconnect(), loop).result(5)
            except Exception:  # noqa: BLE001 - best effort teardown
                pass
        if loop is not None:
            loop.call_soon_threadsafe(loop.stop)
        if self._thread is not None:
            self._thread.join(timeout=5)

    # -- Transport protocol ---------------------------------------------
    def send(self, data: bytes) -> None:
        if self._client is None or self._loop is None:
            raise RuntimeError("transport is not connected")
        self._loop.run_until_complete(
            self._client.write_gatt_char(self.family.write, data, response=False)
        )

    def receive(self, timeout: float = 2.0) -> bytes:
        try:
            return self._incoming.get(timeout=timeout)
        except queue.Empty as exc:
            raise TimeoutError("no BLE notification received") from exc

    def drain(self) -> list[bytes]:
        """Return every buffered notification without blocking."""
        out = []
        while True:
            try:
                out.append(self._incoming.get_nowait())
            except queue.Empty:
                return out
