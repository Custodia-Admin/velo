/**
 * DataSettings.tsx — Data tab: backup export/import, local inventory, and a
 * full browser-storage + IndexedDB reset.
 */

import { useState, useCallback, useEffect } from 'react';
import {
  Database,
  Download,
  Loader2,
  Trash2,
  Upload,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Section } from '@/components/ui/section-header';
import {
  clearAllLocalData,
  createBackupEnvelope,
  getLocalDataInventory,
  restoreBackupEnvelope,
  type BackupEnvelope,
  type LocalDataInventory,
} from '@/lib/dataBackup';

// ---------------------------------------------------------------------------
// Data tab root
// ---------------------------------------------------------------------------

export function DataSettings() {
  return (
    <div className="space-y-6">
      <DataInventorySection />
      <ClearDataSection />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Clear local data
// ---------------------------------------------------------------------------

function DataInventorySection() {
  const [inventory, setInventory] = useState<LocalDataInventory | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      setInventory(await getLocalDataInventory());
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleExport = useCallback(async () => {
    setBusy(true);
    setMessage(null);
    try {
      const backup = await createBackupEnvelope();
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `globeride-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setMessage('Backup exported.');
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Backup export failed.');
    } finally {
      setBusy(false);
    }
  }, []);

  const handleImport = useCallback(async (file: File | null) => {
    if (!file) return;
    setBusy(true);
    setMessage(null);
    try {
      if (file.size > 25 * 1024 * 1024) {
        throw new Error('Backup file is too large.');
      }
      const text = await file.text();
      const parsed = JSON.parse(text) as BackupEnvelope;
      await restoreBackupEnvelope(parsed);
      setMessage('Backup restored. Reloading…');
      window.location.reload();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Backup import failed.');
      setBusy(false);
    }
  }, []);

  return (
    <Section icon={<Database className="h-4 w-4" />} title="Data inventory">
      <div className="space-y-3">
        <p className="text-[11px] text-muted-foreground leading-relaxed">
          Data is stored on this device in IndexedDB and browser storage. Live terrain,
          maps, route generation, elevation and AI calls still require network access unless cached.
        </p>

        {inventory && (
          <div className="grid grid-cols-2 gap-2 text-xs">
            <InventoryTile label="Routes" value={`${inventory.stores.routes.count}`} sub={formatBytes(inventory.stores.routes.bytes)} />
            <InventoryTile label="Workouts" value={`${inventory.stores.workouts.count}`} sub={formatBytes(inventory.stores.workouts.bytes)} />
            <InventoryTile label="Rides" value={`${inventory.stores.rides.count}`} sub={formatBytes(inventory.stores.rides.bytes)} />
            <InventoryTile label="Settings" value={`${inventory.persistedState.localStorageKeys + inventory.persistedState.sessionStorageKeys}`} sub={formatBytes(inventory.persistedState.bytes)} />
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={handleExport} disabled={busy}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
            Export backup
          </Button>
          <label className="inline-flex">
            <input
              type="file"
              accept="application/json,.json"
              className="sr-only"
              onChange={(e) => void handleImport(e.currentTarget.files?.[0] ?? null)}
            />
            <span className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-background px-3 text-xs font-medium text-foreground hover:bg-muted cursor-pointer">
              <Upload className="h-3.5 w-3.5" />
              Import backup
            </span>
          </label>
          <Button variant="ghost" size="sm" onClick={() => void refresh()} disabled={busy}>
            Refresh
          </Button>
        </div>

        {message && <p className="text-[11px] text-muted-foreground">{message}</p>}
      </div>
    </Section>
  );
}

function InventoryTile({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="rounded-lg border border-border bg-card/40 px-3 py-2">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-sm font-semibold text-foreground">{value}</div>
      <div className="text-[10px] text-muted-foreground">{sub}</div>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function ClearDataSection() {
  const [confirming, setConfirming] = useState(false);

  const handleClear = useCallback(async () => {
    await clearAllLocalData();
    window.location.reload();
  }, []);

  return (
    <Section icon={<Trash2 className="h-4 w-4" />} title="Local data">
      <div className="space-y-3">
        <p className="text-[11px] text-muted-foreground leading-relaxed">
          Velo stores all your data locally — routes, rides, gear, and settings. Clearing resets
          everything to factory defaults and removes all saved routes from IndexedDB.
        </p>
        {!confirming ? (
          <Button
            variant="outline"
            size="sm"
            className="border-destructive/40 text-destructive hover:bg-destructive/10 hover:border-destructive focus-visible:ring-destructive/40"
            onClick={() => setConfirming(true)}
          >
            <Trash2 className="h-3.5 w-3.5" />
            Clear all local data…
          </Button>
        ) : (
          <div className="flex items-center gap-2">
            <Button variant="destructive" size="sm" onClick={handleClear}>
              Yes, clear everything
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        )}
      </div>
    </Section>
  );
}
