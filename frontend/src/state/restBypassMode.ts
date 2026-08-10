import { create } from 'zustand';
import { warningKind, type WireDataWarning } from '../api/dataWarnings';

export const REST_FAILURE_TOAST_COOLDOWN_MS = 5 * 60_000;

const STORAGE_KEY = 'chart.kisRestMode.v1';
const MIGRATED_KEY = 'chart.restBypassMode.v1.migrated';

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
  /** 토스트를 감출 이유가 생겼는가(× · 우회 ON · 수집 회복). lastToastAtMs는 쿨다운
   * 앵커로 보존하고 가시성만 이 플래그로 분리 — 닫아도 쿨다운은 유지되고, 쿨다운 경과
   * 후 재실패면 다시 뜬다. */
  toastDismissed: boolean;
  notifyFailure: (kind: RestFailureKind, nowMs?: number) => boolean;
  resolveFailure: () => void;
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
 * **백엔드가 실은 `kind` 로 가른다**(ADR-0143). 판정 축의 역사가 셋이다:
 * ① `msg` 에서 `'TRANSPORT/'` 문자열 뒤지기(백엔드가 전송 실패를 `api_error` 로
 * 뭉개던 시절) → ② 사유 문자열(ADR-0137 이 사유를 갈라 실으면서) → ③ `kind`
 * (백엔드가 이미 계산해 둔 성격을 그대로 받는다). 매 단계가 역추론을 한 겹씩 걷어냈다.
 *
 * **동작은 동등하다.** `transport` kind 는 `transport_error` 하나뿐이고, `rate_limit`
 * kind 는 `rate_limit_upstream`·`rate_limit_aborted` 정확히 둘이다.
 *
 * `deferred`(우리 쪽 예산·큐 포화)가 `congestion` 으로 가지 않는 것도 이관 전과 같다.
 * 그쪽은 **알릴 것이 없다** — 사용자가 할 일이 없고 다음 사이클에 자동으로 이어받는다.
 * 토스트는 우회를 켜라는 행동 유도인데, 켤 이유가 없는 상황이다.
 */
export function classifyRestWarning(warning: WireDataWarning): RestFailureKind | null {
  switch (warningKind(warning)) {
    case 'transport':
      return 'transport';
    // 벤더의 유량 거절과 우리 쪽 쿨다운(`rate_limit_aborted`)은 사용자 처방이
    // 같아서(기다린다) 백엔드가 같은 kind 로 묶는다.
    case 'rate_limit':
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

  /** 수집이 다시 성공했다 — 표시를 끈다.
   *
   * **왜 필요한가**: 이 토스트는 실패 사건에서만 상태가 움직여서, 회복돼도 아무도
   * 되돌리지 않았다. 그래서 서버가 돌아온 뒤에도 "재시도 중" 이 화면에 남아
   * 사용자에게 거짓을 말했다(같은 뷰포트의 디스크·배경작업 토스트는 폴링 파생이라
   * 회복 시 저절로 사라진다 — 이 호스트만 회복 신호를 안 봤다).
   *
   * **쿨다운 앵커(`lastToastAtMs`)는 지우지 않는다.** 지우면 성공/실패가 번갈아
   * 오는 부분 실패에서 토스트가 매 응답마다 뜨고 사라지길 반복한다. 재알림 간격은
   * 실패 쪽 정책(5분) 그대로 두고, 여기서는 가시성만 끈다.
   *
   * 이미 감춰져 있으면 아무것도 하지 않는다 — 폴링마다 새 상태 객체를 만들지 않기 위해서다.
   */
  resolveFailure: () => {
    if (get().lastToastAtMs != null && !get().toastDismissed) {
      set({ toastDismissed: true });
    }
  },

  dismissToast: () => set({ toastDismissed: true }),
}));
