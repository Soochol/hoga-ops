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

  it('splits transport failure from congestion', () => {
    // 서버에 **닿지 못했다** — 저장 데이터 우회가 처방이다.
    expect(classifyRestWarning({ reason: 'transport_error', msg: 'ConnectTimeout' })).toBe(
      'transport',
    );
    // 닿았지만 지금은 못 준다 — 기다리면 된다.
    expect(classifyRestWarning({ reason: 'rate_limit_upstream', msg: '유량=5' })).toBe(
      'congestion',
    );
    // 우리 쪽 쿨다운. 서버는 멀쩡하므로 "연결 불가" 로 표시하면 거짓말이 된다.
    expect(classifyRestWarning({ reason: 'rate_limit_aborted', msg: 'cooldown' })).toBe(
      'congestion',
    );
  });

  it('no longer sniffs the message body for transport failures', () => {
    // 백엔드가 `error_policy` 사유를 그대로 싣게 되면서 이 우회로는 죽었다(ADR-0137).
    // `api_error` 는 벤더가 요청을 거절한 것이라 알림 대상이 아니다.
    expect(classifyRestWarning({ reason: 'api_error', msg: 'TRANSPORT/ConnectError' })).toBeNull();
  });

  it('drops the dead kis_rest_unavailable reason', () => {
    // 백엔드 전체에 0건이었다 — KIS 시대 잔재.
    expect(classifyRestWarning({ reason: 'kis_rest_unavailable', msg: '' })).toBeNull();
  });

  it('stays quiet for warnings that are not failures', () => {
    expect(classifyRestWarning({ reason: 'partial', msg: 'missing one date' })).toBeNull();
    expect(classifyRestWarning({ reason: 'rest_bypassed', msg: '' })).toBeNull();
    expect(classifyRestWarning({})).toBeNull();
  });
});
