/**
 * Web Bluetooth capability detection.
 *
 * Web Bluetooth is gated by three independent conditions:
 *   1. The browser exposes the API (`navigator.bluetooth`). Chrome / Edge /
 *      Opera do on desktop and Android, except on Linux where Chrome keeps it
 *      behind chrome://flags/#enable-web-bluetooth (verified on Chrome 154
 *      and Chromium 153: a default profile has no `navigator.bluetooth`).
 *   2. The page is served from a Secure Context (HTTPS, localhost, or file://).
 *   3. The OS adapter is on and free. `getAvailability()` answers that, but it
 *      can read false for a moment while BlueZ is busy, so we ask a few times
 *      before saying so — and when the API exists we never blame the browser.
 *
 * The result is rendered into the UI so the user gets a precise reason, not
 * a generic "Bluetooth not supported."
 */

export type UserAgentKind =
  | 'chrome'
  | 'edge'
  | 'opera'
  | 'samsung'
  | 'firefox'
  | 'safari'
  | 'other';

export type PlatformKind = 'macos' | 'windows' | 'linux' | 'android' | 'ios' | 'other';

export interface BluetoothSupportReport {
  /** API surface (`navigator.bluetooth`) is present. */
  apiPresent: boolean;
  /** `window.isSecureContext` — required to *use* Web Bluetooth. */
  secureContext: boolean;
  /** `getAvailability()` — false typically means no Bluetooth radio / disabled. */
  adapterAvailable: boolean | null;
  /** Best-effort UA classification. */
  userAgent: UserAgentKind;
  /** Best-effort platform classification. */
  platform: PlatformKind;
  /** Convenience: true when we have everything we need to call `requestDevice`. */
  usable: boolean;
  /** Human-readable single-sentence reason when `usable` is false. */
  reason: string | null;
  /** Stable code for switching on in the UI. */
  reasonCode:
    | null
    | 'api-missing'
    | 'insecure-context'
    | 'ios-unsupported'
    | 'safari-unsupported'
    | 'firefox-unsupported'
    | 'linux-flag-off'
    | 'adapter-unavailable';
}

/** The one flag Chrome on Linux needs. Other Bluetooth flags should stay Default. */
export const LINUX_BLUETOOTH_FLAG = 'chrome://flags/#enable-web-bluetooth';

function classifyUserAgent(ua: string): UserAgentKind {
  const s = ua.toLowerCase();
  // Order matters: Edge/Opera/Samsung embed "Chrome" in their UA strings.
  if (s.includes('edg/')) return 'edge';
  if (s.includes('opr/') || s.includes('opera/')) return 'opera';
  if (s.includes('samsungbrowser')) return 'samsung';
  if (s.includes('firefox/') || s.includes('fxios/')) return 'firefox';
  // CriOS / FxiOS are Chrome/Firefox on iOS — both use WebKit so behave like Safari.
  if (s.includes('crios/') || s.includes('fxios/')) return 'safari';
  if (s.includes('chrome/')) return 'chrome';
  if (s.includes('safari/')) return 'safari';
  return 'other';
}

function classifyPlatform(ua: string, platform: string): PlatformKind {
  const s = (ua + ' ' + platform).toLowerCase();
  if (s.includes('android')) return 'android';
  if (s.includes('iphone') || s.includes('ipad') || s.includes('ipod')) return 'ios';
  if (s.includes('mac os') || s.includes('macintosh')) return 'macos';
  if (s.includes('win')) return 'windows';
  if (s.includes('linux') || s.includes('cros')) return 'linux';
  return 'other';
}

/**
 * Synchronous baseline — never throws. Use this for first render.
 * Pair with `probeBluetoothAdapter()` to fill in the async `adapterAvailable`.
 */
