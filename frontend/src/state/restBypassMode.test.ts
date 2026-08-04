import { beforeEach, describe, expect, it } from 'vitest';
import {
  REST_FAILURE_TOAST_COOLDOWN_MS,
  restWarningIndicatesUnavailable,
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
    });
  });

  it('keeps toast timing state without owning backend bypass truth', () => {
    expect(useRestBypassModeStore.getState().lastFailureAtMs).toBeNull();

    useRestBypassModeStore.getState().notifyFailure(1_000);

    expect(useRestBypassModeStore.getState().lastFailureAtMs).toBe(1_000);
    expect(useRestBypassModeStore.getState().lastToastAtMs).toBe(1_000);
  });

  it('reads legacy true once for backend migration', () => {
    localStorage.setItem('chart.kisRestMode.v1', JSON.stringify({ restBypassEnabled: true }));

    expect(readLegacyRestBypass()).toEqual({ restBypassEnabled: true });

    markLegacyRestBypassMigrated();

    expect(readLegacyRestBypass()).toBeNull();
  });

  it('dedupes failure toasts inside the cooldown window', () => {
    const first = useRestBypassModeStore.getState().notifyFailure(1_000);
    const second = useRestBypassModeStore.getState().notifyFailure(1_000 + REST_FAILURE_TOAST_COOLDOWN_MS - 1);
    const third = useRestBypassModeStore.getState().notifyFailure(1_000 + REST_FAILURE_TOAST_COOLDOWN_MS + 1);

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(third).toBe(true);
    expect(useRestBypassModeStore.getState().lastFailureAtMs).toBe(1_000 + REST_FAILURE_TOAST_COOLDOWN_MS + 1);
  });

  it('classifies KIS transport and unavailable warnings', () => {
    expect(restWarningIndicatesUnavailable({ reason: 'api_error', msg: 'TRANSPORT/ConnectError' })).toBe(true);
    expect(restWarningIndicatesUnavailable({ reason: 'transport_error', msg: 'ConnectTimeout' })).toBe(true);
    expect(restWarningIndicatesUnavailable({ reason: 'rate_limit_upstream', msg: 'rate limit' })).toBe(true);
    expect(restWarningIndicatesUnavailable({ reason: 'partial', msg: 'missing one date' })).toBe(false);
  });
});
