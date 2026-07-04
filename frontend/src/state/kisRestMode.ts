import { create } from 'zustand';

export const KIS_REST_FAILURE_TOAST_COOLDOWN_MS = 5 * 60_000;

const STORAGE_KEY = 'chart.kisRestMode.v1';
const MIGRATED_KEY = 'chart.kisRestMode.v1.migrated';

type KisRestWarningLike = {
  reason?: string | null;
  msg?: string | null;
};

interface Store {
  lastFailureAtMs: number | null;
  lastToastAtMs: number | null;
  notifyFailure: (nowMs?: number) => boolean;
}

export function readLegacyKisRestBypass(): { kisRestBypassEnabled: boolean } | null {
  try {
    if (localStorage.getItem(MIGRATED_KEY) === 'true') return null;
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { kisRestBypassEnabled?: unknown };
    return parsed.kisRestBypassEnabled === true ? { kisRestBypassEnabled: true } : null;
  } catch {
    return null;
  }
}

export function markLegacyKisRestBypassMigrated(): void {
  try {
    localStorage.setItem(MIGRATED_KEY, 'true');
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // localStorage may be unavailable.
  }
}

export function kisRestWarningIndicatesUnavailable(warning: KisRestWarningLike): boolean {
  const reason = warning.reason ?? '';
  const msg = warning.msg ?? '';
  if (reason === 'kis_transport_error' || reason === 'kis_rest_unavailable') return true;
  if (reason === 'kis_rate_limit' || reason === 'rate_limit_aborted') return true;
  if (reason === 'kis_api_error' && msg.includes('TRANSPORT/')) return true;
  return false;
}

export const useKisRestModeStore = create<Store>((set, get) => ({
  lastFailureAtMs: null,
  lastToastAtMs: null,

  notifyFailure: (nowMs = Date.now()) => {
    const lastToastAtMs = get().lastToastAtMs;
    set({ lastFailureAtMs: nowMs });
    if (lastToastAtMs != null && nowMs - lastToastAtMs < KIS_REST_FAILURE_TOAST_COOLDOWN_MS) {
      return false;
    }
    set({ lastToastAtMs: nowMs });
    return true;
  },
}));
