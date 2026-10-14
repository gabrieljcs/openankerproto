/**
 * Anker ZX BLE opcode and TLV tag tables.
 *
 * GENERATED from `ankerproto/opcodes.py` - edit that file, not this one.
 * Source of truth: the `ZXOpcodeType` enum in the APK's Dart AOT object pool.
 *
 * The response form of an opcode is always `request | 0x0800`, but `parseFrame`
 * masks the flag bits out, so you always match on the request value.
 */

/** Every opcode recovered from the app, with names. */
export const OPCODE_NAMES = {
  0x0001: "startConnectReq",
  0x0002: "startDisconnectReq",
  0x0003: "capabilityNegotiationReq",
  0x0004: "configureCapabilityReq",
  0x0005: "setCapabilityReq",
  0x0021: "getModuleInfoReq / getPublicKeyReq",
  0x0022: "getAesKeyReq / scanWifiReq",
  0x0023: "bindUserIdReq / getWifiListReq",
  0x0024: "connectWifiReq",
  0x0025: "activateWifiReq",
  0x0027: "getAuthenticationReq",
  0x0029: "getDeviceInfoReq",
  0x002E: "sendOtaSubPackageReq",
  0x0030: "getZXOTAStateReq",
  0x0031: "getScanBluetoothDeviceReq / requestModuleLogUploadReq",
  0x0032: "getBindBluetoothDeviceReq / moduleLogUploadRes",
  0x0033: "getUnBindBluetoothDeviceReq",
  0x0035: "exitConnectReq",
  0x0036: "setMultiDevicesReq",
  0x0037: "getMultiDevicesReq / getMultiDevicesRes",
  0x0057: "setDeviceUpdateEnergyReq",
  0x005E: "setSuperChargeReq",
  0x005F: "setBMSSubBatteryPowerSwitchReq",
  0x0060: "setBMSSubBatteryLightSwitchReq",
  0x0061: "getAllBMSSubBatteryInfoReq / setA17b1CommandReq",
  0x0065: "requestMcuLogUploadReq",
  0x0066: "mcuLogUploadReq",
  0x0067: "bleOtaProgressReq",
  0x0069: "deviceFactorySettingRes",
  0x006A: "deviceFactorySettingClearRes",
  0x0074: "getA17B2DeviceInfoReq",
  0x0076: "carPortSavingReq",
  0x0077: "acOutputSmartReq",
  0x007A: "setRelaySwitchReq",
  0x007B: "setLocationLightReq",
  0x007C: "setTimingReq",
  0x007D: "getTimingReq",
  0x007E: "setCountdownReq",
  0x007F: "getCountdownReq",
  0x0089: "getOTAStateReq",
  0x0200: "getMiniChargeAllDeviceInfoReq",
  0x0201: "setMiniChargeResetReq",
  0x0202: "getMiniChargeScreensaverReq",
  0x0203: "setMiniChargeScreenTimeoutReq",
  0x0204: "setMiniChargeScreenBrightnessReq",
  0x0205: "setMiniChargeScreensaverReq",
  0x0206: "setMiniChargeACRelaySwitchReq / setMiniChargeACRelaySwitchRes",
  0x0207: "setMiniChargeACRelaySwitchReq",
  0x0400: "postErrorInfoReq",
  0x0401: "postSwitchStateReq",
  0x0402: "postWorkInfoReq",
  0x0403: "postDeviceInfoReq",
  0x0404: "postCountDownTimeReq",
  0x0405: "postDeviceAllInfoReq",
  0x0406: "postUpgradeStateReq / postUpgradeStateRes",
  0x0409: "postAllBMSMinorBatteryBTInfoReq",
  0x040A: "postAllBMSMinorBatteryWiFiInfoReq",
  0x040E: "getMicroInverterReq",
  0x040F: "postSubBatteryErrorInfoReq",
  0x0410: "postA17B2DeviceInfoWIFIReq",
  0x0411: "postA17B2DeviceInfoBTReq",
  0x0460: "getDeviceSelfTestRes",
  0x0489: "upUpgradeCondition",
  0x0500: "postA17b1DeviceInfoReq",
  0x0501: "postA17b1SelfCheckReq",
  0x0503: "postDeviceListReq",
  0x0601: "postA1790DeviceInfoReq",
  0x0602: "setA1790CommandReq",
  0x0604: "postGetUpdateListReq",
  0x0801: "startConnectRes",
  0x0802: "startDisconnectRes",
  0x0803: "capabilityNegotiationRes",
  0x0805: "setCapabilityRes",
  0x0821: "getModuleInfoRes / getPublicKeyRes",
  0x0822: "getAesKeyRes / scanWifiRes",
  0x0823: "bindUserIdRes / getWifiListRes",
  0x0824: "connectWifiRes",
  0x0825: "activateWifiRes",
  0x0827: "getAuthenticationRes",
  0x0829: "getDeviceInfoRes",
  0x0830: "getZXOTAStateRes",
  0x0831: "getScanBluetoothDeviceRes / requestModuleLogUploadRes",
  0x0832: "getBindBluetoothDeviceRes",
  0x0833: "getUnBindBluetoothDeviceRes",
  0x0835: "exitConnectRes",
  0x0836: "setMultiDevicesRes",
  0x0840: "getAllDeviceInfoRes",
  0x0841: "getAcCarCountDownTimeRes",
  0x0842: "setAcCountDownTimeRes / setCarCountDownTimeRes",
  0x0844: "setAcChargePowerRes",
  0x0845: "setDeviceWaitTimeRes",
  0x0846: "setDeviceScreenTimeRes",
  0x0847: "setInversionWaitTimeRes",
  0x0848: "setMajorPkgRes",
  0x0849: "setMinorPkgRes",
  0x084A: "setAcSwitchRes",
  0x084B: "setCarSwitchRes",
  0x084C: "setLcdLightRes",
  0x084D: "setAcFrequencyRes",
  0x084E: "setEnergyModeRes",
  0x084F: "setAmbientLightRes",
  0x0850: "setTempUnitRes",
  0x0851: "setResetRes",
  0x085E: "setDischargeTimeRes / setSuperChargeRes",
  0x085F: "setBMSSubBatteryPowerSwitchRes",
  0x0860: "setBMSSubBatteryLightSwitchRes",
  0x0861: "getAllBMSSubBatteryInfoRes / setA17b1CommandRes",
  0x0865: "requestMcuLogUploadRes",
  0x0866: "mcuLogUploadRes",
  0x0867: "bleOtaProgressRes",
  0x0869: "deviceFactorySettingReq",
  0x086A: "deviceFactorySettingClearReq",
  0x0874: "getA17B2DeviceInfoRes",
  0x0876: "carPortSavingRes",
  0x0877: "acOutputSmartRes",
  0x087A: "setRelaySwitchRes",
  0x087B: "setLocationLightRes",
  0x087C: "setTimingRes",
  0x087D: "getTimingRes",
  0x087E: "setCountdownRes",
  0x087F: "getCountdownRes",
  0x0889: "getOTAStateRes",
  0x0A00: "getMiniChargeAllDeviceInfoRes",
  0x0A01: "setMiniChargeResetRes",
  0x0A02: "getMiniChargeScreensaverRes",
  0x0A03: "setMiniChargeScreenTimeoutRes",
  0x0A04: "setMiniChargeScreenBrightnessRes",
  0x0A05: "setMiniChargeScreensaverRes",
  0x0A07: "setMiniChargeACRelaySwitchRes",
};

