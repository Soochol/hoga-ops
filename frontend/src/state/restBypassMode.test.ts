import { beforeEach, describe, expect, it } from 'vitest';
import {
  REST_FAILURE_TOAST_COOLDOWN_MS,
  classifyRestWarning,
  markLegacyRestBypassMigrated,
  readLegacyRestBypass,
  useRestBypassModeStore,
} from './restBypassMode';

describe('restBypassMode', () => {
  beforeEach(() => {
    localStorage.clear();
    useRestBypassModeStore.setState({
      lastFailureAtMs: null,
      lastToastAtMs: null,
      lastKind: null,
      toastDismissed: false,
    });
  });

  it('keeps toast timing state without owning backend bypass truth', () => {
    expect(useRestBypassModeStore.getState().lastFailureAtMs).toBeNull();

    useRestBypassModeStore.getState().notifyFailure('transport', 1_000);

    expect(useRestBypassModeStore.getState().lastFailureAtMs).toBe(1_000);
    expect(useRestBypassModeStore.getState().lastToastAtMs).toBe(1_000);
    expect(useRestBypassModeStore.getState().lastKind).toBe('transport');
  });

  it('reads legacy true once for backend migration', () => {
    localStorage.setItem('chart.kisRestMode.v1', JSON.stringify({ restBypassEnabled: true }));

    expect(readLegacyRestBypass()).toEqual({ restBypassEnabled: true });

    markLegacyRestBypassMigrated();

    expect(readLegacyRestBypass()).toBeNull();
  });

  it('dedupes failure toasts inside the cooldown window', () => {
    const first = useRestBypassModeStore.getState().notifyFailure('transport', 1_000);
    const second = useRestBypassModeStore
      .getState()
      .notifyFailure('transport', 1_000 + REST_FAILURE_TOAST_COOLDOWN_MS - 1);
    const third = useRestBypassModeStore
      .getState()
      .notifyFailure('transport', 1_000 + REST_FAILURE_TOAST_COOLDOWN_MS + 1);

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(third).toBe(true);
    expect(useRestBypassModeStore.getState().lastFailureAtMs).toBe(
      1_000 + REST_FAILURE_TOAST_COOLDOWN_MS + 1,
    );
  });

  it('hides the toast on recovery but keeps the cooldown anchor', () => {
    useRestBypassModeStore.getState().notifyFailure('transport', 1_000);

    useRestBypassModeStore.getState().resolveFailure();

    expect(useRestBypassModeStore.getState().toastDismissed).toBe(true);
    // 앵커를 지우면 성공/실패가 번갈아 오는 부분 실패에서 매 응답마다 깜빡인다 —
    // 재알림 간격은 실패 쪽 정책(쿨다운) 그대로 두고 가시성만 끈다.
    expect(useRestBypassModeStore.getState().lastToastAtMs).toBe(1_000);
    expect(useRestBypassModeStore.getState().lastKind).toBe('transport');
  });

  it('does nothing on recovery when no failure was ever announced', () => {
    useRestBypassModeStore.getState().resolveFailure();

    // 가드가 없으면 매 폴링이 새 상태 객체를 만든다(구독자 통지 낭비).
    expect(useRestBypassModeStore.getState().toastDismissed).toBe(false);
    expect(useRestBypassModeStore.getState().lastToastAtMs).toBeNull();
  });

  it('re-announces after recovery once the cooldown has passed', () => {
    useRestBypassModeStore.getState().notifyFailure('transport', 1_000);
    useRestBypassModeStore.getState().resolveFailure();

    const again = useRestBypassModeStore
      .getState()
      .notifyFailure('transport', 1_000 + REST_FAILURE_TOAST_COOLDOWN_MS + 1);

    expect(again).toBe(true);
    expect(useRestBypassModeStore.getState().toastDismissed).toBe(false);
  });

  it('does not swap the visible toast copy mid-cooldown', () => {
    useRestBypassModeStore.getState().notifyFailure('transport', 1_000);
    useRestBypassModeStore.getState().notifyFailure('congestion', 2_000);

    expect(useRestBypassModeStore.getState().lastKind).toBe('transport');
  });

  // ADR-0143 이관: 판정 축이 사유 문자열 → 백엔드가 실은 `kind` 다. 픽스처도 wire 가
  // 실제로 내려보내는 모양을 쓴다(그 값을 싣는 것은 백엔드 가드가 지킨다).
  it('splits transport failure from congestion', () => {
    // 서버에 **닿지 못했다** — 저장 데이터 우회가 처방이다.
    expect(
      classifyRestWarning({ reason: 'transport_error', kind: 'transport', msg: 'ConnectTimeout' }),
    ).toBe('transport');
    // 닿았지만 지금은 못 준다 — 기다리면 된다.
    expect(
      classifyRestWarning({ reason: 'rate_limit_upstream', kind: 'rate_limit', msg: '유량=5' }),
    ).toBe('congestion');
    // 우리 쪽 쿨다운이지만 뿌리가 벤더 거절이라 백엔드가 같은 kind 로 묶는다.
    expect(
      classifyRestWarning({ reason: 'rate_limit_aborted', kind: 'rate_limit', msg: 'cooldown' }),
    ).toBe('congestion');
  });

  it('does not announce vendor rejections', () => {
    // `api_error` 는 벤더가 요청을 거절한 것이라 알림 대상이 아니다 — 저장 데이터
    // 우회로 나아지지 않는다.
    expect(
      classifyRestWarning({ reason: 'api_error', kind: 'vendor_api', msg: 'rejected' }),
    ).toBeNull();
  });

  it('stays quiet for our own deferrals', () => {
    // `deferred` 는 벤더에게 **묻지도 않았다**. 사용자가 할 일이 없고 다음 사이클에
    // 자동으로 이어받으므로 우회를 켜라고 할 이유가 없다.
    expect(
      classifyRestWarning({ reason: 'capacity_overloaded', kind: 'deferred', msg: 'full' }),
    ).toBeNull();
    expect(
      classifyRestWarning({ reason: 'fetch_budget_exhausted', kind: 'deferred', msg: '' }),
    ).toBeNull();
  });

  it('stays quiet for warnings that are not failures', () => {
    expect(classifyRestWarning({ reason: 'rest_bypassed', is_failure: false, msg: '' })).toBeNull();
    expect(
      classifyRestWarning({ reason: 'minute_fallback_to_krx', is_failure: false }),
    ).toBeNull();
    // `kind` 부재(배포 직후 gcTime 2h 캐시의 옛 응답)도 조용하다 — 성격을 모르면
    // 문구를 고를 수 없고, 잘못된 문구는 침묵보다 나쁘다.
    expect(classifyRestWarning({ reason: 'transport_error' })).toBeNull();
  });
});
