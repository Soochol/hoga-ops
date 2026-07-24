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
import type { RangeBundle } from '../../api/types';

// sector-ranking 라우팅 가드만 검증한다 — 지수 happy-path 는 SectorRankingWindow 를
// 스텁으로 대체(자체 데이터 훅은 SectorRankingWindow.test 가 커버).
vi.mock('./SectorRankingWindow', () => ({
  SectorRankingWindow: ({ indexId }: { indexId: string }) => <div>stub:{indexId}</div>,
}));

// WS 구독·링버퍼는 이 테스트의 관심사가 아니다 — 빈 버퍼 고정.
vi.mock('../../api/liveSeries', () => ({
  useLiveSeries: () => ({
    initial: undefined,
    isLoading: false,
    error: null,
    ob: [],
    trade: [],
    broker: [],
    program: [],
  }),
}));

// 스팟 훅은 게이트(코드 인자) 검증용 스파이 — 실제 fetch 는 useLiveCursor.test 소관.
vi.mock('../../api/useLiveCursor', () => ({
  useLiveOrderbookAtCursor: vi.fn(() => undefined),
  useLiveBrokersAtCursor: vi.fn(() => undefined),
}));

// BookPanel 은 maskRatio prop 만 관측한다(동시호가 마스크 검증). 실제 패널은
// snapshot 이 null 이면 빈 상태를 그리므로 목킹하지 않으면 mask 를 관측할 수 없다.
vi.mock('./BookPanel', () => ({
  default: ({ maskRatio }: { maskRatio: boolean }) => <div>mask:{String(maskRatio)}</div>,
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
