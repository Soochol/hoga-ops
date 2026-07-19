import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import { DataWindow } from './DataWindow';
import type { WorkspaceWindow } from '../../state/workspace';

// sector-ranking 라우팅 가드만 검증한다 — 지수 happy-path 는 SectorRankingWindow 를
// 스텁으로 대체(자체 데이터 훅은 SectorRankingWindow.test 가 커버).
vi.mock('./SectorRankingWindow', () => ({
  SectorRankingWindow: ({ indexId }: { indexId: string }) => <div>stub:{indexId}</div>,
}));

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
