# Known device models

The registry the web client matches against, extracted from the Anker app
binary by `scripts/generate_models.py`. **Generated — do not edit by hand.**

```bash
python3 scripts/generate_models.py     # rewrites web/src/models.js
python3 scripts/extract_assets.py      # extracts the product imagery
```

## Provenance

| Data | Source | Confidence |
|---|---|---|
| SKU, name, service UUID | A device registry table in the app's Dart AOT object pool | **From the binary** |
| Port layout | The app's per-port indicator artwork, one image per connector (`a1340_c1_*.png`, `imgl_usb_A2345_black_normal_*.png`) | **Confirmed** where such artwork exists |
| Connector type | Inferred from the port token (C = USB-C, A = USB-A) | Inferred |
| Form factor | Largest product render's pixel dimensions | **Measured** |
| Demo layout | Confirmed layout where known, else synthesised from the form factor | Flagged in the UI |
| `A1790B` excluded | Parses as a SKU but is a debug string (`a1790CanUpdate------`) | Not a product |

Where a model has no per-port artwork the registry stays silent about its ports
and the UI follows what the device reports — an invented layout would draw
hardware that does not exist.

## Demo mode

`demoable` marks models that can be simulated; components (microinverters,
expansion modules, backup controller) are excluded as they are not devices you
would connect to from this client.

**7 models are demo-able:**

| SKU | Name | Ports | Layout | Form factor |
|---|---|---|---|---|
| `A1340` | Prime Power Bank | C1, C2, P, A | **confirmed** | 0.481 |
| `A1753` | SOLIX C800 | C1, C2, A, AC | synthesised | 1.0 |
| `A1763` | SOLIX C1000X Gen 2 | AC | **confirmed** | 1.429 |
| `A1782` | SOLIX F3000 | C1, C2, A, AC | synthesised | 1.0 |
| `A1790` | SOLIX F3800 | C1, C2, A | synthesised | 0.315 |
| `A2345` | 250W Prime Charger | C1, C2, C3, C4, A1, A2 | **confirmed** | 1.562 |
| `A5101` | Power Module | C1, C2, A, AC | synthesised | 0.893 |

### A note on the A2345

The A2345's layout was originally synthesised from its 1.56 aspect ratio as
`C1, C2, C3, A, AC`. The app's indicator artwork shows it is actually
`C1, C2, C3, C4, A1, A2` — six connectors, four USB-C and two USB-A. That is
exactly the kind of detail guessing gets wrong, and why confirmed artwork is
preferred wherever it exists.

Because the protocol exposes a fixed set of port slots, the two USB-A ports
share one slot and are disambiguated as `A` and `A2` at parse time.

## All models (32)

| SKU | Name | Confirmed ports | Demo-able | Aspect | Service UUID |
|---|---|---|---|---|---|
| `A1340` | Prime Power Bank | C1, C2, P, A | yes | 0.481 | `22150001-4002-81c5-b46e-cf057c562025` |
| `A1722` | SOLIX C300 | — | — | — | `—` |
| `A1723` | SOLIX C300X | — | — | — | `—` |
| `A1725` | SOLIX C200(X) | — | — | — | `—` |
| `A1726` | SOLIX C300 DC | — | — | — | `—` |
| `A1727` | SOLIX C200 DC | — | — | — | `—` |
| `A1728` | SOLIX C300X DC | — | — | — | `—` |
| `A1729` | SOLIX C200X DC | — | — | — | `—` |
| `A1753` | SOLIX C800 | — | yes | 1.0 | `—` |
| `A1754` | SOLIX C800 Plus | — | — | — | `—` |
| `A1755` | SOLIX C800X | — | — | — | `—` |
| `A1761` | SOLIX C1000(X) | — | — | — | `—` |
| `A1762` | Portable Power Station 1000 | — | — | — | `—` |
| `A1763` | SOLIX C1000X Gen 2 | AC | yes | 1.429 | `—` |
| `A1770` | F1200 (Bluetooth) | — | — | — | `00001770-0000-1000-8000-00805f9b34fb` |
| `A1771` | F1200 (Bluetooth and WLAN) | — | — | — | `00002540-0000-1000-8000-00805f9b34fb` |
| `A1772` | SOLIX F1500 | — | — | — | `—` |
| `A1780` | 767 PowerHouse (SOLIX F2000) | — | — | — | `00001780-0000-1000-8000-00805f9b34fb` |
| `A1780P` | 767 Power House (SOLIX F2000) with WLAN | — | — | — | `—` |
| `A1781` | SOLIX F2600 | — | — | — | `—` |
| `A1782` | SOLIX F3000 | — | yes | 1.0 | `—` |
| `A1790` | SOLIX F3800 | — | yes | 0.315 | `—` |
| `A1790P` | SOLIX F3800 Plus | — | — | — | `8c850001-0302-41c5-b46e-cf057c562025` |
| `A2345` | 250W Prime Charger | C1, C2, C3, C4, A1, A2 | yes | 1.562 | `—` |
| `A5101` | Power Module | — | yes | 0.893 | `41580001-4002-81c5-b46e-cf057c562025` |
| `A5140` | MI60 Microinverter | — | — | 0.781 | `—` |
| `A5141` | MI80 Microinverter | — | — | — | `—` |
| `A5143` | MI80 Microinverter(BLE) | — | — | — | `016df5da-0000-1000-8000-00805f9b34fb` |
| `A5150` | A5150 Module | — | — | 0.781 | `—` |
| `A5220` | Battery Module | — | — | — | `—` |
| `A5341` | Backup Controller | — | — | — | `—` |
| `A5450` | A5450 Module | — | — | — | `—` |

## Adding a model

Both files are generated. If you have a device that is not listed:

1. Connect with the web client and download the protocol log.
2. Open an issue with the log and the SKU printed on the device.

The log contains the device name, the SKU if the firmware reports one, and every
TLV the device sends — enough to add the registry entry and the port mapping.
