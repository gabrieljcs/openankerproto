"""Anker ZX BLE opcode and TLV tag tables.

Everything in this module was recovered mechanically from
``Anker_3.8.0_release_mp_202505250018_encrypt.apk``:

* **Opcodes** - from the ``ZXOpcodeType`` enum objects and the
  ``PPSDeviceCommands.chargingOpcodeMap()`` / ``commonOpcodeMap()`` maps in the
  Dart AOT snapshot (129 distinct opcodes).
* **Tag names** - from the ``parse*`` routines in
  ``command/pps_device_commands.dart`` and the per-model command builders in
  ``charging/command/*.dart``.

Conventions
-----------
* Requests use even/high opcodes such as ``0x0022``; the device answers with
  the same value with bit ``0x0800`` set (``0x0822``). The flag bit is stripped
  by :func:`~ankerproto.framing.parse_frame`, so you always match on the
  request value.
* The byte ``0xFFF9``-style "post" opcodes (``0x04xx``) are **unsolicited
  notifications** pushed by the device.
"""

from __future__ import annotations

from enum import IntEnum

__all__ = [
    "Opcode",
    "OPCODE_NAMES",
    "RESPONSE_TAGS",
    "REQUEST_TAGS",
    "STATUS_CODE_OK",
]


class Opcode(IntEnum):
    """Anker ZX BLE opcodes (request form; the response sets bit 0x0800)."""

    # -- session / handshake -------------------------------------------
    START_CONNECT_REQ = 0x0001
    START_DISCONNECT_REQ = 0x0002
    CAPABILITY_NEGOTIATION_REQ = 0x0003
    CONFIGURE_CAPABILITY_REQ = 0x0004
    SET_CAPABILITY_REQ = 0x0005
    EXIT_CONNECT_REQ = 0x0035

    # -- security / identity -------------------------------------------
    GET_MODULE_INFO_REQ = 0x0021
    GET_PUBLIC_KEY_REQ = 0x0021
    GET_AES_KEY_REQ = 0x0022
    GET_AUTHENTICATION_REQ = 0x0027
    GET_DEVICE_INFO_REQ = 0x0029
    BIND_USER_ID_REQ = 0x0023
    GET_BIND_BLUETOOTH_DEVICE_REQ = 0x0032
    GET_UNBIND_BLUETOOTH_DEVICE_REQ = 0x0033

    # -- Wi-Fi provisioning --------------------------------------------
    SCAN_WIFI_REQ = 0x0022
    GET_WIFI_LIST_REQ = 0x0023
    CONNECT_WIFI_REQ = 0x0024
    ACTIVATE_WIFI_REQ = 0x0025

    # -- telemetry / status (poll) -------------------------------------
    GET_ALL_DEVICE_INFO_RES = 0x0023
    POST_DEVICE_INFO_REQ = 0x0020
    POST_WORK_INFO_REQ = 0x001E
    POST_DEVICE_ALL_INFO_REQ = 0x0050
    POST_A17B1_DEVICE_INFO_REQ = 0x0500
    POST_A17B1_SELF_CHECK_REQ = 0x0501
    POST_A1790_DEVICE_INFO_REQ = 0x0601
    SET_A1790_COMMAND_REQ = 0x0602
    GET_A17B2_DEVICE_INFO_REQ = 0x0074
    GET_MINI_CHARGE_ALL_DEVICE_INFO_REQ = 0x0200

    # -- unsolicited device push (0x04xx) ------------------------------
    POST_ERROR_INFO_REQ = 0x0400
    POST_SWITCH_STATE_REQ = 0x0401
    POST_WORK_INFO_PUSH_REQ = 0x0402
    POST_DEVICE_INFO_PUSH_REQ = 0x0403
    POST_COUNT_DOWN_TIME_REQ = 0x0404
    POST_DEVICE_ALL_INFO_PUSH_REQ = 0x0405
    POST_UPGRADE_STATE_REQ = 0x0406
    POST_ALL_BMS_MINOR_BATTERY_BT_INFO_REQ = 0x0409
    POST_ALL_BMS_MINOR_BATTERY_WIFI_INFO_REQ = 0x040A
    GET_MICRO_INVERTER_REQ = 0x040E
    POST_SUB_BATTERY_ERROR_INFO_REQ = 0x040F
    POST_A17B2_DEVICE_INFO_WIFI_REQ = 0x0410
    POST_A17B2_DEVICE_INFO_BT_REQ = 0x0411
    POST_DEVICE_LIST_REQ = 0x0503

    # -- power / port control ------------------------------------------
    SET_DEVICE_UPDATE_ENERGY_REQ = 0x0057
    SET_SUPER_CHARGE_REQ = 0x005E
    SET_BMS_SUB_BATTERY_POWER_SWITCH_REQ = 0x005F
    SET_BMS_SUB_BATTERY_LIGHT_SWITCH_REQ = 0x0060
    GET_ALL_BMS_SUB_BATTERY_INFO_REQ = 0x0061
    SET_A17B1_COMMAND_REQ = 0x0061
    SET_RELAY_SWITCH_REQ = 0x007A
    SET_LOCATION_LIGHT_REQ = 0x007B
    SET_TIMING_REQ = 0x007C
    GET_TIMING_REQ = 0x007D
    SET_COUNTDOWN_REQ = 0x007E
    GET_COUNTDOWN_REQ = 0x007F
    CAR_PORT_SAVING_REQ = 0x0076
    AC_OUTPUT_SMART_REQ = 0x0077
    SET_MULTI_DEVICES_REQ = 0x0036
    GET_MULTI_DEVICES_REQ = 0x0037
    SET_AC_COUNT_DOWN_TIME_REQ = 0x0041
    SET_AC_CHARGE_POWER_REQ = 0x0044
    SET_DEVICE_WAIT_TIME_REQ = 0x0045
    SET_DEVICE_SCREEN_TIME_REQ = 0x0046
    SET_INVERSION_WAIT_TIME_REQ = 0x0047
    SET_AC_SWITCH_REQ = 0x004A
    SET_CAR_SWITCH_REQ = 0x004B
    SET_LCD_LIGHT_REQ = 0x004C
    SET_AC_FREQUENCY_REQ = 0x004D
    SET_ENERGY_MODE_REQ = 0x004E
    SET_AMBIENT_LIGHT_REQ = 0x004F
    SET_TEMP_UNIT_REQ = 0x0050
    SET_RESET_REQ = 0x0051

    # -- OTA / logs -----------------------------------------------------
    SEND_OTA_SUB_PACKAGE_REQ = 0x002E
    GET_ZXOTA_STATE_REQ = 0x0030
    GET_OTA_STATE_REQ = 0x0089
    BLE_OTA_PROGRESS_REQ = 0x0067
    REQUEST_MCU_LOG_UPLOAD_REQ = 0x0065
    MCU_LOG_UPLOAD_REQ = 0x0066
    REQUEST_MODULE_LOG_UPLOAD_REQ = 0x0031
    MODULE_LOG_UPLOAD_RES = 0x0032
    GET_SCAN_BLUETOOTH_DEVICE_REQ = 0x0031

    # -- factory --------------------------------------------------------
    DEVICE_FACTORY_SETTING_REQ = 0x0069
    DEVICE_FACTORY_SETTING_CLEAR_REQ = 0x006A
    GET_DEVICE_SELF_TEST_RES = 0x0460
    UP_UPGRADE_CONDITION = 0x0489