/** Status byte the device prefixes to decrypted payloads. */
export const STATUS_CODE_OK = 0x00;

/**
 * Opcodes handled by dedicated parse routines but absent from the app's opcode
 * enum - dispatched by literal value in the notification handler.
 */
export const OP_LIVE_POWER = 0x050E;
export const OP_TEMPERATURE = 0x0522;
export const OP_SET_THEME = 0x0504;
export const OP_SET_BEEP = 0x0505;

/** Logical channels encoded in byte 2 of the pattern (`03 00 <group>`). */
export const CommandGroup = Object.freeze({
  MANAGEMENT: 0x01,
  POWER: 0x11,
});

/** Named opcodes used by the client. */
export const Opcode = Object.freeze({
  START_CONNECT_REQ: 0x0001,
  START_DISCONNECT_REQ: 0x0002,
  CAPABILITY_NEGOTIATION_REQ: 0x0003,
  CONFIGURE_CAPABILITY_REQ: 0x0004,
  SET_CAPABILITY_REQ: 0x0005,
  EXIT_CONNECT_REQ: 0x0035,
  GET_MODULE_INFO_REQ: 0x0021,
  GET_AES_KEY_REQ: 0x0022,
  GET_AUTHENTICATION_REQ: 0x0027,
  GET_DEVICE_INFO_REQ: 0x0029,
  POST_DEVICE_INFO_REQ: 0x0020,
  POST_WORK_INFO_REQ: 0x001e,
  POST_DEVICE_ALL_INFO_REQ: 0x0050,
  POST_A17B1_DEVICE_INFO_REQ: 0x0500,
  SET_A17B1_COMMAND_REQ: 0x0061,
  SET_RELAY_SWITCH_REQ: 0x007a,
  SET_LOCATION_LIGHT_REQ: 0x007b,
  SET_TIMING_REQ: 0x007c,
  SET_COUNTDOWN_REQ: 0x007e,
});

