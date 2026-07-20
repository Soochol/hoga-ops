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
  }),
}));

// 스팟 훅은 게이트(코드 인자) 검증용 스파이 — 실제 fetch 는 useLiveCursor.test 소관.
vi.mock('../../api/useLiveCursor', () => ({
  useLiveOrderbookAtCursor: vi.fn(() => undefined),
  useLiveBrokersAtCursor: vi.fn(() => undefined),
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
