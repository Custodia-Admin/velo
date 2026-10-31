import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowRight,
  Bluetooth,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  RefreshCw,
  X,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import {
  LINUX_BLUETOOTH_FLAG,
  detectBluetoothSupport,
  probeBluetoothAdapter,
  type BluetoothSupportReport,
} from '@/lib/bluetoothSupport';

/**
 * Step-by-step modal for getting a Wahoo Kickr Core (or any FTMS trainer)
 * paired over Web Bluetooth. Opens from the connect card and from the
 * "Trouble pairing?" affordance on connection errors.
 *
 * The live capability report at the top drives the steps: browser advice
 * only appears when the browser really lacks Web Bluetooth, HTTPS advice
 * only on an insecure page. When the API is there but the adapter looks off
 * or busy, the report says so and offers Retry.
 */
export type TroubleshootStepId =
  | 'wake'
  | 'others'
  | 'browser'
  | 'https'
  | 'permission'
  | 'chooser'
  | 'empty';

export interface BluetoothTroubleshooterProps {
  open: boolean;
  onClose: () => void;
  /** Optional: jump straight to a specific step (e.g. permission denied). */
  initialStep?: TroubleshootStepId;
  /** Optional: triggered by the "Try pairing now" CTA at the bottom. */
  onRetryConnect?: () => void;
}

export interface TroubleshootStep {
  id: TroubleshootStepId;
  title: string;
  body: React.ReactNode;
}

function Code({ children }: { children: React.ReactNode }) {
  return <code className="mx-0.5 rounded bg-muted px-1 py-0.5 text-xs">{children}</code>;
}

/** Steps for this environment. Exported for tests. */
export function troubleshootSteps(report: BluetoothSupportReport): TroubleshootStep[] {
  const steps: TroubleshootStep[] = [
    {
      id: 'wake',
      title: 'Wake the Kickr',
      body: (
        <p>
          The Kickr sleeps after a few idle minutes and stops advertising. Turn
          the cranks once; the LED should blink blue.
        </p>
      ),
    },
    {
      id: 'others',
      title: 'Close other apps that talk to the trainer',
      body: (
        <>
          <p>
            A trainer takes one connection at a time. Quit Zwift, Wahoo,
            TrainerRoad or MyWhoosh, and turn off Bluetooth on phones or
            tablets that auto-connect to it.
          </p>
          <p className="text-xs text-muted-foreground mt-2">
            A Bluetooth scan running in another app can also keep the adapter
            busy for a moment.
          </p>
        </>
      ),
    },
  ];

  if (!report.apiPresent) {
    const linux = report.reasonCode === 'linux-flag-off';
    steps.push({
      id: 'browser',
      title: linux ? 'Turn on Web Bluetooth in Chrome' : 'Use a supported browser',
      body: linux ? (
        <p>
          Chrome on Linux ships Web Bluetooth switched off. Open <Code>{LINUX_BLUETOOTH_FLAG}</Code>,
          set it to <strong className="text-foreground">Enabled</strong> and relaunch Chrome. Leave
          the other flags on Default.
        </p>
      ) : (
        <p>
          {report.reason ??
            "This browser can't reach the trainer. Use Chrome or Edge on a computer or Android device."}
        </p>
      ),
    });
  }

  if (!report.secureContext) {
    steps.push({
      id: 'https',
      title: 'Open the app over HTTPS or localhost',
      body: (
        <p>
          Web Bluetooth only runs on secure pages. Use the https:// address, or{' '}
          <Code>http://localhost:5173</Code> on the computer running the app.
        </p>
      ),
    });
  }

  steps.push(
    {
      id: 'permission',
      title: 'Allow Bluetooth for this site',
      body: (
        <p>
          If you blocked Bluetooth once, the chooser stays hidden. Click the icon
          left of the address bar, open <em>Site settings</em>, set Bluetooth back
          to <em>Ask</em> and reload.
        </p>
      ),
    },
    {
      id: 'chooser',
      title: 'Pick the Kickr in the chooser',
      body: (
        <p>
          Choose the entry starting with <Code>KICKR</Code> (for example{' '}
          <Code>KICKR CORE 78C1</Code>) and click <strong className="text-foreground">Pair</strong>.
          The status turns green with a LIVE badge.
        </p>
      ),
    },
    {
      id: 'empty',
      title: 'The chooser finds nothing',
      body: (
        <ol className="list-decimal pl-5 space-y-1">
          <li>Press <em>Re-scan</em> in the chooser, or close it and pair again.</li>
          <li>
            Still empty? Use <strong className="text-foreground">Show all devices</strong> and
            pick the name starting with <Code>KICKR</Code>.
          </li>
          <li>
            If you changed Bluetooth flags in <Code>chrome://flags</Code>, set them back to
            Default and relaunch.
            {report.platform === 'linux' && (
              <> On Linux keep <Code>{LINUX_BLUETOOTH_FLAG}</Code> Enabled.</>
            )}
          </li>
        </ol>
      ),
    },
  );
  return steps;
}