/** Fixed handshake capability values. */
export const HANDSHAKE_A3_CAPABILITY = Uint8Array.of(0x20);
export const HANDSHAKE_A4_CAPABILITY = Uint8Array.of(0x00, 0xf0);
export const HANDSHAKE_A5_CAPABILITY = Uint8Array.of(0x02);

/** Tags present in responses from a 2215-family (Prime power bank) device. */
export const RESPONSE_TAGS = {
  0x00A1: "session_key (16B, on getAesKeyRes) / timestamp (on handshake)",
  0x00A2: "battery / device block (SOC at [8:10] x0.01)",
  0x00A3: "firmware version (handshake) | port C2 (status)",
  0x00A4: "serial number (handshake) | port C1 (status)",
  0x00A5: "BT MAC address (handshake) | port C2 (status, 0x0500)",
  0x00A6: "port A (USB-A)",
  0x00A8: "battery block (0x050E live-power reply)",
  0x00AE: "total power: [1:3] output x0.1 W, [3:5] input x0.1 W",
  0x00B3: "temperature: [1] degC, [2] degF",
};

/** Tags the app sends in requests. */
export const REQUEST_TAGS = {
  0x00A1: "session timestamp (4B LE epoch seconds) or port selector (0x21)",
  0x00A2: "static 40-byte handshake blob, or command parameter",
  0x00A3: "capability bitmap / parameter",
  0x00A4: "capability parameter",
  0x00A5: "capability parameter / zero-filled reservation",
  0x00FD: "timestamp, milliseconds (CMD_COMMON_V2)",
  0x00FE: "timestamp, epoch seconds (older firmware)",
};

/**
 * Per-port telemetry layout inside tags A4/A5/A6 of a 0x0500 status dump.
 * `power` is computed as voltage * current, it is not transmitted.
 */
export const PORT_BLOCK_LAYOUT = Object.freeze({
  mode: { offset: 2, size: 1, meaning: "0=off, 1=input, 2=output" },
  voltage: { offset: 3, size: 2, scale: 10, unit: "V" },
  current: { offset: 5, size: 2, scale: 10, unit: "A" },
});

/** Opcodes whose TLV tag maps are worth showing in the UI. */
export function tagName(tag, kind = "response") {
  const table = kind === "request" ? REQUEST_TAGS : RESPONSE_TAGS;
  return table[tag] ?? null;
}
