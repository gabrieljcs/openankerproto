# openankerproto

Connect to Anker BLE devices **from a web page** — no app, no account, no cloud,
no install. Free and open source.

This is the browser front-end. It shares its protocol implementation with the
Python reference client in [`../ankerproto/`](../ankerproto/), which also
contains the recovered [protocol specification](../ankerproto/docs/PROTOCOL.md).

---

## ⚠️ Read this first: browser support

Web Bluetooth is **not** available everywhere. This is a browser limitation, not
something this project can work around.

| Platform | Chrome | Edge | Opera | Firefox | Safari |
|---|---|---|---|---|---|
| Windows / macOS / Linux | ✅ | ✅ | ✅ | ❌ | ❌ |
| Android | ✅ | ✅ | ✅ | ❌ | ❌ |
| **iOS / iPadOS** | ❌ | ❌ | ❌ | ❌ | ❌ |

**iPhone and iPad cannot use this.** Apple does not expose Web Bluetooth to any
browser on iOS — including Chrome, which uses Safari's engine there. There is no
workaround short of a native app.

Firefox has declined to implement the API.

> A note on the approach: this uses **Web Bluetooth**, not WebAssembly.
> WASM would not help — the browser API *is* the capability, and the protocol is
> small enough to port to plain JavaScript, with `crypto.subtle` providing the
> AES. There is no build step and no dependencies.

---

## Device discovery and compatibility

This client targets Anker BLE power banks, chargers, and power stations across
the known protocol families. Compatibility varies by model and firmware;
registry entries do not mean every model has been verified on hardware.
The model artwork and demo are not proof of protocol compatibility.

If it does not appear in the browser picker:

1. Power on or wake the device, enable Bluetooth on the computer, and check
   the device’s Bluetooth setting, if available.
2. Close/disconnect the official phone app and keep the device nearby.
3. Use Chrome or Edge over localhost or HTTPS.
4. Select **Show all nearby devices**, then Connect, and choose your device.
   This removes advertisement/name filters while retaining permissions for the
   known Anker protocol services.
5. If discovery or the handshake still fails, download **Connection diagnostics**.
   Logs remain available after failures. Include browser, firmware, and model.
   Logs include device identifiers and handshake material; review before sharing.

### Chrome on macOS: empty picker

Check **System Settings → Privacy & Security → Bluetooth** and enable Chrome
if listed. If it is absent or discovery still fails, open
`chrome://bluetooth-internals`, select **Devices → Start Scan**, and allow
Bluetooth access if macOS prompts. After changing permissions, fully quit Chrome
with **⌘Q** and reopen it. Stop the diagnostic scan and retry the website with
**Show all nearby devices** selected.

If Chrome’s diagnostic scan finds devices but the website does not, Chrome can
scan, but the Anker device may not be among those results. Compare names without
assuming that every nearby device is the charger. Report whether the website’s
picker is completely empty or only missing the Anker device. System pairing
lists and the official app’s device list are not equivalent to the BLE picker.

The default picker now includes all recovered advertising IDs and every registered
model’s name prefix. GATT writes respect characteristic capabilities, notification
reassembly handles sliced DataViews, and protocol commands are serialized so
polling and settings cannot steal one another's replies.

## Running it

```bash
cd web
npm run serve          # http://127.0.0.1:8080
```

Open in **Chrome or Edge**. `127.0.0.1` is a secure context, so no certificate
is needed locally.

> **Do not open `index.html` by double-clicking it.** Over `file://` browsers
> block JavaScript modules with a CORS error, so the page renders but *every*
> button is dead — connect and demo mode alike. That failure is now detected and
> explained on the page, but the fix is simply to serve the folder. The same
> applies if you deploy `index.html` without also deploying `src/`.

Before connecting:

1. **Wake your device** — press its button; many power banks sleep when idle.
2. **Disconnect it from the official app.** Bluetooth allows one central per
   device; if the phone app holds the connection, the browser cannot connect.
3. Put it near the computer.

Then press **Connect to a device** and pick it from the browser's device picker.

### No device handy? Try demo mode

Everything interesting in the UI is hidden until a device connects, so there is a
**demo mode** that drives a simulated device through the *real* session code.

