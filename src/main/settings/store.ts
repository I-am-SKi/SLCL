import Store from 'electron-store';
import { app } from 'electron';
import { join } from 'path';
import type { AppSettings } from '@shared/types';

function defaultSettings(): AppSettings {
  const resourcePath = join(app.getPath('appData'), '.minecraft');
  return {
    resourcePath,
    gameDirs: [resourcePath],
    curseforgeApiKey: '',
    theme: 'emerald',
    colorMode: 'dark',
    backgroundImage: '',
    backgroundOpacity: 0.35,
    versionOverrides: {},
    javaPath: '',
    javaSelection: 'auto',
    maxMemory: 4096,
    minMemory: 512,
    jvmArgs: '',
    resolution: { width: 1280, height: 720 },
    fullscreen: false,
    accounts: [],
    selectedAccountId: null,
    selectedVersionId: null,
    manualJavaPaths: [],
  };
}

// NOTE: electron-store/conf's `DefaultsOf<T>` flattens index-signature maps
// (like `versionIsolation: Record<string, boolean>`) into template-literal keys,
// which breaks the generic. We therefore type the store loosely and cast at the
// read/write boundaries.
const store = new Store({ defaults: defaultSettings() as unknown as Record<string, unknown> });

// ---- Migration: legacy `gamePath` (pre-instance model) -> `resourcePath` ----
// Older builds stored a single `gamePath`. Move it to `resourcePath` so existing
// versions/libraries/assets keep resolving, then drop stale keys.
function migrate(): void {
  const raw = store.store as Record<string, unknown>;
  if (typeof raw.gamePath === 'string' && raw.gamePath.trim() !== '') {
    store.set('resourcePath', raw.gamePath);
    store.delete('gamePath');
  }
  // Drop removed keys (instance model + per-version isolation flag).
  store.delete('instances');
  store.delete('selectedInstanceId');
  store.delete('versionIsolation');

  // New in the multi-folder model: make sure `resourcePath` is part of `gameDirs`.
  const settings = store.store as unknown as AppSettings;
  const dirs = Array.isArray(settings.gameDirs) ? settings.gameDirs.filter((d) => typeof d === 'string' && d) : [];
  const resourcePath = typeof settings.resourcePath === 'string' ? settings.resourcePath : '';
  if (resourcePath && !dirs.includes(resourcePath)) dirs.unshift(resourcePath);
  store.set('gameDirs', dirs.length > 0 ? dirs : resourcePath ? [resourcePath] : []);

  // New in the per-version launch settings model: ensure the override map exists.
  const overrides = (store.store as Record<string, unknown>).versionOverrides;
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    store.set('versionOverrides', {});
  }

  // New in the 主页 launch-version model: must be a string or null.
  const selected = (store.store as Record<string, unknown>).selectedVersionId;
  if (selected !== null && typeof selected !== 'string') {
    store.set('selectedVersionId', null);
  }
}
migrate();

export function getSettings(): AppSettings {
  // Re-read each time so the persisted object is always fresh.
  return store.store as unknown as AppSettings;
}

export function updateSettings(patch: Partial<AppSettings>): AppSettings {
  store.set(patch as unknown as Record<string, unknown>);
  // Changing the active game folder must keep it in the scanned folder list.
  if (typeof patch.resourcePath === 'string' && patch.resourcePath.trim() !== '') {
    const current = (store.store as unknown as AppSettings).gameDirs;
    const dirs = Array.isArray(current) ? current : [];
    if (!dirs.includes(patch.resourcePath)) store.set('gameDirs', [patch.resourcePath, ...dirs]);
  }
  return store.store as unknown as AppSettings;
}
