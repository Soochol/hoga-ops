import { create } from 'zustand';

export const KIS_REST_FAILURE_TOAST_COOLDOWN_MS = 5 * 60_000;

const STORAGE_KEY = 'chart.kisRestMode.v1';

type KisRestWarningLike = {
  reason?: string | null;
  msg?: string | null;
};

interface Store {
  kisRestBypassEnabled: boolean;
  lastFailureAtMs: number | null;
  lastToastAtMs: number | null;
  setKisRestBypassEnabled: (value: boolean) => void;
  notifyFailure: (nowMs?: number) => boolean;
  hydrateFromStorage: () => void;
}

function readStorage(): { kisRestBypassEnabled: boolean } | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { kisRestBypassEnabled?: unknown };
    if (typeof parsed.kisRestBypassEnabled === 'boolean') {
      return { kisRestBypassEnabled: parsed.kisRestBypassEnabled };
    }
    return null;
  } catch {
    return null;
  }
}

function persist(value: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ kisRestBypassEnabled: value }));
  } catch {
    // localStorage may be unavailable — silent fallback.
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
  kisRestBypassEnabled: readStorage()?.kisRestBypassEnabled ?? false,
  lastFailureAtMs: null,
  lastToastAtMs: null,

  setKisRestBypassEnabled: (value) => {
    set({ kisRestBypassEnabled: value });
    persist(value);
  },

  notifyFailure: (nowMs = Date.now()) => {
    const lastToastAtMs = get().lastToastAtMs;
    set({ lastFailureAtMs: nowMs });
    if (lastToastAtMs != null && nowMs - lastToastAtMs < KIS_REST_FAILURE_TOAST_COOLDOWN_MS) {
      return false;
    }
    set({ lastToastAtMs: nowMs });
    return true;
  },

  hydrateFromStorage: () => {
    const stored = readStorage();
    if (stored) set({ kisRestBypassEnabled: stored.kisRestBypassEnabled });
  },
}));