- Click **Try demo** in the header, or open the page with `?demo=1` (which
  connects immediately, so a shared demo link just works)
- **Pick which model to simulate** from the dropdown — seven Anker products, from
  the tall Prime Power Bank (aspect 0.48) to the wide 250W Prime Charger (1.56)
- A yellow banner makes it obvious nothing is real
- The handshake, AES session, framing and TLV decoding all genuinely run — only the
  device on the other end is synthetic, and the telemetry is generated so the
  numbers drift on each refresh

Link straight to a model with `?demo=1&model=A2345`. The picker labels each entry
`confirmed from the app` or `synthesised for the demo`, so you always know which
port layouts are real and which are inferred from the product's form factor.

This is the way to review the interface, check a change, or see what the tool does
before buying hardware. **Exit demo** returns to a clean state.

Demo mode is also what `npm run test:ui` asserts on, so it cannot silently
regress. It works in Safari and Firefox too, since it needs no Bluetooth at all —
useful for seeing what you would be missing.

### Screenshots

```bash
npm run screenshots        # demo mode, desktop + narrow viewports
```

Writes PNGs to `screenshots/` — handy for PRs and for checking layout changes
without opening a browser.

## Telemetry timeline

Open **Show telemetry timeline** in Power overview to chart total input/output
power, individual ports, battery level, or temperature. Enable auto-refresh for
one reading every three seconds, or collect readings with Refresh now. Choose
five minutes, fifteen minutes, or all retained history; hover a point for its value.
History is local to the current connection, capped at 1,200 readings, and resets
when connecting to another device or demo model. Missing measurements are not
invented, and long sampling pauses appear as gaps. Clear history starts over.

## Troubleshooting

**"About" seems to do nothing.** It scrolls the page down to the About card. If
the page is already showing that section (a tall window, or you are already at
the bottom) there is nothing to scroll and it looks inert. It is a plain
`#about` anchor, so it also works with JavaScript disabled.

**Connect does nothing / no devices listed.** Web Bluetooth's device picker only
lists devices that are currently advertising. Wake the device, and make sure the
official app is not holding the connection.

**"Connected, but this device does not expose a known Anker protocol service."**
Your model uses a UUID family this client does not recognise yet. Download the
protocol log and open an issue — the log has the service list needed to add it.

**Every button does nothing.** You are almost certainly opening `index.html`
from disk. Over `file://` the browser blocks the app's JavaScript module with a
CORS error, so the static HTML renders but nothing is wired up. Run
`npm run serve` and use `http://127.0.0.1:8080/`. The page now detects this and
says so, rather than leaving you guessing.

**"Try demo" does nothing but the page otherwise works.** Check the browser
console. If `src/app.js` failed to load, the file is missing from wherever you
deployed — `index.html` alone is not enough.

---

## Model-specific interface

The UI shows the **real product** and the **real port indicators**, using Anker's
own imagery extracted from the app.

### How the imagery is obtained

Anker's app ships the product renders and per-port indicator badges it draws on
the device home screen. `scripts/extract_assets.py` pulls the relevant ones out
of the APK, resizes them and converts to WebP:

```bash
python3 scripts/extract_assets.py
```

The selected WebP product renders and port badges are included in this repository
for the published dashboard. The APK and source extraction tree remain local.
These images belong to Anker and are not covered by this project's MIT license.

### What the panel shows

- The **product render**, so you can see which device you are talking to
- **Anker's own port badges** — a green bolt for charging in, a blue up-arrow for
  output, grey when idle — which is exactly what the device's own screen shows
- Live watts, volts and amps per port, and the numeric table underneath

### The render follows live state

The app ships several *physically different* renders per model and swaps them
from live state. So does this panel, driven by real telemetry:

| Condition | Render |
|---|---|
| Any port active | the model's active render |
| Battery <= 10 % | the low-battery render |
| Temperature >= 45 C or <= 0 C | the low-temperature render |
| Otherwise | the idle render |

Warnings win over activity. Two examples of why these are genuinely different
photographs rather than brightness tweaks:

- **A1340** — the active render shows the power bank **seated on its charging
  base**; the idle render shows it alone.