export function detectBluetoothSupport(): BluetoothSupportReport {
  if (typeof navigator === 'undefined' || typeof window === 'undefined') {
    return {
      apiPresent: false,
      secureContext: false,
      adapterAvailable: null,
      userAgent: 'other',
      platform: 'other',
      usable: false,
      reason: 'Server-side render — Bluetooth check deferred.',
      reasonCode: 'api-missing',
    };
  }

  const userAgent = classifyUserAgent(navigator.userAgent ?? '');
  const platform = classifyPlatform(
    navigator.userAgent ?? '',
    (navigator as Navigator & { platform?: string }).platform ?? '',
  );
  const apiPresent = 'bluetooth' in navigator && !!navigator.bluetooth;
  const secureContext = window.isSecureContext === true;

  // iOS Safari / Chrome / FF on iOS all use WebKit, which does not implement
  // Web Bluetooth. Detect by platform, not just UA.
  if (platform === 'ios') {
    return {
      apiPresent: false,
      secureContext,
      adapterAvailable: null,
      userAgent,
      platform,
      usable: false,
      reason:
        "iOS doesn't support Web Bluetooth at the OS level. Use Demo Mode here, or switch to Chrome / Edge on a Mac, PC, or Android device to pair your trainer.",
      reasonCode: 'ios-unsupported',
    };
  }

  if (!apiPresent) {
    if (userAgent === 'safari') {
      return {
        apiPresent: false,
        secureContext,
        adapterAvailable: null,
        userAgent,
        platform,
        usable: false,
        reason:
          "Safari doesn't ship Web Bluetooth. Open GlobeRide in Chrome or Edge to pair a trainer, or stick with Demo Mode here.",
        reasonCode: 'safari-unsupported',
      };
    }
    if (userAgent === 'firefox') {
      return {
        apiPresent: false,
        secureContext,
        adapterAvailable: null,
        userAgent,
        platform,
        usable: false,
        reason:
          "Firefox doesn't ship Web Bluetooth. Open GlobeRide in Chrome or Edge to pair a trainer.",
        reasonCode: 'firefox-unsupported',
      };
    }
    if (platform === 'linux' && userAgent !== 'samsung' && userAgent !== 'other') {
      return {
        apiPresent: false,
        secureContext,
        adapterAvailable: null,
        userAgent,
        platform,
        usable: false,
        reason: `On Linux, Chrome keeps Web Bluetooth behind a flag. Open ${LINUX_BLUETOOTH_FLAG}, set it to Enabled, then relaunch Chrome.`,
        reasonCode: 'linux-flag-off',
      };
    }
    return {
      apiPresent: false,
      secureContext,
      adapterAvailable: null,
      userAgent,
      platform,
      usable: false,
      reason:
        "This browser doesn't expose Web Bluetooth. Use the latest Chrome or Edge on desktop or Android.",
      reasonCode: 'api-missing',
    };
  }

  if (!secureContext) {
    return {
      apiPresent: true,
      secureContext: false,
      adapterAvailable: null,
      userAgent,
      platform,
      usable: false,
      reason:
        'Web Bluetooth only works over HTTPS (or localhost). The current page is not a secure context.',
      reasonCode: 'insecure-context',
    };
  }

  return {
    apiPresent: true,
    secureContext: true,
    adapterAvailable: null,
    userAgent,
    platform,
    usable: true,
    reason: null,
    reasonCode: null,
  };
}

export interface ProbeOptions {
  /** How many times to ask before reporting the adapter as off. Default 3. */
  attempts?: number;
  /** Wait between attempts, ms. Default 900 (3 attempts ≈ 2 s). */
  delayMs?: number;
  /** Injectable for tests; defaults to navigator.bluetooth.getAvailability. */
  getAvailability?: () => Promise<boolean>;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Async probe — asks `navigator.bluetooth.getAvailability()` up to
 * `attempts` times, because BlueZ can answer false for a moment while
 * another scan holds the adapter. Only when every answer is false is the
 * adapter reported as off or busy. Returns the baseline untouched when the
 * API is absent or probing throws (unknown, not broken).
 */
export async function probeBluetoothAdapter(
  baseline: BluetoothSupportReport = detectBluetoothSupport(),
  opts: ProbeOptions = {},
): Promise<BluetoothSupportReport> {
  const ask =
    opts.getAvailability ??
    (baseline.apiPresent && typeof navigator !== 'undefined' && navigator.bluetooth?.getAvailability
      ? () => navigator.bluetooth.getAvailability()
      : null);
  if (!baseline.apiPresent || !ask) return baseline;
  const attempts = Math.max(1, opts.attempts ?? 3);
  const delayMs = opts.delayMs ?? 900;
  const sleep = opts.sleep ?? defaultSleep;
  try {
    for (let i = 0; i < attempts; i++) {
      if (i > 0) await sleep(delayMs);
      if (await ask()) return { ...baseline, adapterAvailable: true };
    }
  } catch {
    // Some platforms throw on permission policies; treat as unknown.
    return baseline;
  }
  if (!baseline.secureContext) return { ...baseline, adapterAvailable: false };
  return {
    ...baseline,
    adapterAvailable: false,
    usable: false,
    reason: 'Bluetooth looks off or busy. Turn it on, close other apps using it, then retry.',
    reasonCode: 'adapter-unavailable',
  };
}

/** Pretty list of supported browsers for use in UI copy. */
export const SUPPORTED_BROWSERS_HUMAN = 'Chrome, Edge, Opera, or Samsung Internet';
