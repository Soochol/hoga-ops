import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';

import { WorkspaceCanvas } from './WorkspaceCanvas';
import { useWorkspaceStore, type WorkspaceWindow } from '../../state/workspace';

// 창 본문 stub — 데이터 창은 throw, 차트 창은 정상. 경계가 dispatch(창 밖)에
// 있으므로 DataWindow 자신의 훅/렌더 throw 를 그대로 재현한다.
vi.mock('./ChartWindow', () => ({ ChartWindow: () => <div>chart-alive</div> }));
vi.mock('./DataWindow', () => ({
  DataWindow: () => {
    throw new Error('book window exploded');
  },
}));
vi.mock('./TitleBarSymbolRow', () => ({ TitleBarSymbolRow: () => <div>sym</div> }));

const CANVAS = 1000;
function stubCanvasSize() {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { value: CANVAS, configurable: true });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { value: CANVAS, configurable: true });
}

function win(id: string, kind: WorkspaceWindow['kind'], group: number): WorkspaceWindow {
  const base = { id, group, rect: { x: 0, y: 0, w: 0.4, h: 0.4 } };
  if (kind === 'chart') {
    return { ...base, kind, chart: { timeframe: '1m', indicators: { paneOrder: [], paneStretch: {}, byTimeframe: {} } } } as WorkspaceWindow;
  }
  return { ...base, kind } as WorkspaceWindow;
}

describe('WorkspaceCanvas — 데이터 창 단위 오류 격리', () => {
  beforeEach(() => {
    cleanup();
    stubCanvasSize();
    // 경계의 componentDidCatch 가 원본 에러를 console.error 로 남긴다(의도) —
    // 테스트 출력 소음만 억제.
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('데이터 창이 throw 해도 그 창만 폴백으로 바뀌고 옆 차트 창은 살아 있다', () => {
    useWorkspaceStore.setState({
      windows: [win('a', 'chart', 1), win('b', 'book', 1)],
      zOrder: ['a', 'b'],
      groupSymbols: { 1: { code: '005930', name: '삼성전자' } },
    });
    render(<WorkspaceCanvas />);

    // throw 한 데이터 창 → 창 단위 폴백(제목 + 원본 메시지 + 다시 시도).
    expect(screen.getByText('창 렌더링에 실패했습니다')).toBeInTheDocument();
    expect(screen.getByText('book window exploded')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '다시 시도' })).toBeInTheDocument();
    // 워크스페이스 전체가 백지가 되지 않는다 — 옆 차트 창 생존.
    expect(screen.getByText('chart-alive')).toBeInTheDocument();
  });
});