#: Names for every opcode recovered from the app (129 entries).
#: Generated from the `ZXOpcodeType` enum in the APK's Dart AOT object pool.
#: Where an opcode means different things in the charging map and the common
#: map, both names are given, separated by ' / '.
OPCODE_NAMES: dict[int, str] = {
    0x0001: 'startConnectReq',
    0x0002: 'startDisconnectReq',
    0x0003: 'capabilityNegotiationReq',
    0x0004: 'configureCapabilityReq',
    0x0005: 'setCapabilityReq',
    0x0021: 'getModuleInfoReq / getPublicKeyReq',
    0x0022: 'getAesKeyReq / scanWifiReq',
    0x0023: 'bindUserIdReq / getWifiListReq',
    0x0024: 'connectWifiReq',
    0x0025: 'activateWifiReq',
    0x0027: 'getAuthenticationReq',
    0x0029: 'getDeviceInfoReq',
    0x002E: 'sendOtaSubPackageReq',
    0x0030: 'getZXOTAStateReq',
    0x0031: 'getScanBluetoothDeviceReq / requestModuleLogUploadReq',
    0x0032: 'getBindBluetoothDeviceReq / moduleLogUploadRes',
    0x0033: 'getUnBindBluetoothDeviceReq',
    0x0035: 'exitConnectReq',
    0x0036: 'setMultiDevicesReq',
    0x0037: 'getMultiDevicesReq / getMultiDevicesRes',
    0x0057: 'setDeviceUpdateEnergyReq',
    0x005E: 'setSuperChargeReq',
    0x005F: 'setBMSSubBatteryPowerSwitchReq',
    0x0060: 'setBMSSubBatteryLightSwitchReq',
    0x0061: 'getAllBMSSubBatteryInfoReq / setA17b1CommandReq',
    0x0065: 'requestMcuLogUploadReq',
    0x0066: 'mcuLogUploadReq',
    0x0067: 'bleOtaProgressReq',
    0x0069: 'deviceFactorySettingRes',
    0x006A: 'deviceFactorySettingClearRes',
    0x0074: 'getA17B2DeviceInfoReq',
    0x0076: 'carPortSavingReq',
    0x0077: 'acOutputSmartReq',
    0x007A: 'setRelaySwitchReq',
    0x007B: 'setLocationLightReq',
    0x007C: 'setTimingReq',
    0x007D: 'getTimingReq',
    0x007E: 'setCountdownReq',
    0x007F: 'getCountdownReq',
    0x0089: 'getOTAStateReq',
    0x0200: 'getMiniChargeAllDeviceInfoReq',
    0x0201: 'setMiniChargeResetReq',
    0x0202: 'getMiniChargeScreensaverReq',
    0x0203: 'setMiniChargeScreenTimeoutReq',
    0x0204: 'setMiniChargeScreenBrightnessReq',
    0x0205: 'setMiniChargeScreensaverReq',
    0x0206: 'setMiniChargeACRelaySwitchReq / setMiniChargeACRelaySwitchRes',
    0x0207: 'setMiniChargeACRelaySwitchReq',
    0x0400: 'postErrorInfoReq',
    0x0401: 'postSwitchStateReq',
    0x0402: 'postWorkInfoReq',
    0x0403: 'postDeviceInfoReq',
    0x0404: 'postCountDownTimeReq',
    0x0405: 'postDeviceAllInfoReq',
    0x0406: 'postUpgradeStateReq / postUpgradeStateRes',
    0x0409: 'postAllBMSMinorBatteryBTInfoReq',
    0x040A: 'postAllBMSMinorBatteryWiFiInfoReq',
    0x040E: 'getMicroInverterReq',
    0x040F: 'postSubBatteryErrorInfoReq',
    0x0410: 'postA17B2DeviceInfoWIFIReq',
    0x0411: 'postA17B2DeviceInfoBTReq',
    0x0460: 'getDeviceSelfTestRes',
    0x0489: 'upUpgradeCondition',
    0x0500: 'postA17b1DeviceInfoReq',
    0x0501: 'postA17b1SelfCheckReq',
    0x0503: 'postDeviceListReq',
    0x0601: 'postA1790DeviceInfoReq',
    0x0602: 'setA1790CommandReq',
    0x0604: 'postGetUpdateListReq',
    0x0801: 'startConnectRes',
    0x0802: 'startDisconnectRes',
    0x0803: 'capabilityNegotiationRes',
    0x0805: 'setCapabilityRes',
    0x0821: 'getModuleInfoRes / getPublicKeyRes',
    0x0822: 'getAesKeyRes / scanWifiRes',
    0x0823: 'bindUserIdRes / getWifiListRes',
    0x0824: 'connectWifiRes',
    0x0825: 'activateWifiRes',
    0x0827: 'getAuthenticationRes',
    0x0829: 'getDeviceInfoRes',
    0x0830: 'getZXOTAStateRes',
    0x0831: 'getScanBluetoothDeviceRes / requestModuleLogUploadRes',
    0x0832: 'getBindBluetoothDeviceRes',
    0x0833: 'getUnBindBluetoothDeviceRes',
    0x0835: 'exitConnectRes',
    0x0836: 'setMultiDevicesRes',
    0x0840: 'getAllDeviceInfoRes',
    0x0841: 'getAcCarCountDownTimeRes',
    0x0842: 'setAcCountDownTimeRes / setCarCountDownTimeRes',
    0x0844: 'setAcChargePowerRes',
    0x0845: 'setDeviceWaitTimeRes',
    0x0846: 'setDeviceScreenTimeRes',
    0x0847: 'setInversionWaitTimeRes',
    0x0848: 'setMajorPkgRes',
    0x0849: 'setMinorPkgRes',
    0x084A: 'setAcSwitchRes',
    0x084B: 'setCarSwitchRes',
    0x084C: 'setLcdLightRes',
    0x084D: 'setAcFrequencyRes',
    0x084E: 'setEnergyModeRes',
    0x084F: 'setAmbientLightRes',
    0x0850: 'setTempUnitRes',
    0x0851: 'setResetRes',
    0x085E: 'setDischargeTimeRes / setSuperChargeRes',
    0x085F: 'setBMSSubBatteryPowerSwitchRes',
    0x0860: 'setBMSSubBatteryLightSwitchRes',
    0x0861: 'getAllBMSSubBatteryInfoRes / setA17b1CommandRes',
    0x0865: 'requestMcuLogUploadRes',
    0x0866: 'mcuLogUploadRes',
    0x0867: 'bleOtaProgressRes',
    0x0869: 'deviceFactorySettingReq',
    0x086A: 'deviceFactorySettingClearReq',
    0x0874: 'getA17B2DeviceInfoRes',
    0x0876: 'carPortSavingRes',
    0x0877: 'acOutputSmartRes',
    0x087A: 'setRelaySwitchRes',
    0x087B: 'setLocationLightRes',
    0x087C: 'setTimingRes',
    0x087D: 'getTimingRes',
    0x087E: 'setCountdownRes',
    0x087F: 'getCountdownRes',
    0x0889: 'getOTAStateRes',
    0x0A00: 'getMiniChargeAllDeviceInfoRes',
    0x0A01: 'setMiniChargeResetRes',
    0x0A02: 'getMiniChargeScreensaverRes',
    0x0A03: 'setMiniChargeScreenTimeoutRes',
    0x0A04: 'setMiniChargeScreenBrightnessRes',
    0x0A05: 'setMiniChargeScreensaverRes',
    0x0A07: 'setMiniChargeACRelaySwitchRes',
}


