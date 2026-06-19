import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LiveStatusBar } from './LiveStatusBar';
import type { RangeBundle } from '../api/types';
import type { LiveVenueOption } from '../state/liveVenue';
import { projectCaptureHealth } from './liveStatusProjection';

// useConnectionLiveness reads module-level WS state (_lastHeartbeatMs=0 in tests),
// so live=false by default. Hoist a mock so tests can control liveness.
const { mockLiveness } = vi.hoisted(() => ({ mockLiveness: vi.fn().mockReturnValue(false) }));
vi.mock('../api/useConnectionLiveness', () => ({ useConnectionLiveness: () => mockLiveness() }));

const EMPTY_BUNDLE: RangeBundle = {
  code: '005930',
  from_date: '20260527',
  to_date: '20260527',
  bucket_ms: 60_000,
  segments: [
    {
      date: '20260527',
      session_open_ms: 1748275200000,
      session_close_ms: 1748298600000,
      source: 'kis_live',
    },
  ],
  candles: [],
  quote_ratio: { bucket_ms: 60_000, points: [] },
  fill_strength: { bucket_ms: 60_000, points: [] },
  volume_profile_range: { bin_count: 0, price_min: 0, price_max: 0, bin_width: 0, bins: [] },
  volume_profile_by_day: [],
  investorPoints: [],
  ask_peaks: [],
};

function renderBar(
  props: { activeCode: string | null; captureHealthy: boolean; captureReason: string; bundle: RangeBundle | null; venue?: LiveVenueOption },
  watchlistCodes: string[] = [],
  quote?: { price: number; change_pct: number | null; change_won: number | null },
  liveSet: string[] = [],
) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(['watchlist'], {
    entries: watchlistCodes.map((code) => ({
      code, name: code, registered_at_kst_date: '20260101', last_success_date: null,
    })),
    next_run_at_ms: 0,
  });
  if (props.activeCode && quote) {
    qc.setQueryData(['live-quotes', props.activeCode], {
      phase: 'open', quotes: [{ code: props.activeCode, ...quote }],
    });
  }
  qc.setQueryData(['live', 'status'], {
    running: true,
    started_at_ms: 1,
    last_tick_ms: 1,
    cycle_lag_ms: 0,
    capture_healthy: props.captureHealthy,
    capture_reason: props.captureReason,
    watchlist_count: watchlistCodes.length,
    kis_calls_today: 0,
    kis_rate_limit_remaining: null,
    live_set: liveSet,
  });
  return render(
    <QueryClientProvider client={qc}>
      <LiveStatusBar
        activeCode={props.activeCode}
        captureHealth={projectCaptureHealth(props.captureHealthy, props.captureReason)}
        bundle={props.bundle}
        venue={props.venue}
      />
    </QueryClientProvider>,
  );
}

