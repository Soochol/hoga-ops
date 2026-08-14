import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { DataWindow } from './DataWindow';
import type { WorkspaceWindow } from '../../state/workspace';
import {
  __resetGroupChartLinksForTests,
  publishGroupChartLink,
  type GroupChartLink,
} from './groupChartLinkSource';
import { useLiveCursorStore } from '../useLiveCursorStore';
import { useLiveOrderbookAtCursor } from '../../api/useLiveCursor';
import { useChartPrefsStore } from '../../state/chartPrefs';
import { useQuoteByCode, type LiveQuote } from '../../api/liveQuotes';
import { useLiveStockLimits } from '../../api/liveStockLimits';
import { useLiveViStatus } from '../../api/liveViStatus';
import { useScreenerDailyCandles } from '../../api/screenerDailyCandles';
import type { RangeBundle } from '../../api/types';

// sector-ranking 라우팅 가드만 검증한다 — 지수 happy-path 는 SectorRankingWindow 를
// 스텁으로 대체(자체 데이터 훅은 SectorRankingWindow.test 가 커버).
vi.mock('./SectorRankingWindow', () => ({
  SectorRankingWindow: ({ indexId }: { indexId: string }) => <div>stub:{indexId}</div>,
}));

// WS 구독·링버퍼는 대부분의 테스트에서 관심사가 아니다 — 기본은 빈 버퍼.
// 다만 형성 중 봉 힌트는 **버퍼가 답해야** 성립하는 상태라(파케이 미승격 →
// orderbookSnapshotAtCursor 폴백) 그 describe 만 `ob` 를 채운다. `vi.mock` factory 는
// hoisting 되어 외부 변수를 직접 참조하면 초기화 전 접근이 되므로 `vi.hoisted` 로 뺀다.
const liveSeriesBuffers = vi.hoisted(() => ({ ob: [] as unknown[] }));
vi.mock('../../api/liveSeries', () => ({
  useLiveSeries: () => ({
    initial: undefined,
    isLoading: false,
    error: null,
    ob: liveSeriesBuffers.ob,
    trade: [],
    broker: [],
    program: [],
    // ⚠ 이 mock 은 `LiveSeriesData` 로 타입되지 않는다 — 키를 빠뜨려도 tsc 가 못 잡고,
    // 소비처가 그 키를 읽는 순간 런타임 크래시로만 드러난다(afterHours 추가 때 실제로
    // latest 모드 7건이 통째로 죽었다). 훅 반환에 키를 늘리면 여기도 늘릴 것.
    afterHours: [],
  }),
}));

// 시간외 단일가(ka10087) 훅은 **실시각에 반응한다** — `isAfterHoursSinglePriceWindow`
// 가 16:00–18:00 에만 true 라, 모킹하지 않으면 이 스펙이 **몇 시에 돌리느냐에 따라
// 다른 경로**를 탄다(그 시간대에 돌리면 훅이 실제 fetch 를 시도한다). 창 밖 동작을
// 기본으로 고정하고, 창 안 동작은 전용 스펙(`liveAfterHoursBook.test.ts`)이 순수
// 함수로 검증한다.
vi.mock('../../api/liveAfterHoursBook', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/liveAfterHoursBook')>()),
  useAfterHoursBook: () => ({ data: undefined }),
}));

// 스팟 훅은 게이트(코드 인자) 검증용 스파이 — 실제 fetch 는 useLiveCursor.test 소관.
vi.mock('../../api/useLiveCursor', () => ({
  useLiveOrderbookAtCursor: vi.fn(() => undefined),
  useLiveBrokersAtCursor: vi.fn(() => undefined),
}));

// BookPanel 은 배선 prop 만 관측한다(마스크·기준가·시점 게이트). 실제 패널은
// snapshot 이 null 이면 빈 상태를 그리므로 목킹하지 않으면 아무것도 관측할 수 없다.
// mask 행은 **별도 요소로 유지**한다 — 기존 마스크 테스트가 getByText('mask:true')
// 로 정확 매칭하므로 같은 노드에 다른 값을 합치면 전부 깨진다.
vi.mock('./BookPanel', () => ({
  default: ({
    maskRatio,
    baselinePrice,
    limits,
    vi: viEvent,
  }: {
    maskRatio: boolean;
    baselinePrice: number | null;
    limits: unknown;
    vi: unknown;
  }) => (
    <div>
      <div>mask:{String(maskRatio)}</div>
      <div>baseline:{String(baselinePrice)}</div>
      <div>limits:{limits === null || limits === undefined ? 'null' : 'set'}</div>
      <div>vi:{viEvent === null || viEvent === undefined ? 'null' : 'set'}</div>
    </div>
  ),
}));