export function BluetoothTroubleshooter({
  open,
  onClose,
  initialStep = 'wake',
  onRetryConnect,
}: BluetoothTroubleshooterProps) {
  const [report, setReport] = useState<BluetoothSupportReport>(() => detectBluetoothSupport());
  const [probing, setProbing] = useState(false);
  const [openStep, setOpenStep] = useState<TroubleshootStepId | null>(initialStep);
  const [probeRun, setProbeRun] = useState(0);

  // Probe when the modal opens and on Retry — the user may have just
  // toggled the OS Bluetooth switch.
  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    const baseline = detectBluetoothSupport();
    setReport(baseline);
    setProbing(true);
    void probeBluetoothAdapter(baseline).then((full) => {
      if (cancelled) return;
      setReport(full);
      setProbing(false);
    });
    return () => {
      cancelled = true;
    };
  }, [open, probeRun]);

  useEffect(() => {
    if (open) setOpenStep(initialStep);
  }, [open, initialStep]);

  const retryProbe = useCallback(() => setProbeRun((n) => n + 1), []);

  // ESC + body-scroll lock
  useEffect(() => {
    if (!open) return undefined;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  const steps = useMemo(() => troubleshootSteps(report), [report]);

  if (!open) return null;

  // Pairing can be attempted whenever the browser can do it at all; a
  // "Bluetooth off" reading can be stale, so it never blocks the attempt.
  const canTry = report.apiPresent && report.secureContext;

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-background/95 backdrop-blur-md p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="bt-troubleshoot-title"
    >
      <div className="glass glass-hairline rounded-2xl w-full max-w-xl max-h-[88vh] overflow-hidden flex flex-col">
        <header className="flex items-start justify-between gap-4 px-5 py-4 border-b border-border/60">
          <div className="flex items-start gap-3">
            <div className="rounded-lg bg-primary/15 text-primary p-2">
              <Bluetooth className="h-5 w-5" />
            </div>
            <div>
              <h2
                id="bt-troubleshoot-title"
                className="text-base font-semibold text-foreground"
              >
                Pair a smart trainer
              </h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                Written for the Wahoo Kickr Core; any FTMS trainer works the same.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="overflow-y-auto px-5 py-4 space-y-4">
          <CapabilityReport report={report} probing={probing} onRetry={retryProbe} />

          <ol className="space-y-2">
            {steps.map((step, i) => (
              <StepDisclosure
                key={step.id}
                index={i}
                title={step.title}
                isOpen={openStep === step.id}
                onToggle={() => setOpenStep(openStep === step.id ? null : step.id)}
              >
                <div className="text-sm text-muted-foreground leading-relaxed space-y-2">
                  {step.body}
                </div>
              </StepDisclosure>
            ))}
          </ol>
        </div>

        <footer className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border/60">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
          {onRetryConnect && (
            <Button
              variant="accent"
              size="sm"
              onClick={() => {
                onRetryConnect();
                onClose();
              }}
              disabled={!canTry}
            >
              {report.usable || !canTry ? 'Try pairing now' : 'Pair anyway'}
              <ArrowRight className="h-4 w-4" />
            </Button>
          )}
        </footer>
      </div>
    </div>
  );
}

function CapabilityReport({
  report,
  probing,
  onRetry,
}: {
  report: BluetoothSupportReport;
  probing: boolean;
  onRetry: () => void;
}) {
  const adapterOff = report.apiPresent && report.adapterAvailable === false;
  const checks: { label: string; ok: boolean; note?: string }[] = [
    {
      label: 'Browser exposes Web Bluetooth',
      ok: report.apiPresent,
      note: report.apiPresent ? undefined : (report.reason ?? undefined),
    },
    {
      label: 'Page is a secure context (HTTPS / localhost)',
      ok: report.secureContext,
      note: report.secureContext ? undefined : 'Reload over https:// or use localhost.',
    },
  ];
  if (report.apiPresent) {
    checks.push({
      label: 'Bluetooth is on and free',
      ok: report.adapterAvailable !== false,
      note: probing
        ? 'Checking…'
        : adapterOff
          ? 'Looks off or busy. Turn Bluetooth on and close other apps using it.'
          : report.adapterAvailable === null
            ? 'Could not check. Pair anyway.'
            : undefined,
    });
  }

  return (
    <div className="rounded-xl border border-border/60 bg-muted/20 p-3">
      <div className="flex items-center justify-between mb-2">
        <div className="text-xs uppercase tracking-wider text-muted-foreground">
          Your environment
        </div>
        {report.usable ? (
          <Badge variant="success">Ready to pair</Badge>
        ) : adapterOff ? (
          <Badge variant="warning">Check Bluetooth</Badge>
        ) : (
          <Badge variant="destructive">Needs attention</Badge>
        )}
      </div>
      <ul className="space-y-1.5">
        {checks.map((c) => (
          <li key={c.label} className="flex items-start gap-2 text-sm">
            <CheckCircle2
              className={cn(
                'h-4 w-4 mt-0.5 shrink-0',
                c.ok ? 'text-emerald-400' : 'text-muted-foreground/60',
              )}
            />
            <div className="flex-1">
              <div className={cn('text-foreground', !c.ok && 'text-muted-foreground')}>
                {c.label}
              </div>
              {c.note && <div className="text-xs text-muted-foreground">{c.note}</div>}
            </div>
          </li>
        ))}
      </ul>
      {adapterOff && (
        <Button
          variant="outline"
          size="sm"
          className="mt-3"
          onClick={onRetry}
          disabled={probing}
          aria-label="Check Bluetooth again"
        >
          <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          {probing ? 'Checking…' : 'Retry'}
        </Button>
      )}
    </div>
  );
}

function StepDisclosure({
  index,
  title,
  isOpen,
  onToggle,
  children,
}: {
  index: number;
  title: string;
  isOpen: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <li
      className={cn(
        'rounded-xl border transition-colors',
        isOpen ? 'border-primary/40 bg-card/60' : 'border-border/60 bg-card/30',
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-3 py-2.5 text-left"
        aria-expanded={isOpen}
      >
        <div
          className={cn(
            'flex items-center justify-center h-6 w-6 rounded-full text-xs font-semibold shrink-0',
            isOpen ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground',
          )}
        >
          {index + 1}
        </div>
        <div className="flex-1 text-sm font-medium text-foreground">{title}</div>
        {isOpen ? (
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
        )}
      </button>
      {isOpen && <div className="px-3 pb-3 pl-12">{children}</div>}
    </li>
  );
}