describe('LiveStatusBar', () => {
  beforeEach(() => {
    cleanup();
    mockLiveness.mockReturnValue(false);
  });

  it('shows em-dash when activeCode is null', () => {
    renderBar({ activeCode: null, captureHealthy: true, captureReason: 'healthy', bundle: null });
    expect(screen.getByTestId('live-status-bar').textContent).toContain('—');
  });

  it('shows the activeCode when set', () => {
    renderBar({ activeCode: '005930', captureHealthy: true, captureReason: 'healthy', bundle: EMPTY_BUNDLE });
    expect(screen.getByTestId('live-status-bar').textContent).toContain('005930');
  });

  it('shows 대기 중 price placeholder when candle data is not yet available', () => {
    renderBar({ activeCode: '005930', captureHealthy: true, captureReason: 'healthy', bundle: EMPTY_BUNDLE });
    expect(screen.getByTestId('live-status-bar').textContent).toContain('대기 중');
  });

  it('shows latest candle close price when data is available', () => {
    const bundle: RangeBundle = {
      ...EMPTY_BUNDLE,
      candles: [
        { ts_ms: 1000, open: 70000, high: 71000, low: 69000, close: 70500, vol_a: 1000, vol_b: 0 },
        { ts_ms: 2000, open: 70500, high: 72000, low: 70000, close: 71200, vol_a: 1500, vol_b: 0 },
      ],
    };
    renderBar({ activeCode: '005930', captureHealthy: true, captureReason: 'healthy', bundle });
    expect(screen.getByTestId('live-current-price').textContent).toContain('71,200');
  });

  it('shows 등락률(%) next to price from the live quote (등락액은 헤더에서 생략)', () => {
    renderBar(
      { activeCode: '005930', captureHealthy: true, captureReason: 'healthy', bundle: EMPTY_BUNDLE },
      ['005930'],
      { price: 361000, change_pct: 0.29, change_won: 1000 },
    );
    expect(screen.getByTestId('live-change').textContent).toBe('+0.29%');
  });

  it('omits the change cell when no live quote is available', () => {
    renderBar({ activeCode: '005930', captureHealthy: true, captureReason: 'healthy', bundle: EMPTY_BUNDLE });
    expect(screen.queryByTestId('live-change')).toBeNull();
  });

  it('renders the kis_live source chip (ADR-0039 compliance)', () => {
    renderBar({ activeCode: '005930', captureHealthy: true, captureReason: 'healthy', bundle: EMPTY_BUNDLE });
    expect(screen.getByTestId('source-chip-kis_live')).toBeTruthy();
  });

  it('shows the selected candle venue without implying NXT hoga support', () => {
    renderBar({ activeCode: '005930', captureHealthy: true, captureReason: 'healthy', bundle: EMPTY_BUNDLE, venue: 'NXT' });
    expect(screen.getByTestId('live-venue-label').textContent).toBe('캔들 NXT');
    expect(screen.getByTestId('live-venue-ws-note').textContent).toBe('호가 KRX');
  });

  it('shows a filled heart (aria-pressed) for a watchlist member', () => {
    renderBar({ activeCode: '005930', captureHealthy: true, captureReason: 'healthy', bundle: EMPTY_BUNDLE }, ['005930']);
    const btn = screen.getByRole('button', { name: '관심 그룹 편집' });
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    // 관심종목 멤버는 CTA("관심 추가 시 실시간")가 없어야 함
    expect(screen.queryByText('관심 추가 시 실시간')).toBeNull();
  });

  it('shows an empty heart + realtime-CTA for a non-member', () => {
    renderBar({ activeCode: '000660', captureHealthy: true, captureReason: 'healthy', bundle: EMPTY_BUNDLE }, ['005930']);
    expect(screen.getByRole('button', { name: '관심 그룹 편집' }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByText('관심 추가 시 실시간')).toBeInTheDocument();
  });

  it('clicking the heart opens the group picker (v3)', () => {
    renderBar({ activeCode: '005930', captureHealthy: true, captureReason: 'healthy', bundle: EMPTY_BUNDLE }, ['005930']);
    fireEvent.click(screen.getByRole('button', { name: '관심 그룹 편집' }));
    expect(screen.getByRole('menu', { name: '내 관심 그룹' })).toBeInTheDocument();
  });

  // ADR-0067: collection-status dot — realtime vs polling
  it('shows realtime dot when activeCode is in live_set and WS connected', () => {
    mockLiveness.mockReturnValue(true);
    renderBar(
      { activeCode: '005930', captureHealthy: true, captureReason: 'healthy', bundle: EMPTY_BUNDLE },
      ['005930'],
      undefined,
      ['005930', '000660'],
    );
    expect(screen.getByTestId('collection-dot-realtime')).toBeInTheDocument();
  });

  it('shows disconnected dot when activeCode is in live_set but WS not connected', () => {
    // live=false (default mock): realtime code → disconnected display status
    renderBar(
      { activeCode: '005930', captureHealthy: true, captureReason: 'healthy', bundle: EMPTY_BUNDLE },
      ['005930'],
      undefined,
      ['005930', '000660'],
    );
    expect(screen.getByTestId('collection-dot-disconnected')).toBeInTheDocument();
  });

  it('shows polling dot when activeCode is outside live_set (REST 준실시간)', () => {
    renderBar(
      { activeCode: '005930', captureHealthy: true, captureReason: 'healthy', bundle: EMPTY_BUNDLE },
      [],
      undefined,
      ['000660'],
    );
    expect(screen.getByTestId('collection-dot-polling')).toBeInTheDocument();
  });

  it('omits collection dot when activeCode is null (uncollected)', () => {
    renderBar({ activeCode: null, captureHealthy: true, captureReason: 'healthy', bundle: null });
    expect(screen.queryByTestId('collection-dot-realtime')).toBeNull();
    expect(screen.queryByTestId('collection-dot-polling')).toBeNull();
    expect(screen.queryByTestId('collection-dot-disconnected')).toBeNull();
  });

  // 캡처 헬스 dot/pill 분기 — healthy(ok)면 dot, 비정상이면 텍스트 pill 유지.
  it('shows capture-health dot (no pill) when the capture daemon is healthy', () => {
    renderBar({ activeCode: '005930', captureHealthy: true, captureReason: 'healthy', bundle: EMPTY_BUNDLE });
    expect(screen.getByTestId('capture-health-dot')).toBeInTheDocument();
    expect(screen.queryByTestId('capture-health-pill')).toBeNull();
  });

  it('keeps the capture-health text pill (no dot) when the capture daemon is unhealthy', () => {
    renderBar({ activeCode: '005930', captureHealthy: false, captureReason: 'sub_failed', bundle: EMPTY_BUNDLE });
    expect(screen.getByTestId('capture-health-pill').textContent).toBe('구독 실패');
    expect(screen.queryByTestId('capture-health-dot')).toBeNull();
  });
});
