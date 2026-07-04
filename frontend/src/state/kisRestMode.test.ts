import { beforeEach, describe, expect, it } from 'vitest';
import {
  KIS_REST_FAILURE_TOAST_COOLDOWN_MS,
  kisRestWarningIndicatesUnavailable,
  markLegacyKisRestBypassMigrated,
  readLegacyKisRestBypass,
  useKisRestModeStore,
} from './kisRestMode';

describe('kisRestMode', () => {
  beforeEach(() => {
    localStorage.clear();
    useKisRestModeStore.setState({
      lastFailureAtMs: null,
      lastToastAtMs: null,
    });
  });

  it('keeps toast timing state without owning backend bypass truth', () => {
    expect(useKisRestModeStore.getState().lastFailureAtMs).toBeNull();

    useKisRestModeStore.getState().notifyFailure(1_000);

    expect(useKisRestModeStore.getState().lastFailureAtMs).toBe(1_000);
    expect(useKisRestModeStore.getState().lastToastAtMs).toBe(1_000);
  });

  it('reads legacy true once for backend migration', () => {
    localStorage.setItem('chart.kisRestMode.v1', JSON.stringify({ kisRestBypassEnabled: true }));

    expect(readLegacyKisRestBypass()).toEqual({ kisRestBypassEnabled: true });

    markLegacyKisRestBypassMigrated();

    expect(readLegacyKisRestBypass()).toBeNull();
  });

  it('dedupes failure toasts inside the cooldown window', () => {
    const first = useKisRestModeStore.getState().notifyFailure(1_000);
    const second = useKisRestModeStore.getState().notifyFailure(1_000 + KIS_REST_FAILURE_TOAST_COOLDOWN_MS - 1);
    const third = useKisRestModeStore.getState().notifyFailure(1_000 + KIS_REST_FAILURE_TOAST_COOLDOWN_MS + 1);

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(third).toBe(true);
    expect(useKisRestModeStore.getState().lastFailureAtMs).toBe(1_000 + KIS_REST_FAILURE_TOAST_COOLDOWN_MS + 1);
  });

  it('classifies KIS transport and unavailable warnings', () => {
    expect(kisRestWarningIndicatesUnavailable({ reason: 'kis_api_error', msg: 'TRANSPORT/ConnectError' })).toBe(true);
    expect(kisRestWarningIndicatesUnavailable({ reason: 'kis_transport_error', msg: 'ConnectTimeout' })).toBe(true);
    expect(kisRestWarningIndicatesUnavailable({ reason: 'kis_rate_limit', msg: 'rate limit' })).toBe(true);
    expect(kisRestWarningIndicatesUnavailable({ reason: 'partial', msg: 'missing one date' })).toBe(false);
  });
});
