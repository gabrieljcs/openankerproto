# Firmware update investigation

Firmware discovery and installation are not implemented in the website. Do not
display a static latest-version notice or treat the Bluetooth-reported version
as the charger's main firmware version.

## Local email sign-in diagnostic

From `ankerproto/web`, run `npm run cloud:serve` and open
`http://127.0.0.1:8082/`. This is a separate local diagnostic, not a firmware
update control in the Bluetooth website. Choose the account country and server
region before signing in. The helper selects an editable default from the browser
locale and time zone; Brazilian time zones select Brazil/global. An unknown
region requires manual selection rather than silently choosing a server.

The helper encrypts the password using P-256 ECDH and AES-256-CBC, authenticates
against the selected Anker HTTPS API, then negotiates an encrypted session to
read `/power_service/v1/app/get_relate_and_bind_devices`. Passwords and tokens
are not logged, written to disk, or returned to the browser. Sessions are
isolated by an HttpOnly SameSite cookie and discarded after 30 minutes, on local
sign-out, or when the helper stops. The browser clears the password input on
submission. The helper is bound to 127.0.0.1 and checks Host, Origin and CSRF.

Protocol reference: [thomluther/anker-solix-api](https://github.com/thomluther/anker-solix-api),
`src/anker_solix_api/session.py` and `apitypes.py` (MIT). This helper implements
the protocol independently and does not use that library's on-disk token cache.
Its tests cover negotiated encrypted reads, token isolation, response filtering,
cross-origin rejection, and update requests derived from account metadata.
Live account authentication and encrypted device discovery have been verified:
the account returned its A2345 with main firmware `v1.9.1.4`.

The helper exposes a read-only **Check firmware with Anker** action after
device discovery. The single-device endpoint returned an empty package both
with and without the account version's `v` prefix. Neither response establishes
that the device is current. `StringUtil.getMainVersion` at `0x1263848` explicitly
prepends the prefix, so it must be preserved when reproducing that app request.

The helper now uses the account-based `/app/ota/batch/check_update` endpoint,
with `device_list: [{device_sn: accountSerial, version: ""}]`, following the
open-source client's discovery request. This requests the account's current
update metadata; it does not start an update. The user explicitly authorized
sending the charger serial to Anker for this lookup. The live batch response was
verified on 2026-10-12: `need_update:true`, installed `v1.9.1.4`, main package
`v2.1.1.6`, and Wi-Fi module package `v0.2.9.7`. The helper parses the matching
serial record; a missing matching record means unknown availability, not current.

Both official downloads were verified without installation:

| Component | Version | Bytes | API MD5, matching downloaded file |
| --- | --- | --- | --- |
| A2345_mcu | v2.1.1.6 | 461280 | a3d608ee8f383b8c1fc269a76eac258f |
| A2345_esp32 | v0.2.9.7 | 1380352 | b6cc13e97777972e2bad159312a4f09a |

The MCU package starts with an `Anker` header and product identifier `A2345`.
The Wi-Fi package starts with an ESP image header. File integrity has been
checked; publisher signature verification and the installation sequence remain
unverified. No update start command has been sent.

## Recovered from the official Android app

The following references are relative to `work/blutter_out/asm/` in this workspace.
They describe the recovered app, not a hardware-tested updater.

- `charging/ui/page/device/a2345/a2345setting/a2345setting_logic.dart`,
  `checkOta` at `0x1623094`: A2345 passes its main version and normalized MAC
  address to `checkOTAUpdateWifi`.
- `charging/http/http_request_repository_impl.dart`, `checkOTAUpdateWifi` at
  `0x1169e70`: POST `/app/ota/{product}/ALL/update/{mainVersion}` with
  `device_mac`, `sub_package`, and `sub_ota_way`. The app uses
  `encryptionRequestHttp`; an earlier unauthenticated probe returned
  `{"code":401,"msg":"token error"}`. Authentication and the request/response
  envelope still need to be recovered. This is not a public anonymous feed.
- `base_service/bean/model/ota_update_model.dart`: firmware metadata includes
  `url`, `version`, `md5`, and sub-package fields `file_path`, `file_size`,
  `file_md5`. Their presence does not establish a complete validated schema.
- `charging/ui/page/device/anker_ota/base/anker_ble_ota_base_logic.dart`,
  around `0x11ce220`: the downloaded file is hashed using MD5. MD5 verifies
  agreement with supplied metadata; it does not authenticate the publisher.
- `charging/ble/device/A2345/a2345_anker_device.dart`, `startBleOTA` at
  `0x1adc160`: inherits the A1771 OTA payload builder and sends encrypted
  opcode `0x002e`. The inherited builder includes timestamp, user ID and
  further package parameters. Parameter meanings and transfer/recovery behavior
  are not sufficiently verified to implement flashing.
- `charging/ble/device/A2345/a2345_device_controller.dart`, `startOta` at
  `0x2393370`: the ordinary Wi-Fi update trigger uses an MQTT command.
  A Bluetooth connection alone does not reproduce this authenticated cloud path.
- `charging/ble/device/A2345/a2345_commands.dart`, `parseDeviceVersion`:
  a main-version notification is parsed separately from basic Bluetooth info.
  Recover and verify its active read path before using it for update comparison.

## Hardware observations

On the tested A2345, basic Bluetooth information reports `0.0.0.3`; the official
app reports main firmware `1.9.1.4`. Those are distinct version fields. The user
reported an available update `2.1.1.6`, which is an observation, not a live feed
or a value suitable for hardcoding into the website.

## Remaining requirements

### Offline firmware diagnostic

`web/scripts/firmware-dry-run.mjs` reads a supplied Anker manifest and component
files. It has no transport or cloud imports and cannot start an update. It
checks model/serial matching, component targeting, byte counts, MD5 and an Anker
MCU product header when present; it additionally calculates SHA-256 for reports.
ESP image headers alone do not establish product targeting. Integrity passing
always leaves `installationReady:false` because installation remains unverified.

Run from `ankerproto/web`:

```sh
npm run firmware:dry-run -- --manifest /absolute/manifest.json --model A2345 --serial YOUR_SERIAL --package A2345_mcu=/absolute/mcu.bin --package A2345_esp32=/absolute/wifi.bin --html /absolute/report.html
```

The generated HTML report is an offline snapshot, not a live update notice.
Corrupt, missing, mistargeted or incorrectly sized images fail validation and
the CLI exits unsuccessfully. No update opcode or speculative capability probe
is executed. The shared app updater's `getOTAInfo` at `0x25de7f0` reads a
initial file block; its read length and transfer chunk size still need verification.

### Apple account authentication

The recovered `LoginLogic.appleLogin` (`0x1da5a74`) obtains a native Apple
credential, then selects `externalLogin` or `thirdLoginRequest` according to
the app's login mode. `thirdLoginRequest` (`0x1759d2c`) sends
`third_party: "apple"`, `access_token`, `country_code`, `user_identity`, and
`client_secret_info.public_key` to `/passport/third_party_login` through the
encrypted HTTP path, with an `Openudid` header. The other branch uses
`/passport/external_login`. These are token exchanges, not Apple-password APIs.
Credential-to-field mapping and the encryption envelope still need verification.

Apple web authentication requires a Services ID linked to the provider's app
and a registered HTTPS return URL with a domain name; IP addresses and localhost
are not supported return URLs. No suitable Anker web client/return URL has been
identified in the recovered login path. Creating a separate openankerproto
Apple client does not establish that Anker will accept its tokens.

References:
- https://developer.apple.com/help/account/capabilities/configure-sign-in-with-apple-for-the-web/
- https://developer.apple.com/documentation/signinwithapplerestapi/request-an-authorization-to-the-sign-in-with-apple-server.

Do not add a nonfunctional Apple button or collect Apple passwords. A possible
alternative is an official email/password login linked to the same Anker account,
if the app supports it; this has not been established. Do not create a new account
or migrate device ownership as a workaround.

1. Obtain an authorized authenticated update response and recover its envelope.
2. Read the real installed main version dynamically.
3. Validate product/sub-package targeting, version, size and integrity using the
   official response; establish how image authenticity is enforced.
4. Recover transfer acknowledgements, progress, failure handling and restart
   behavior for each supported model.
5. Test installation against real hardware and re-read the main version after
   restart before declaring success.

No firmware start command has been sent during this investigation. No account
tokens have been collected. A new live probe containing device metadata was
blocked by automatic approval review and was not sent.
