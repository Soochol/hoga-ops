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
  /** 사용자가 토스트를 닫았는가(× 또는 우회 ON). lastToastAtMs는 쿨다운 앵커로 보존하고
   * 가시성만 이 플래그로 분리 — 닫아도 쿨다운은 유지되고, 쿨다운 경과 후 재실패면 다시 뜬다. */
  toastDismissed: boolean;
  notifyFailure: (nowMs?: number) => boolean;
  dismissToast: () => void;
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
  toastDismissed: false,

  notifyFailure: (nowMs = Date.now()) => {
    const lastToastAtMs = get().lastToastAtMs;
    set({ lastFailureAtMs: nowMs });
    if (lastToastAtMs != null && nowMs - lastToastAtMs < KIS_REST_FAILURE_TOAST_COOLDOWN_MS) {
      // 쿨다운 중 — 닫힌 상태를 존중해 재노출하지 않는다.
      return false;
    }
    // 새 알림 창(쿨다운 경과): 이전에 닫혔더라도 다시 띄운다.
    set({ lastToastAtMs: nowMs, toastDismissed: false });
    return true;
  },

  dismissToast: () => set({ toastDismissed: true }),
}));
