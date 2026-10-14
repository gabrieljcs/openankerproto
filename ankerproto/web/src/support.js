/** Browser names are hints; capabilities determine compatibility. */
export function browserName(nav = {}) {
  const ua = nav.userAgent ?? '';
  if (/Edg(?:e|A|iOS)?\//.test(ua)) return 'Microsoft Edge';
  if (/OPR\/|Opera/.test(ua)) return 'Opera';
  if (/Firefox\/|FxiOS\//.test(ua)) return 'Firefox';
  if (/Chrome\/|Chromium\/|CriOS\//.test(ua)) return 'Google Chrome / Chromium';
  if (/Safari\//.test(ua)) return 'Safari';
  return 'Your browser';
}

export function assessSupport({ nav = {}, secure = false, policyAllowed = true, brave = false, available = null } = {}) {
  const browser = brave ? 'Brave' : browserName(nav);
  const result = (state, title, message, canConnect) => ({ browser, state, title, message, canConnect });
  if (!secure) return result('blocked', 'Secure connection required', 'Open this site over HTTPS or localhost to use Bluetooth. Demo mode still works.', false);
  if (!policyAllowed) return result('blocked', 'Bluetooth blocked by page policy', 'Open the website directly in a new tab. An embedded page or site policy is blocking Bluetooth access.', false);
  if (typeof nav.bluetooth?.requestDevice !== 'function') {
    const ios = /iPad|iPhone|iPod/.test(nav.userAgent ?? '') || (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1);
    const advice = ios ? 'This iPhone or iPad browser does not expose Web Bluetooth. Use a supported desktop or Android browser.'
      : /Linux/.test(nav.userAgent ?? '') && !/Android/.test(nav.userAgent ?? '') && /Chrome|Chromium|Edge/.test(browser)
        ? 'Web Bluetooth is missing. Linux Chrome may require Experimental Web Platform features in chrome://flags, followed by a browser restart.'
        : 'Web Bluetooth is missing or disabled. Try Google Chrome or Microsoft Edge on a supported desktop, or Chrome on Android.';
    return result('blocked', 'Bluetooth unavailable in this browser', `${advice} You can still try the demo.`, false);
  }
  if (brave) return result('warning', 'Brave may block Bluetooth', 'The Bluetooth API is exposed, but Brave can block discovery. If the picker is empty or blocked, open this page in Google Chrome or Microsoft Edge.', true);
  if (available === false) return result('warning', 'Bluetooth is not currently available', 'The browser exposes Web Bluetooth, but reports it unavailable. Turn on Bluetooth, check for an adapter, and review browser/system permissions. Then recheck or try connecting.', true);
  return result('supported', 'Browser supports Bluetooth connections', available === true
    ? 'Web Bluetooth is available. Choose Connect to grant access to a nearby device. Device compatibility and system permissions are checked when connecting.'
    : 'Web Bluetooth is present. Adapter availability could not be confirmed; choose Connect to check permissions and select a device.', true);
}

export async function detectSupport(nav = navigator, doc = document, secure = window.isSecureContext) {
  const policy = doc.permissionsPolicy ?? doc.featurePolicy;
  let policyAllowed = true;
  try { policyAllowed = policy?.allowsFeature ? policy.allowsFeature('bluetooth') : true; } catch { /* No reliable policy probe. */ }
  async function bounded(probe) {
    let timer;
    try { return await Promise.race([Promise.resolve().then(probe), new Promise(resolve => { timer = setTimeout(() => resolve(null), 1500); })]); }
    catch { return null; }
    finally { clearTimeout(timer); }
  }
  const [brave, available] = await Promise.all([
    bounded(() => nav.brave?.isBrave?.()),
    bounded(() => nav.bluetooth?.getAvailability?.()),
  ]);
  return assessSupport({ nav, secure, policyAllowed, brave: brave === true, available });
}