# ---------------------------------------------------------------------------
# TLV tags
# ---------------------------------------------------------------------------

#: Status byte the device prefixes to decrypted payloads. ``0x00`` means OK;
#: parsers skip it when present.
STATUS_CODE_OK = 0x00

# Opcodes that appear on the wire and are handled by dedicated parse routines in
# the app, but are **absent from both opcode maps** - the app dispatches them by
# literal value in the BLE notification handler rather than looking them up in
# ``ZXOpcodeType``. They are therefore not in :data:`OPCODE_NAMES`.
#: Live per-port power report, updates faster than ``POST_A17B1_DEVICE_INFO_REQ``.
OP_LIVE_POWER = 0x050E
#: Dedicated temperature report.
OP_TEMPERATURE = 0x0522
#: Display theme - see :meth:`ankerproto.session.AnkerSession.set_theme`.
OP_SET_THEME = 0x0504
#: Beeper enable/disable - see :meth:`ankerproto.session.AnkerSession.set_beep`.
OP_SET_BEEP = 0x0505

#: Tags present in *responses* from a 2215-family (Prime power bank) device.
RESPONSE_TAGS: dict[int, str] = {
    0xA1: "session_key (16B, on getAesKeyRes) / timestamp (on handshake)",
    0xA2: "battery / device block (SOC at [8:10] x0.01)",
    0xA3: "firmware version (handshake) | port C2 (status)",
    0xA4: "serial number (handshake) | port C1 (status)",
    0xA5: "BT MAC address (handshake) | port C2 (status, 0x0500)",
    0xA6: "port A (USB-A)",
    0xA8: "battery block (0x050E live-power reply)",
    0xAE: "total power: [1:3] output x0.1 W, [3:5] input x0.1 W",
    0xB3: "temperature: [1] degC, [2] degF",
}