// 10호가 창의 per-code 쿼리 — 기본은 "값 없음"이고, 기준가 테스트에서만 덮어쓴다.
vi.mock('../../api/liveQuotes', () => ({
  useQuoteByCode: vi.fn(() => new Map()),
}));
vi.mock('../../api/liveStockLimits', () => ({
  useLiveStockLimits: vi.fn(() => ({ data: undefined })),
}));
vi.mock('../../api/liveViStatus', () => ({
  useLiveViStatus: vi.fn(() => ({ data: undefined })),
}));
// prevCloseBeforeDate 는 **실물을 그대로 쓴다** — 커서 날짜에서 직전 거래일 종가를
// 고르는 것이 이 수정의 핵심 로직이라, 목으로 대체하면 검증 대상이 사라진다.
vi.mock('../../api/screenerDailyCandles', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/screenerDailyCandles')>()),
  useScreenerDailyCandles: vi.fn(() => ({ data: undefined })),
}));

function renderWithQuery(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

function dataWin(kind: WorkspaceWindow['kind'], group = 1): WorkspaceWindow {
  return { id: `dw-${kind}`, kind, group, rect: { x: 0, y: 0, w: 300, h: 240 } };
}

function chartLink(overrides: Partial<GroupChartLink> = {}): GroupChartLink {
  return {
    windowId: 'cw1',
    group: 1,
    code: '005930',
    timeframe: '1m',
    bundle: null,
    adjustFactors: undefined,
    todayKst: '20260720',
    vdist: { rangeCount: 10, color: '#64748B', maxColor: '#EAB308', hoverCutoffEnabled: false },
    ...overrides,
  };
}

function sectorWin(): WorkspaceWindow {
  return { id: 'w1', kind: 'sector-ranking', group: 3, rect: { x: 0, y: 0, w: 360, h: 320 } };
}

describe('DataWindow — sector-ranking 라우팅', () => {
  it('지수 그룹이면 SectorRankingWindow 를 지수 id 로 렌더한다', () => {
    render(<DataWindow win={sectorWin()} symbol={{ code: 'KOSPI', name: '코스피', kind: 'index' }} />);
    expect(screen.getByText('stub:KOSPI')).toBeInTheDocument();
  });

  it('주식 그룹이면 지수 전용 안내를 표시한다', () => {
    render(<DataWindow win={sectorWin()} symbol={{ code: '005930', name: '삼성전자' }} />);
    expect(screen.getByText(/지수 그룹 전용/)).toBeInTheDocument();
    expect(screen.getByText(/삼성전자 은 지수가 아닙니다/)).toBeInTheDocument();
  });

  it('종목 미지정이면 안내에 그룹 번호를 표시한다', () => {
    render(<DataWindow win={sectorWin()} symbol={null} />);
    expect(screen.getByText(/종목 없음 \(그룹 3\)/)).toBeInTheDocument();
  });

  it('지수 코드가 유효하지 않으면(예: 오염값) 안내로 우아하게 degrade 한다', () => {
    // kind:'index' 지만 code 가 LiveIndexId 화이트리스트 밖 → SectorRankingWindow 미마운트.
    render(<DataWindow win={sectorWin()} symbol={{ code: '005930', name: '가짜지수', kind: 'index' }} />);
    expect(screen.getByText(/지수 그룹 전용/)).toBeInTheDocument();
    expect(screen.queryByText(/^stub:/)).not.toBeInTheDocument();
  });
});

describe('DataWindow — 체결창 라우팅', () => {
  // 표시 로직(4열·색·정렬)은 TradeTickTable.test 소관 — 여기선 kind 라우팅과
  // 공통 게이트만. 위 mock 이 빈 버퍼를 고정하므로 빈 상태 문구로 마운트를 관측한다.
  it('주식 그룹이면 체결 테이블을 마운트한다', () => {
    renderWithQuery(<DataWindow win={dataWin('trade')} symbol={{ code: '005930', name: '삼성전자' }} />);
    expect(screen.getByText('체결 데이터 없음')).toBeInTheDocument();
  });

  it('지수 그룹이면 지원하지 않음 안내 (체결 데이터가 없는 심볼)', () => {
    render(<DataWindow win={dataWin('trade')} symbol={{ code: 'KOSPI', name: '코스피', kind: 'index' }} />);
    expect(screen.getByText(/지수는 지원하지 않습니다/)).toBeInTheDocument();
    expect(screen.queryByText('체결 데이터 없음')).not.toBeInTheDocument();
  });

  it('종목 미지정이면 창 이름과 그룹 번호를 안내한다', () => {
    render(<DataWindow win={dataWin('trade', 4)} symbol={null} />);
    expect(screen.getByText(/체결 · 종목 없음 \(그룹 4\)/)).toBeInTheDocument();
  });
});

describe('DataWindow — 매물대·프로그램 그룹 차트 링크 (ADR-0119 PR-D)', () => {
  const symbol = { code: '005930', name: '삼성전자' };

  beforeEach(() => {
    __resetGroupChartLinksForTests();
    useLiveCursorStore.getState().resetCursor();
    vi.mocked(useLiveOrderbookAtCursor).mockClear();
  });

  it('링크 없음 → 연동 대기 카드 (매물대·프로그램)', () => {
    renderWithQuery(<DataWindow win={dataWin('vdist')} symbol={symbol} />);
    renderWithQuery(<DataWindow win={dataWin('program')} symbol={symbol} />);
    expect(screen.getAllByText(/차트 창 연동 대기/)).toHaveLength(2);
    expect(screen.getAllByText(/그룹 1에 차트 창을 추가하면 표시됩니다/)).toHaveLength(2);
  });

  it('링크 발행 → 실 카드 렌더 (빈 번들이면 카드의 빈 상태)', () => {
    publishGroupChartLink(chartLink());
    renderWithQuery(<DataWindow win={dataWin('vdist')} symbol={symbol} />);
    renderWithQuery(<DataWindow win={dataWin('program')} symbol={symbol} />);
    expect(screen.getByText('매물대 분포 없음')).toBeInTheDocument();
    expect(screen.getByText('프로그램 순매수 데이터 없음')).toBeInTheDocument();
    expect(screen.queryByText(/차트 창 연동 대기/)).not.toBeInTheDocument();
  });

  it('프로그램 latest 는 오늘 스코프 — 번들 마지막 점이 전일이면 빈 상태로 리셋', () => {
    // 새날 아침(오늘 관측 0건): 번들엔 전일(20260719) 시리즈만 남는다. 링크의
    // todayKst(20260720)가 카드로 배선돼 전일 마감 누적이 현재값처럼 렌더되지
    // 않아야 한다 — 거래원 창의 오늘 스코프 리셋과 동일 의미론.
    const prevDayMs = Date.UTC(2026, 6, 19, 0, 30); // KST 2026-07-19 09:30
    const bundle = {
      program_trade: {
        points: [{ t: prevDayMs, net_qty: 10, net_amount: 100_000_000, gap_risk: false }],
        source: 'kis_program_trade',
      },
      candles: [],
    } as unknown as RangeBundle;
    publishGroupChartLink(chartLink({ bundle, todayKst: '20260720' }));
    const first = renderWithQuery(<DataWindow win={dataWin('program')} symbol={symbol} />);
    expect(screen.getByText('프로그램 순매수 데이터 없음')).toBeInTheDocument();

    // 대조: 같은 번들이라도 todayKst 가 그 점의 날이면 정상 렌더 — 빈 상태가
    // 게이트(날짜 불일치) 때문이지 데이터 부재 때문이 아님을 고정한다.
    // 첫 마운트는 링크 스토어를 구독 중이라 두 번째 publish 에 같이 갱신된다 —
    // 관측을 분리하기 위해 내리고 다시 올린다.
    first.unmount();
    __resetGroupChartLinksForTests();
    publishGroupChartLink(chartLink({ bundle, todayKst: '20260719' }));
    renderWithQuery(<DataWindow win={dataWin('program')} symbol={symbol} />);
    expect(screen.getByText('+1억')).toBeInTheDocument();
  });

  it('링크 code 가 창 종목과 다르면(교체 직후 stale 발행) 소비하지 않는다', () => {
    publishGroupChartLink(chartLink({ code: '000660' }));
    renderWithQuery(<DataWindow win={dataWin('vdist')} symbol={symbol} />);
    expect(screen.getByText(/차트 창 연동 대기/)).toBeInTheDocument();
  });

  it('다른 그룹의 링크는 소비하지 않는다', () => {
    publishGroupChartLink(chartLink({ group: 2 }));
    renderWithQuery(<DataWindow win={dataWin('program', 1)} symbol={symbol} />);
    expect(screen.getByText(/차트 창 연동 대기/)).toBeInTheDocument();
  });

  // 2026-07-20 09:00~15:30 KST 세그먼트·분포만 담은 번들 — 오늘 스코프 테스트 공용.
  const VDIST_OPEN_MS = 1784505600000;
  const VDIST_CLOSE_MS = VDIST_OPEN_MS + 6.5 * 3600 * 1000;

  function vdistBundle(): RangeBundle {
    return {
      code: '005930', from_date: '20260720', to_date: '20260720', bucket_ms: 60000,
      segments: [{ date: '20260720', session_open_ms: VDIST_OPEN_MS, session_close_ms: VDIST_CLOSE_MS }],
      candles: [], investorPoints: [],
      volume_distributions: [{
        date: '20260720',
        range_count: 2,
        price_min: 1000,
        price_max: 2000,
        session_open_ms: VDIST_OPEN_MS,
        session_close_ms: VDIST_CLOSE_MS,
        last_trade_ms: VDIST_CLOSE_MS,
        bins: [
          { price_low: 1000, price_high: 1500, qty: 100 },
          { price_low: 1500, price_high: 2000, qty: 50 },
        ],
      }],
    } as unknown as RangeBundle;
  }

  // persisted 프로필이 본체로 쓰이려면 bins 수 = rangeCount (persistedUsable 규칙).
  const VDIST_2BIN = { rangeCount: 2, color: '#64748B', maxColor: '#EAB308', hoverCutoffEnabled: false };

  it('매물대 latest 는 오늘 스코프 — 새날 아침(번들 마지막 세그먼트=전일)에 전일 분포를 표시하지 않는다', () => {
    // todayKst=다음날 — 오늘 세그먼트·분포는 아직 없다(새날 아침 캡처 전).
    publishGroupChartLink(chartLink({ bundle: vdistBundle(), todayKst: '20260721', vdist: VDIST_2BIN }));
    renderWithQuery(<DataWindow win={dataWin('vdist')} symbol={symbol} />);
    expect(screen.getByText('매물대 분포 없음')).toBeInTheDocument();
  });

  it('매물대 latest — todayKst 가 세그먼트 날짜와 일치하면(정상 장중) 당일 분포를 그린다', () => {
    publishGroupChartLink(chartLink({ bundle: vdistBundle(), todayKst: '20260720', vdist: VDIST_2BIN }));
    renderWithQuery(<DataWindow win={dataWin('vdist')} symbol={symbol} />);
    expect(screen.queryByText('매물대 분포 없음')).not.toBeInTheDocument();
  });
});

describe('DataWindow — 10호가 스팟 모드 그룹 게이트 (크로스헤어 버스)', () => {
  const symbol = { code: '005930', name: '삼성전자' };
  const CURSOR_MS = 1784505600000; // 2026-07-20 09:00 KST

  beforeEach(() => {
    __resetGroupChartLinksForTests();
    useLiveCursorStore.getState().resetCursor();
    vi.mocked(useLiveOrderbookAtCursor).mockClear();
  });

  it('같은 그룹 차트 창의 분봉 호버 → 스팟 훅에 code 를 넘긴다', () => {
    useLiveCursorStore.getState().setSidebarCursor(CURSOR_MS, {
      windowId: 'cw1', group: 1, code: '005930', timeframe: '1m',
    });
    renderWithQuery(<DataWindow win={dataWin('book', 1)} symbol={symbol} />);
    expect(vi.mocked(useLiveOrderbookAtCursor)).toHaveBeenLastCalledWith({
      code: '005930',
      timeframe: '1m',
      // venue 는 백엔드 필수(ADR-0140) — 창의 venue 선택을 그대로 넘겨야 한다.
      // 빠지면 라우트가 422 라 호버 내내 "호가 데이터 없음" 이 뜬다.
      venue: 'KRX',
    });
  });

  it('다른 그룹 호버 → code null (latest 유지)', () => {
    useLiveCursorStore.getState().setSidebarCursor(CURSOR_MS, {
      windowId: 'cw2', group: 2, code: '000660', timeframe: '1m',
    });
    renderWithQuery(<DataWindow win={dataWin('book', 1)} symbol={symbol} />);
    expect(vi.mocked(useLiveOrderbookAtCursor)).toHaveBeenLastCalledWith({
      code: null,
      timeframe: null,
      venue: 'KRX',
    });
  });

  it('D/W/M 호버 → 스팟 진입 안 함 (ADR-0044 분봉 전용)', () => {
    useLiveCursorStore.getState().setSidebarCursor(CURSOR_MS, {
      windowId: 'cw1', group: 1, code: '005930', timeframe: 'D',
    });
    renderWithQuery(<DataWindow win={dataWin('book', 1)} symbol={symbol} />);
    expect(vi.mocked(useLiveOrderbookAtCursor)).toHaveBeenLastCalledWith({
      code: null,
      timeframe: null,
      venue: 'KRX',
    });
  });
});

describe('DataWindow — 10호가 동시호가 마스크 (ADR-0119 PR-D2)', () => {
  const symbol = { code: '005930', name: '삼성전자' };
  // 2026-07-20 09:00 KST 개장, 15:30 마감 → 동시호가 창 = 15:20~15:30.
  const OPEN_MS = 1784505600000;
  const CLOSE_MS = OPEN_MS + 6.5 * 3600 * 1000; // 15:30
  const AUCTION_MS = CLOSE_MS - 5 * 60 * 1000;   // 15:25 (동시호가 구간)
  const REGULAR_MS = OPEN_MS + 2 * 3600 * 1000;  // 11:00 (정규장)

  function bundleWithSession(): RangeBundle {
    return {
      code: '005930', from_date: '20260720', to_date: '20260720', bucket_ms: 60000,
      segments: [{ date: '20260720', session_open_ms: OPEN_MS, session_close_ms: CLOSE_MS }],
      candles: [], investorPoints: [],
    } as unknown as RangeBundle;
  }

  function setup(cursorMs: number, toggle: boolean) {
    __resetGroupChartLinksForTests();
    useLiveCursorStore.getState().resetCursor();
    useChartPrefsStore.getState().setToggle('auctionWindowMask', toggle);
    publishGroupChartLink(chartLink({ bundle: bundleWithSession() }));
    useLiveCursorStore.getState().setSidebarCursor(cursorMs, {
      windowId: 'cw1', group: 1, code: '005930', timeframe: '1m',
    });
  }

  beforeEach(() => {
    vi.mocked(useLiveOrderbookAtCursor).mockReturnValue(undefined);
  });

  it('동시호가 구간 커서 + 토글 ON → 마스킹', () => {
    setup(AUCTION_MS, true);
    renderWithQuery(<DataWindow win={dataWin('book', 1)} symbol={symbol} />);
    expect(screen.getByText('mask:true')).toBeInTheDocument();
  });

  it('토글 OFF → 마스킹 안 함', () => {
    setup(AUCTION_MS, false);
    renderWithQuery(<DataWindow win={dataWin('book', 1)} symbol={symbol} />);
    expect(screen.getByText('mask:false')).toBeInTheDocument();
  });

  it('정규장 커서 → 마스킹 안 함', () => {
    setup(REGULAR_MS, true);
    renderWithQuery(<DataWindow win={dataWin('book', 1)} symbol={symbol} />);
    expect(screen.getByText('mask:false')).toBeInTheDocument();
  });

  it('링크 부재(latest 모드) → 마스킹 안 함', () => {
    __resetGroupChartLinksForTests();
    useLiveCursorStore.getState().resetCursor();
    useChartPrefsStore.getState().setToggle('auctionWindowMask', true);
    renderWithQuery(<DataWindow win={dataWin('book', 1)} symbol={symbol} />);
    expect(screen.getByText('mask:false')).toBeInTheDocument();
  });
});

describe('DataWindow — 10호가 등락률 기준가는 커서 날짜를 따라간다', () => {
  const symbol = { code: '005930', name: '삼성전자' };
  // 링크의 todayKst = 2026-07-20(월). 커서를 7/17(금)에 두면 "과거 날짜" 커서다.
  const PAST_CURSOR_MS = Date.UTC(2026, 6, 17, 1, 0); // KST 2026-07-17 10:00
  const TODAY_CURSOR_MS = Date.UTC(2026, 6, 20, 2, 0); // KST 2026-07-20 11:00
  /** 오늘(7/20) 기준 전일종가 — 실전에서 KIS 가 실어 주는 값. */
  const TODAY_BASELINE = 262500;
  /** 7/17 기준 전일종가 = 7/16 종가. 이 값이 나와야 등락률이 그날 기준으로 맞는다. */
  const CURSOR_BASELINE = 208500;

  /** t_ms 는 KST 날짜로 환산되므로 UTC 00:30(=KST 09:30)으로 박아 날짜 경계를 피한다. */
  function daily(dayUtc: number, close: number) {
    return { t_ms: Date.UTC(2026, 6, dayUtc, 0, 30), open: close, high: close, low: close, close, volume: 1 };
  }

  function setQuote(overrides: Partial<LiveQuote> = {}) {
    const quote: LiveQuote = {
      code: '005930',
      price: 241500,
      change_pct: -8.0,
      change_won: -21000,
      baseline_price: TODAY_BASELINE,
      change_pct_source: 'kis',
      ...overrides,
    };
    vi.mocked(useQuoteByCode).mockReturnValue(new Map([['005930', quote]]));
  }

  function hover(cursorMs: number | null) {
    __resetGroupChartLinksForTests();
    useLiveCursorStore.getState().resetCursor();
    publishGroupChartLink(chartLink({ todayKst: '20260720' }));
    if (cursorMs !== null) {
      useLiveCursorStore.getState().setSidebarCursor(cursorMs, {
        windowId: 'cw1', group: 1, code: '005930', timeframe: '1m',
      });
    }
  }

  beforeEach(() => {
    vi.mocked(useLiveOrderbookAtCursor).mockReturnValue(undefined);
    vi.mocked(useLiveStockLimits).mockReturnValue({ data: undefined } as never);
    vi.mocked(useLiveViStatus).mockReturnValue({ data: undefined } as never);
    vi.mocked(useScreenerDailyCandles).mockReturnValue({ data: undefined } as never);
    setQuote();
  });

  it('과거 날짜 호버 → 그날의 전일종가를 기준가로 쓴다 (오늘 기준가 아님)', () => {
    // 이 케이스가 버그 그 자체였다: 7/17 호가 옆에 7/20 기준가(262,500)가 붙어
    // 등락률의 **부호까지** 뒤집혔다. 실측 재현은 대화 기록 참조(−20.00% vs +0.72%).
    vi.mocked(useScreenerDailyCandles).mockReturnValue({
      data: { candles: [daily(16, CURSOR_BASELINE), daily(17, 207000)] },
    } as never);
    hover(PAST_CURSOR_MS);
    renderWithQuery(<DataWindow win={dataWin('book', 1)} symbol={symbol} />);
    expect(screen.getByText(`baseline:${CURSOR_BASELINE}`)).toBeInTheDocument();
    expect(screen.queryByText(`baseline:${TODAY_BASELINE}`)).not.toBeInTheDocument();
  });

  it('과거 날짜 호버 + 일봉 미도착 → 기준가를 비운다 (틀린 값보다 대시)', () => {
    hover(PAST_CURSOR_MS);
    renderWithQuery(<DataWindow win={dataWin('book', 1)} symbol={symbol} />);
    expect(screen.getByText('baseline:null')).toBeInTheDocument();
  });

  it('오늘 안에서의 호버 → 실시간 기준가 유지 (일봉 조회도 걸지 않는다)', () => {
    // 당일 스팟은 원래 옳았다 — 고치면서 회귀시키지 않았음을 못박는다.
    hover(TODAY_CURSOR_MS);
    renderWithQuery(<DataWindow win={dataWin('book', 1)} symbol={symbol} />);
    expect(screen.getByText(`baseline:${TODAY_BASELINE}`)).toBeInTheDocument();
    // code=null = 쿼리 비활성. 당일 커서에 불필요한 일봉 요청이 붙지 않는다.
    expect(vi.mocked(useScreenerDailyCandles)).toHaveBeenLastCalledWith(null, expect.any(String), '20260720');
  });

  it('일봉 조회창은 커서 날짜와 무관하게 to=오늘 고정 (커서가 날짜를 넘어도 키 1벌)', () => {
    vi.mocked(useScreenerDailyCandles).mockReturnValue({
      data: { candles: [daily(16, CURSOR_BASELINE)] },
    } as never);
    hover(PAST_CURSOR_MS);
    renderWithQuery(<DataWindow win={dataWin('book', 1)} symbol={symbol} />);
    // from 은 60일 전, to 는 오늘 — 커서가 7/17 이어도 to 가 7/17 로 좁혀지지 않는다.
    expect(vi.mocked(useScreenerDailyCandles)).toHaveBeenLastCalledWith('005930', '20260521', '20260720');
  });

  it('latest 모드(호버 없음) → 실시간 기준가', () => {
    hover(null);
    renderWithQuery(<DataWindow win={dataWin('book', 1)} symbol={symbol} />);
    expect(screen.getByText(`baseline:${TODAY_BASELINE}`)).toBeInTheDocument();
  });

  it('백엔드가 기준가를 봉인하면(change_pct_source=unavailable) 등락률을 그리지 않는다', () => {
    // 백엔드는 change_pct 를 null 로 죽이면서 baseline_price 는 실어 보낸다. 패널이
    // baseline_price 로 직접 계산하므로, 봉인을 존중하지 않으면 리스트는 숨기는 값을
    // 호가창만 그리는 비대칭이 생긴다.
    setQuote({ change_pct: null, change_won: null, change_pct_source: 'unavailable' });
    hover(null);
    renderWithQuery(<DataWindow win={dataWin('book', 1)} symbol={symbol} />);
    expect(screen.getByText('baseline:null')).toBeInTheDocument();
  });

  it('장전(hidden_pre_open)은 봉인이 아니다 — 기준가 유지', () => {
    // pre_open 도 change_pct 는 null 이지만 기준가 자체는 유효하다. 'unavailable'
    // 만 골라 막는지(과잉 차단이 아닌지) 대조군으로 고정한다.
    setQuote({ change_pct: null, change_won: null, change_pct_source: 'hidden_pre_open' });
    hover(null);
    renderWithQuery(<DataWindow win={dataWin('book', 1)} symbol={symbol} />);
    expect(screen.getByText(`baseline:${TODAY_BASELINE}`)).toBeInTheDocument();
  });
});

describe('DataWindow — 10호가 시점 게이트 (상하한가·VI)', () => {
  const symbol = { code: '005930', name: '삼성전자' };
  const PAST_CURSOR_MS = Date.UTC(2026, 6, 17, 1, 0); // KST 2026-07-17 10:00
  const TODAY_CURSOR_MS = Date.UTC(2026, 6, 20, 2, 0); // KST 2026-07-20 11:00

  function hover(cursorMs: number | null) {
    __resetGroupChartLinksForTests();
    useLiveCursorStore.getState().resetCursor();
    publishGroupChartLink(chartLink({ todayKst: '20260720' }));
    if (cursorMs !== null) {
      useLiveCursorStore.getState().setSidebarCursor(cursorMs, {
        windowId: 'cw1', group: 1, code: '005930', timeframe: '1m',
      });
    }
  }

  beforeEach(() => {
    vi.mocked(useLiveOrderbookAtCursor).mockReturnValue(undefined);
    vi.mocked(useQuoteByCode).mockReturnValue(new Map());
    vi.mocked(useScreenerDailyCandles).mockReturnValue({ data: undefined } as never);
    vi.mocked(useLiveStockLimits).mockReturnValue({
      data: { base_price: 260000, upper_limit: 341000, lower_limit: 183500, high_250: 304000, low_250: 181100 },
    } as never);
    vi.mocked(useLiveViStatus).mockReturnValue({
      data: { vi: { active: true, direction: 'up', trigger_price: 270000 } },
    } as never);
  });

  it('과거 날짜 호버 → 상하한가·250일을 비운다 (오늘 기준가에서 파생된 값)', () => {
    hover(PAST_CURSOR_MS);
    renderWithQuery(<DataWindow win={dataWin('book', 1)} symbol={symbol} />);
    expect(screen.getByText('limits:null')).toBeInTheDocument();
  });

  it('오늘 안에서의 호버 → 상하한가 유지 (날짜 단위 상수)', () => {
    hover(TODAY_CURSOR_MS);
    renderWithQuery(<DataWindow win={dataWin('book', 1)} symbol={symbol} />);
    expect(screen.getByText('limits:set')).toBeInTheDocument();
  });

  it('스팟이면 당일이라도 VI 를 비운다 ("지금 발동 중"은 과거 시각에 거짓)', () => {
    hover(TODAY_CURSOR_MS);
    renderWithQuery(<DataWindow win={dataWin('book', 1)} symbol={symbol} />);
    expect(screen.getByText('vi:null')).toBeInTheDocument();
  });

  it('latest 모드 → 상하한가·VI 모두 유지', () => {
    hover(null);
    renderWithQuery(<DataWindow win={dataWin('book', 1)} symbol={symbol} />);
    expect(screen.getByText('limits:set')).toBeInTheDocument();
    expect(screen.getByText('vi:set')).toBeInTheDocument();
  });
});

/**
 * 형성 중 봉 힌트 — 커서가 **아직 닫히지 않은 봉**을 가리킬 때만 뜬다.
 *
 * **막는 방향**: 값이 흐르는 것을 고장으로 오해하는 것. 형성 중 봉의 대표 호가는
 * 정의상 확정 전이라 틱마다 갱신되는 게 계약이다(백엔드 `query_bucket_representative`
 * 와 같은 규칙 = 버킷의 마지막 continuous book).
 * **못 보는 것**: 문구·위치의 시각적 적합성은 단위 테스트 범위 밖이다.
 * **등록 의존**: 링크 차트 창이 bundle 을 발행해야 판정한다 — 없으면 힌트도 없다.
 */
describe('DataWindow — 형성 중 봉 힌트', () => {
  const symbol = { code: '005930', name: '삼성전자' };
  const BUCKET = 60_000;
  /** KST 2026-07-20 11:00 — 링크 번들의 마지막 봉(= 장중이면 형성 중인 봉). */
  const LAST_CANDLE_MS = Date.UTC(2026, 6, 20, 2, 0);
  const CLOSED_CANDLE_MS = LAST_CANDLE_MS - 5 * BUCKET;

  function bundleWithLastCandle(): RangeBundle {
    const candle = (tsMs: number) => ({ ts_ms: tsMs, open: 1, high: 1, low: 1, close: 1, volume: 1 });
    return {
      code: '005930', from_date: '20260720', to_date: '20260720', bucket_ms: BUCKET,
      segments: [{
        date: '20260720',
        session_open_ms: Date.UTC(2026, 6, 20, 0, 0),
        session_close_ms: Date.UTC(2026, 6, 20, 6, 30),
      }],
      candles: [candle(CLOSED_CANDLE_MS), candle(LAST_CANDLE_MS)],
      investorPoints: [],
    } as unknown as RangeBundle;
  }

  /** 그 버킷에 실제로 답이 있는 WS 스냅샷 — 없으면 bufferSnap 이 null 이라 조건 자체가 안 선다. */
  function obAt(tMs: number) {
    const levels = (base: number) =>
      Array.from({ length: 5 }, (_, i) => ({ price: 1000 + i, qty: base + i }));
    return { t_ms: tMs, total_ask_qty: 10, total_bid_qty: 10, asks: levels(1), bids: levels(2) };
  }

  function hoverAt(cursorMs: number) {
    __resetGroupChartLinksForTests();
    useLiveCursorStore.getState().resetCursor();
    publishGroupChartLink(chartLink({ bundle: bundleWithLastCandle(), todayKst: '20260720' }));
    useLiveCursorStore.getState().setSidebarCursor(cursorMs, {
      windowId: 'cw1', group: 1, code: '005930', timeframe: '1m',
    });
  }

  /** 파케이 미승격(= WS 버퍼가 답하는 구간). 실측 승격 지연 3~8분의 상태. */
  function parquetMiss() {
    vi.mocked(useLiveOrderbookAtCursor).mockReturnValue(
      { snapshot: null, available_from: null, source: 'kiwoom_live' } as never,
    );
  }

  beforeEach(() => {
    liveSeriesBuffers.ob = [];
    vi.mocked(useLiveOrderbookAtCursor).mockReturnValue(undefined as never);
  });

  it('형성 중 봉을 호버하고 파케이가 아직 없으면 힌트를 띄운다', () => {
    liveSeriesBuffers.ob = [obAt(LAST_CANDLE_MS + 30_000)];
    parquetMiss();
    hoverAt(LAST_CANDLE_MS);
    renderWithQuery(<DataWindow win={dataWin('book', 1)} symbol={symbol} />);
    expect(screen.getByTestId('orderbook-forming-hint')).toBeInTheDocument();
  });

  it('닫힌 봉이면 띄우지 않는다 — 커서 버킷 하나만 바꾼 대조', () => {
    liveSeriesBuffers.ob = [obAt(CLOSED_CANDLE_MS + 30_000)];
    parquetMiss();
    hoverAt(CLOSED_CANDLE_MS);
    renderWithQuery(<DataWindow win={dataWin('book', 1)} symbol={symbol} />);
    expect(screen.queryByTestId('orderbook-forming-hint')).not.toBeInTheDocument();
  });

  it('파케이가 답하면 띄우지 않는다 — 승격됐다는 것은 값이 고정됐다는 뜻이다', () => {
    liveSeriesBuffers.ob = [obAt(LAST_CANDLE_MS + 30_000)];
    vi.mocked(useLiveOrderbookAtCursor).mockReturnValue(
      { snapshot: { ts_ms: LAST_CANDLE_MS, seq: 0, ask: [], bid: [], tot_ask: 1, tot_bid: 1, exp_price: 0, exp_qty: 0 },
        available_from: null, source: 'hogaplay' } as never,
    );
    hoverAt(LAST_CANDLE_MS);
    renderWithQuery(<DataWindow win={dataWin('book', 1)} symbol={symbol} />);
    expect(screen.queryByTestId('orderbook-forming-hint')).not.toBeInTheDocument();
  });

  it('링크 차트 창의 봉이 커서 봉과 다르면 판정하지 않는다 (버킷 축이 다르다)', () => {
    liveSeriesBuffers.ob = [obAt(LAST_CANDLE_MS + 30_000)];
    parquetMiss();
    __resetGroupChartLinksForTests();
    useLiveCursorStore.getState().resetCursor();
    publishGroupChartLink(chartLink({ bundle: bundleWithLastCandle(), todayKst: '20260720', timeframe: '5m' }));
    useLiveCursorStore.getState().setSidebarCursor(LAST_CANDLE_MS, {
      windowId: 'cw1', group: 1, code: '005930', timeframe: '1m',
    });
    renderWithQuery(<DataWindow win={dataWin('book', 1)} symbol={symbol} />);
    expect(screen.queryByTestId('orderbook-forming-hint')).not.toBeInTheDocument();
  });
});
