import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement, Fragment } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  LINUX_BLUETOOTH_FLAG,
  detectBluetoothSupport,
  probeBluetoothAdapter,
  type BluetoothSupportReport,
} from './bluetoothSupport';
import { troubleshootSteps } from '@/components/trainer/BluetoothTroubleshooter';

const LINUX_CHROME =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36';
const MAC_SAFARI =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';

function stubBrowser(ua: string, bluetooth: unknown, secure = true) {
  vi.stubGlobal('navigator', { userAgent: ua, platform: '', ...(bluetooth ? { bluetooth } : {}) });
  vi.stubGlobal('window', { isSecureContext: secure });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const ready: BluetoothSupportReport = {
  apiPresent: true,
  secureContext: true,
  adapterAvailable: null,
  userAgent: 'chrome',
  platform: 'linux',
  usable: true,
  reason: null,
  reasonCode: null,
};

const noSleep = () => Promise.resolve();

describe('detectBluetoothSupport', () => {
  it('API present on Linux Chrome: usable, no browser or flag complaint', () => {
    stubBrowser(LINUX_CHROME, { getAvailability: async () => true });
    const r = detectBluetoothSupport();
    expect(r.apiPresent).toBe(true);
    expect(r.usable).toBe(true);
    expect(r.reasonCode).toBeNull();
  });

  it('API missing on Linux Chrome: points at the one flag that enables it', () => {
    stubBrowser(LINUX_CHROME, null);
    const r = detectBluetoothSupport();
    expect(r.reasonCode).toBe('linux-flag-off');
    expect(r.reason).toContain(LINUX_BLUETOOTH_FLAG);
    expect(r.reason).not.toContain('experimental');
  });

  it('Safari without the API: browser advice', () => {
    stubBrowser(MAC_SAFARI, null);
    expect(detectBluetoothSupport().reasonCode).toBe('safari-unsupported');
  });
});

describe('probeBluetoothAdapter', () => {
  it('a momentary false is retried, not reported', async () => {
    const answers = [false, true];
    const ask = vi.fn(async () => answers.shift() ?? false);
    const r = await probeBluetoothAdapter(ready, { getAvailability: ask, sleep: noSleep });
    expect(ask).toHaveBeenCalledTimes(2);
    expect(r.adapterAvailable).toBe(true);
    expect(r.usable).toBe(true);
  });

  it('asks 3 times about 2 s apart before saying off or busy', async () => {
    const ask = vi.fn(async () => false);
    const waits: number[] = [];
    const r = await probeBluetoothAdapter(ready, {
      getAvailability: ask,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    expect(ask).toHaveBeenCalledTimes(3);
    expect(waits.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(1500);
    expect(waits.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(2500);
    expect(r.reasonCode).toBe('adapter-unavailable');
    expect(r.apiPresent).toBe(true);
    expect(r.reason).toMatch(/off or busy/);
    expect(r.reason).not.toMatch(/browser|flag/i);
  });

  it('a throwing probe is unknown, not broken', async () => {
    const r = await probeBluetoothAdapter(ready, {
      getAvailability: async () => {
        throw new Error('policy');
      },
      sleep: noSleep,
    });
    expect(r).toEqual(ready);
  });

  it('does nothing when the API is absent', async () => {
    const absent = { ...ready, apiPresent: false, usable: false, reasonCode: 'linux-flag-off' as const };
    const ask = vi.fn(async () => true);
    expect(await probeBluetoothAdapter(absent, { getAvailability: ask })).toBe(absent);
    expect(ask).not.toHaveBeenCalled();
  });
});

describe('troubleshootSteps', () => {
  const text = (r: BluetoothSupportReport) =>
    renderToStaticMarkup(
      createElement(
        Fragment,
        null,
        ...troubleshootSteps(r).map((s) => createElement('section', { key: s.id }, s.title, s.body)),
      ),
    );

  it('API present: no browser step, no flag advice to switch things on', () => {
    const ids = troubleshootSteps(ready).map((s) => s.id);
    expect(ids).not.toContain('browser');
    expect(ids).not.toContain('https');
    expect(ids).toContain('empty');
    const html = text(ready);
    expect(html).not.toContain('Use a supported browser');
    expect(html).not.toContain('experimental-web-platform-features');
  });

  it('empty chooser step: re-scan, show all devices, reset other flags but keep Web Bluetooth on Linux', () => {
    const html = text(ready);
    expect(html).toContain('Re-scan');
    expect(html).toContain('Show all devices');
    expect(html).toContain('needs exactly one flag');
    expect(html).toContain(LINUX_BLUETOOTH_FLAG);
    expect(html).toContain('back to Default');
    // The advice that broke the chooser on Linux (29 Oct): never a full reset there.
    expect(html).not.toMatch(/reset all/i);
    expect(html).not.toMatch(/set (them|all flags) back to Default/);
  });

  it('other systems: reset changed flags, never a Linux flag', () => {
    const html = text({ ...ready, platform: 'windows' });
    expect(html).toContain('set those back to Default');
    expect(html).not.toContain(LINUX_BLUETOOTH_FLAG);
  });

  it('the pairing guide copy names no other app or brand, and no experimental flag', () => {
    for (const r of [ready, { ...ready, platform: 'windows' }]) {
      const html = text(r);
      expect(html).not.toMatch(/zwift|wahoo|trainerroad|mywhoosh|globeride/i);
      expect(html).not.toMatch(/experimental/i);
      expect(html).not.toMatch(/LIVE badge|GATT|FTMS/);
    }
  });

  it('Linux Chrome without the API: the flag step, and only then', () => {
    const r: BluetoothSupportReport = {
      ...ready,
      apiPresent: false,
      usable: false,
      reasonCode: 'linux-flag-off',
      reason: 'flag',
    };
    const steps = troubleshootSteps(r);
    expect(steps.map((s) => s.id)).toContain('browser');
    expect(text(r)).toContain(LINUX_BLUETOOTH_FLAG);
    expect(steps.find((s) => s.id === 'browser')?.title).toBe('Turn on Web Bluetooth in Chrome');
  });

  it('insecure page: HTTPS step', () => {
    expect(troubleshootSteps({ ...ready, secureContext: false }).map((s) => s.id)).toContain('https');
  });
});