#: Tags the app sends in *requests*. ``A1``/``A2`` are the fixed handshake
#: prefix; later tags are command-specific and vary per opcode.
REQUEST_TAGS: dict[int, str] = {
    0xA1: "session timestamp (4B LE epoch seconds) or port selector (0x21)",
    0xA2: "static 40-byte handshake blob, or command parameter",
    0xA3: "capability bitmap / parameter",
    0xA4: "capability parameter",
    0xA5: "capability parameter / zero-filled reservation",
    0xFD: "timestamp, milliseconds (CMD_COMMON_V2)",
    0xFE: "timestamp, epoch seconds (older firmware)",
}

#: Per-port telemetry layout inside tags A4/A5/A6 of a ``0x0500`` status dump.
PORT_BLOCK_LAYOUT = {
    "mode": (2, 1, "0=off, 1=input, 2=output"),
    "voltage": (3, 2, "uint16 LE, /10 -> volts"),
    "current": (5, 2, "uint16 LE, /10 -> amps"),
    # power = voltage * current, not transmitted
}

#: Fixed handshake values, lifted from the app's ``_setInitialKeyForSecure``
#: and the community-verified trace.
HANDSHAKE_A3_CAPABILITY = bytes([0x20])
HANDSHAKE_A4_CAPABILITY = bytes([0x00, 0xF0])
HANDSHAKE_A5_CAPABILITY = bytes([0x02])