- **A1753 SOLIX C800** — the active render **lights the LED bar** across the top.

### Where the app ships no artwork, the panel says so

The app does not cover every port/state combination: the A1340 has no
`p_output` badge, for instance. Rather than quietly drawing the wrong indicator,
the panel discloses it, naming the ports whose badges are showing the nearest
available state.

### Port layouts come from evidence, not guesswork

The registry knows 32 SKUs. Where the app ships per-port indicator artwork, the
layout is **confirmed** from it. Two examples of why that matters:

- The **A1340 Prime Power Bank** has four connectors — `C1, C2, P, A`. Guessing
  from its shape would have produced three.
- The **A2345 250W Prime Charger** was synthesised as `C1, C2, C3, A, AC`. The
  artwork shows it is really `C1, C2, C3, C4, A1, A2` — six connectors, four
  USB-C and two USB-A.

Where no artwork exists, the registry stays silent and the panel follows what the
device reports.

### Model identification is spoof-resistant

A device's BLE name is writable over the air, so name matching is deliberately
strict: a SKU must appear as its own token *and* exist in the registry. A device
renaming itself `A1790P` will not make the UI draw an F3800.

---

## What works

- **Model-aware panel** — schematic of the identified product with live connectors
- **Handshake** — serial number, firmware version, Bluetooth MAC, SKU
- **Live status** — battery %, temperature (°C/°F), total input/output watts
- **Per-port telemetry** — mode, voltage, current and computed power, per port
- **Auto-refresh** — starts after connecting, waits for each read to finish, retries failures, and resumes when the tab becomes visible
- **Settings** — display theme and beeper on supported models; A2345 brightness, screen timeout, USB-C priority mask, and 12/24-hour clock format are recovered from the app and await hardware validation
- **Protocol debug** — request/reply timings, packet layout, encryption flags, multipart counts, and decoded port fields alongside the downloadable raw log
- **Smooth updates** — readings update in place and log rendering is batched; retained histories are bounded

A2345 clock controls include built-in styles, the screensaver switch, holiday screensavers, 12/24-hour format, and a weekly clock display window. Repeat days use Monday bit 6 through Sunday bit 0 (124 weekdays, 3 weekends, 127 every day). Command `0x0202` reads the current screensaver state, style, theme ID and URL; built-in style and weekday schedule changes have been acknowledged and verified by physical readback, with the original configuration restored. The screensaver off/on switch was also confirmed by physical readback. These controls also work in A2345 demo mode.

The experimental image URL control sends `0x0205` with a theme ID, ARGB text color, file CRC32 and UTF-8 URL. The charger downloads a device-compatible resource over Wi-Fi; a successful acknowledgement does not prove download or installation. PNG/JPEG conversion and local photo upload remain unfinished. The metadata is recovered from `CategoryClockThemeData.fromJson` and `setScreenSaverSwitchAndThemeByUrl` in the app binary. No image is downloaded merely by entering a URL; Apply explicitly sends it to the charger.

Settings are model-specific. A1340 exposes display theme and beeper; A2345 exposes its own app-derived charger controls, including in demo mode. The default demo is A1340: select A2345 in the model picker or use “Try A2345 charger controls in demo.” Demo acknowledgements are simulated. App controllers for A1770, A1780, A1781 and the A172x family contain brightness and screen-timeout methods, but their model-specific setting adapters are not implemented here. Unknown models receive no generic setting buttons. A2345 screen brightness is recovered from `setLcdLight`; a physical write at 100% was acknowledged and confirmed by readback.

A2345 additionally exposes Intelligent/Multi-port/Dual laptop/Night charging presets (`0x0206`), knob direction (`0x020E`), holiday screensavers (`0x020F`), and a weekly clock display window (`0x0213`). The schedule is a typed five-byte list: start hour/minute, end hour/minute, weekday mask (127 for every day). Current brightness, timeout, charging preset, knob direction, and clock window are decoded from full-status fields B3/B5/B1/B4/B9, respectively. Editable values track readback until the user edits them; unknown fields are explicitly marked. Settings occupy a full-width horizontal grid beneath device details, with one column on narrow screens.

