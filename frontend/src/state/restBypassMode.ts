import { create } from 'zustand';

export const REST_FAILURE_TOAST_COOLDOWN_MS = 5 * 60_000;

const STORAGE_KEY = 'chart.kisRestMode.v1';
const MIGRATED_KEY = 'chart.restBypassMode.v1.migrated';

type RestWarningLike = {
  reason?: string | null;
  msg?: string | null;
};

/** 실패의 성격. 처방이 다르므로 문구도 갈라야 한다.
 *
 * - `transport`: 서버에 **닿지 못했다**. 회선/서버 문제라 저장 데이터 우회가 답이다.
 * - `congestion`: 닿았지만 **지금은 못 준다**(유량 초과 또는 자체 쿨다운). 곧 회복되므로
 *   기다리면 된다 — 이걸 "연결 불가"로 표시하면 멀쩡한 서버를 죽었다고 알리는 셈이다.
 */
export type RestFailureKind = 'transport' | 'congestion';

interface Store {
  lastFailureAtMs: number | null;
  lastToastAtMs: number | null;
  /** 마지막으로 알린 실패의 성격. 토스트 문구를 가르는 유일한 축이다. */
  lastKind: RestFailureKind | null;
  /** 사용자가 토스트를 닫았는가(× 또는 우회 ON). lastToastAtMs는 쿨다운 앵커로 보존하고
   * 가시성만 이 플래그로 분리 — 닫아도 쿨다운은 유지되고, 쿨다운 경과 후 재실패면 다시 뜬다. */
  toastDismissed: boolean;
  notifyFailure: (kind: RestFailureKind, nowMs?: number) => boolean;
  dismissToast: () => void;
}

export function readLegacyRestBypass(): { restBypassEnabled: boolean } | null {
  try {
    if (localStorage.getItem(MIGRATED_KEY) === 'true') return null;
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { restBypassEnabled?: unknown };
    return parsed.restBypassEnabled === true ? { restBypassEnabled: true } : null;
  } catch {
    return null;
  }
}

export function markLegacyRestBypassMigrated(): void {
  try {
    localStorage.setItem(MIGRATED_KEY, 'true');
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // localStorage may be unavailable.
  }
}

/** 백엔드 `data_warnings` 한 건 → 알릴 실패 성격(알릴 것이 없으면 null).
 *
 * **사유 문자열만 본다.** 이전 판은 `msg` 에서 `'TRANSPORT/'` 를 뒤졌는데, 백엔드가
 * 전송 실패를 `api_error` 로 뭉개 보내서 메시지 본문이 유일한 단서였기 때문이다.
 * 백엔드가 `error_policy` 의 사유를 그대로 싣게 되면서 그 우회로가 필요 없어졌다
 * (ADR-0137). 죽은 사유 `kis_rest_unavailable` 도 함께 제거했다 — 백엔드 전체에
 * 0건이었다(KIS 시대 잔재).
 */
export function classifyRestWarning(warning: RestWarningLike): RestFailureKind | null {
  switch (warning.reason ?? '') {
    case 'transport_error':
      return 'transport';
    // `rate_limit_aborted` 는 **우리 쪽 쿨다운**이다(서버는 멀쩡하다). 벤더의 유량
    // 거절과 사용자 처방이 같아서(기다린다) 같은 성격으로 묶는다.
    case 'rate_limit_upstream':
    case 'rate_limit_aborted':
      return 'congestion';
    default:
      return null;
  }
}

export const useRestBypassModeStore = create<Store>((set, get) => ({
  lastFailureAtMs: null,
  lastToastAtMs: null,
  lastKind: null,
  toastDismissed: false,

  notifyFailure: (kind, nowMs = Date.now()) => {
    const lastToastAtMs = get().lastToastAtMs;
    set({ lastFailureAtMs: nowMs });
    if (lastToastAtMs != null && nowMs - lastToastAtMs < REST_FAILURE_TOAST_COOLDOWN_MS) {
      // 쿨다운 중 — 닫힌 상태를 존중해 재노출하지 않는다. 성격도 갱신하지 않는다:
      // 지금 보이는 토스트의 문구가 그 아래에서 바뀌면 사용자가 읽던 내용이 뒤집힌다.
      return false;
    }
    // 새 알림 창(쿨다운 경과): 이전에 닫혔더라도 다시 띄운다.
    set({ lastToastAtMs: nowMs, lastKind: kind, toastDismissed: false });
    return true;
  },

  dismissToast: () => set({ toastDismissed: true }),
}));