Physical A2345 setting acknowledgements use pattern `03 01`, even when the multipart flag is absent. The transport checks their checksum and normalizes them into a logical reply before session decryption. Without this step, a successful setting write appeared to time out. A regression test replays a captured encrypted `0x0204` acknowledgement and rejects a corrupted checksum.

Nothing is transmitted anywhere. No backend, no analytics, no account. Host it
yourself and watch the network tab stay empty.

## What does *not* work yet

- **Hardware coverage is limited.** The `2215` Prime family has captured protocol
  vectors. A physical A2345 on `alt-8c85` completes the handshake, session-key
  exchange, and live measurement reads in Chrome. Other families
  remain unconfirmed; registry entries are not a guarantee of working telemetry.
- **Port layouts are confirmed for only a handful of models.** The registry knows
  33 SKUs, but only those whose app artwork includes per-port screenshots have a
  confirmed connector layout (currently the A1340 and A1763). For every other
  model the panel is driven entirely by what the device reports — which is
  accurate, but means it may draw a generic connector shape for a port type it
  cannot confirm.
- **Firmware updates are unsupported**, deliberately — Anker signs OTA images
  from firmware 1.6.2 and bricking is a real risk.
- **Cloud/account features are absent.** This is a local Bluetooth client.
- **X25519 account authentication is not implemented.** The BLE link does not
  need it; the Anker cloud does.

---

## Deploying to GitHub Pages

**Yes, this works on GitHub Pages.** It is the recommended way to run it: Pages
serves over HTTPS, which is exactly what Web Bluetooth requires, so there is no
`file://` problem and nothing to install for your users.

### Runtime imagery

The build includes the tracked `assets/device/` WebP files. No APK extraction or
external image service is required in CI.

### One structural requirement

GitHub reads workflows from `.github/workflows/` at the repository root. This
repository uses the following layout, matching the workflow's working directories:

```
<repo>/
├── .github/workflows/ci.yml
└── ankerproto/
    ├── web/
    ├── ankerproto/
    └── tests/
```

If you push a parent directory instead, GitHub never sees the workflow and
nothing is ever published. This is the single most common way Pages deployment
"silently does nothing".

### Setup, once

1. Push the repo, with this folder's parent as the repository root.
2. **Settings → Pages → Source → GitHub Actions.**
3. Push to `main` (or `master`).

The [workflow](../../.github/workflows/ci.yml) then runs every check, builds the
site, and publishes it. Your URL is:

```
https://<user>.github.io/<repo-name>/
```

### Why the base path matters

A *project* site is served from `/<repo-name>/`, not `/`. The build therefore has
to be told about it:

```bash
npm run build -- --base "/<repo-name>/"
```

The workflow derives this automatically from the repository name. A user or
organisation site (`https://<user>.github.io/`) uses `--base /`.

Get this wrong and every asset 404s — the page renders but nothing works, the
same confusing failure as opening it from disk. That exact mistake is guarded:
`npm run test:subpath` fails loudly if `dist/` was built for a different base,
and it also loads the built site under the real sub-path in Chrome and clicks
*Try demo* to prove it works.

### Verifying before you push

Emulate the Pages layout locally:

```bash
npm run preview:pages -- --base "/<repo-name>/"
# or, with the env var the npm scripts use:
PAGES_BASE=<repo-name> npm run preview:pages
```

This serves `dist/` under the same `/repo-name/` prefix GitHub uses, so what you
see is what gets deployed. Root requests deliberately 404, matching Pages.

### Custom domain

Drop a `CNAME` file into `web/`; the build copies it into `dist/`. HTTPS is
mandatory — Web Bluetooth will not run in an insecure context, and Pages
provisions the certificate automatically once DNS resolves.

### Updating the repo URL in the header

The header's "Source" link is stamped from `GITHUB_REPOSITORY` during the CI
build. Building locally sets no link unless you provide one:

```bash
REPO_URL="https://github.com/you/your-repo" npm run build -- --base "/your-repo/"
```

## Security: please understand this

The device link uses **AES-128-CBC with a key hardcoded in the official app**,
and the IV is the **device serial number**, which the device broadcasts in
cleartext during the handshake.

That is **obfuscation, not encryption.** Anyone within Bluetooth range can
perform the same handshake and control the device. This client does not weaken
anything — it does in the open what the official app does with a secret that was
never really secret. Analysis: [PROTOCOL.md §4.3](../ankerproto/docs/PROTOCOL.md).

Do not treat a BLE-connected power bank as access-controlled. Physical proximity
is the only barrier.

---

## Testing

Layered deliberately — each layer catches a class of bug the one below cannot.

```bash
npm run test:all
```

| Layer | What it proves | Count |
|---|---|---|
| `test:vectors` | JS vectors are in sync with the Python implementation | — |
| `test` (Node) | Framing, TLV, crypto, handshake, every demoable model, registry, render variants, asset paths | 55 |
| `test:browser` | The same crypto vectors **inside real Chrome** | 13 |
| `test:ui` | Site loads cleanly; demo mode populates the panel with real imagery, picks the render variant from state, re-resolves on model switch | 68 |
| `test:subpath` | The built site works served from `/<repo>/` — assets resolve, *Try demo* connects, imagery loads | 12 |

The browser layer is not ceremony. It caught a genuine bug that a Node-only
suite could not: **WebCrypto's AES-CBC padding behaviour is not identical
across runtimes, and it fails silently.** Browsers strip PKCS#7 padding on
`decrypt`; Node's WebCrypto does not — while both accept the call. An
implementation that pads explicitly, or unpads unconditionally, is correct on
one and wrong on the other, and produces a plausible-looking wrong length rather
than an error. `src/crypto.js` probes the runtime once and normalises.

See `src/crypto.js` for the normalisation and `scripts/verify-browser.mjs` for
the check. `npm run test:browser` needs Chrome/Chromium; set `CHROME_PATH` if it
is not in a standard location.

The frozen vectors in `../ankerproto/tests/vectors.json` are the contract
between the two implementations: if either drifts, both suites fail.

---

## Layout

```
web/
├── index.html              single page
├── styles.css
├── src/
│   ├── app.js              UI logic and DOM wiring
│   ├── bluetooth.js        Web Bluetooth transport (GATT + frame reassembly)
│   ├── session.js          protocol state machine
│   ├── framing.js          wire format, command flags, checksum
│   ├── crypto.js           AES-128-CBC contexts (initial + session)
│   ├── tlv.js              TLV codec
│   ├── opcodes.js          GENERATED — 129 opcodes + TLV tag tables
│   ├── uuids.js            GENERATED — GATT service families
│   └── transport.js        simulated device + replay transports for tests
├── tests/
│   ├── protocol.test.js    Node unit tests
│   ├── browser.html        in-browser checks
│   └── vectors.json        GENERATED — synced from the Python client
└── scripts/                serve, build, verify-browser, smoke-ui, sync-vectors
```

`opcodes.js` and `uuids.js` are generated from `../ankerproto/ankerproto/*.py`.
Edit the Python and regenerate (`npm run sync-vectors`, and see
`../ankerproto/tests/generate_vectors.py`); do not hand-edit the JS. CI enforces
parity.

---

## Contributing

The most valuable contribution is **a protocol log from a device that is not an
Anker Prime**. Connect, let it fail or succeed, and attach the downloaded log to
an issue. That is enough to extend support.

Bug reports are most useful with: device model, firmware version, browser and
OS, and the protocol log.

## License

MIT. See [LICENSE](LICENSE).

Not affiliated with, endorsed by, or supported by Anker Innovations. Product
names are used only to describe compatibility. Use on hardware you own.

### Hardware verification (2026-10-10)

A physical A2345 on `alt-8c85` completed the plaintext handshake, reported device information, and returned an encrypted AES session-key response in Google Chrome. This family declares the complete packet length **including the checksum**; the captured Prime family retains its original checksum-exclusive format. A captured A2345 reply is covered by the framing and split-notification tests.

The A2345 telemetry request and seven-byte port decoder are recovered from `A2345DeviceController` and `A2345DeviceCommands` in the app binary. A physical reply was captured and successfully replayed through multipart reassembly, AES decryption, and typed port decoding: six ports, including C1 at 19.96 V, 0.957 A, and 17.91 W. Multipart replies use pattern `03 01`, command flag `0x80`, and a byte containing the packet index in the high nibble and count in the low nibble. Ciphertext must be assembled before decryption. Live Chrome verification also passed: the page showed Connected with C1 at 19.91 V, 1.146 A, and 21.89 W; a second refresh updated the readings and the timeline recorded both samples. This does not imply every model's measurements or controls are supported. Brave detection now explains its browser-level Bluetooth block instead of diagnosing an empty picker as a charger problem.

### Timeline details

The timeline marks the highest observed value in the selected history window with a dashed peak line. Each series legend includes its maximum. Per-port power, voltage, and current are available alongside battery and temperature when reported by the device. Session statistics summarize retained readings: peak output, sample-average output, and estimated output energy. Energy uses trapezoidal integration between readings and excludes gaps longer than ten seconds; it is not a certified energy meter. A2345 connector cards use USB-C and USB-A symbols beside explicit C1/C2/C3/C4/A1/A2 text labels, instead of the app's tiny device overlays.

On a physical A2345, brightness at 100%, Intelligent mode (1), forward knob direction (0), and the daily 08:00–23:00 clock window were acknowledged and verified by full-status readback. The original configuration was restored after testing. Timeout readback is B5; knob direction is B4, confirmed by the dedicated direction parser and a physical direction write. Other presets, holiday screensavers, clock format, and priority still need individual hardware validation.

## Clock photos (experimental, A2345)

The clock appears when the screen rests, within its configured schedule. Set a
screen timeout such as 30 seconds; **Always on prevents the clock from appearing**.

Under Device settings → Clock screensaver, select **Your photo** to choose a
photo, crop/zoom it, preview the result, and prepare a JPEG or PNG with its CRC32.
Image dimensions and JPEG/PNG compatibility remain unverified on hardware.
Preparation and saving happen locally in the browser.

For delivery from your computer, run `npm run photo:serve` in this folder alongside
`npm run serve` on port 8080. The helper accepts uploads only from the local website
and serves a single prepared image at an unpredictable URL for ten minutes. It
never serves project files. Use **Make available to charger**, then **Apply clock
style**. Keep the computer awake, with the charger on the same Wi-Fi network.
If automatic address selection chooses the wrong network interface, enter the
computer's Wi-Fi IPv4 address. The network must allow the charger to reach port 8081.
The helper works with the local site, not a remotely hosted copy.

An acknowledged download request does not prove the image was installed. The
charger returns its installed theme ID through Bluetooth but may omit its image
URL, and it does not return the file checksum. Check its resting screen to verify
a new photo. Demo mode prepares a simulated URL without uploading an image.

The A2345 handshake now sends the browser's current UTC-minus-local offset in
seconds, matching the app's `getTimeStampDifference` field, instead of zero.
**Reconnect and sync clock** reconnects to the already selected device and runs
the normal handshake. It does not attempt to change keys in an active session.
The computer's time and IANA time zone are shown beside the control.


On the tested A2345 (app-reported firmware 1.9.1.4), the numeric offset alone was
insufficient: the clock remained three hours ahead. The site now also sends the
app's POSIX time-zone string in handshake tag A5, using its bundled IANA-to-POSIX
mapping. Sending `America/Sao_Paulo` as `<-03>3` was physically confirmed to fix
the displayed hour. Other time zones remain unverified on hardware.

The Bluetooth handshake version is labeled separately from main firmware.

### Photo editor workflow

The photo editor supports choosing or dropping a JPEG, PNG, or WebP, dragging the
preview to reposition, and keyboard-accessible zoom/position sliders. Reset
restores a centered crop. The optional clock overlay is illustrative and is never
included in the exported image. Image dimensions, format, and manual URL/checksum
fields are under Advanced options. Editing a shared crop clears its old download
details so Apply cannot silently send the previous image.

On GitHub Pages, save the photo and follow the local delivery instructions.
The local helper only accepts the workspace at localhost:8080 or 127.0.0.1:8080.
Sharing and applying remain separate actions; demo sharing sends no network request.
