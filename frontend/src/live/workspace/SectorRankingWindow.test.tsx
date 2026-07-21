import { beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';

import { SectorRankingWindow } from './SectorRankingWindow';
import type { LiveIndexCandlesResponse } from '../../api/liveIndices';
import type { IndexSectorRankingResponse } from '../../api/indexSectorRankings';

// 순수 도출 로직(최신 거래일 → 랭킹 조회 enable, latest 모드)을 검증하려고
// 두 데이터 훅과 종목 교체 SSOT 를 모킹한다.
const useLiveIndexCandles = vi.fn();
const useIndexSectorRankings = vi.fn();
const activateLiveCode = vi.fn();
const openLiveInNewTab = vi.fn();

vi.mock('../../api/liveIndices', () => ({
  useLiveIndexCandles: (...args: unknown[]) => useLiveIndexCandles(...args),
}));
vi.mock('../../api/indexSectorRankings', () => ({
  useIndexSectorRankings: (...args: unknown[]) => useIndexSectorRankings(...args),
}));
vi.mock('../liveNavigate', () => ({
  activateLiveCode: (...args: unknown[]) => activateLiveCode(...args),
  openLiveInNewTab: (...args: unknown[]) => openLiveInNewTab(...args),
}));

/** 창은 항상 `/live` 안에 산다 — useJumpToLive 의 navigate 는 no-op 경로. */
function renderWindow() {
  return render(
    <MemoryRouter initialEntries={['/live']}>
      <SectorRankingWindow indexId="KOSPI" />
    </MemoryRouter>,
  );
}

function candlesResult(candles: LiveIndexCandlesResponse['candles'], isLoading = false) {
  return {
    data: candles.length
      ? ({ index_id: 'KOSPI', from: '20260601', to: '20260619', timeframe: 'D', candles, data_warnings: [] } as LiveIndexCandlesResponse)
      : undefined,
    isLoading,
  };
}

const ranking: IndexSectorRankingResponse = {
  date: '20260619',
  source: 'daily_adjusted',
  unavailable_reason: null,
  sectors: [
    {
      folder_id: 'semi',
      folder_name: '반도체',
      order: 0,
      change_pct: 7.5,
      finite_count: 1,
      total_count: 1,
      stocks: [
        { code: '005930', name: '삼성전자', folder_id: 'semi', folder_name: '반도체', order: 0, close: 110, previous_close: 100, change_pct: 10, missing_reason: null },
      ],
    },
  ],
};

// 20260619 자정 KST 의 ms(= realMsToYyyymmdd 가 '20260619' 를 돌려주는 값).
const TS_20260619 = Date.UTC(2026, 5, 19) - 9 * 60 * 60 * 1000;

beforeEach(() => {
  useLiveIndexCandles.mockReset();
  useIndexSectorRankings.mockReset();
  activateLiveCode.mockReset();
  openLiveInNewTab.mockReset();
  useIndexSectorRankings.mockReturnValue({ data: undefined, isLoading: false, error: null });
});

describe('SectorRankingWindow', () => {
  it('최신 거래일을 마지막 일봉에서 도출해 latest 모드로 랭킹을 조회한다', () => {
    useLiveIndexCandles.mockReturnValue(
      candlesResult([
        { t_ms: TS_20260619 - 86_400_000, open: 1, high: 1, low: 1, close: 1, volume: 0 },
        { t_ms: TS_20260619, open: 1, high: 1, low: 1, close: 1, volume: 0 },
      ]),
    );
    useIndexSectorRankings.mockReturnValue({ data: ranking, isLoading: false, error: null });

    renderWindow();

    // 랭킹 쿼리는 마지막 봉 날짜 + enabled=true 로 호출된다.
    expect(useIndexSectorRankings).toHaveBeenCalledWith('20260619', true, expect.any(String));
    // 헤더는 latest 모드로 최신 거래일을 표시한다.
    expect(screen.getByText('2026/06/19 기준 · 최신')).toBeInTheDocument();
    expect(screen.getByText('반도체')).toBeInTheDocument();
  });

  it('일봉이 아직 없으면 랭킹 조회를 비활성화하고 로딩으로 표시한다', () => {
    useLiveIndexCandles.mockReturnValue(candlesResult([], true));

    renderWindow();

    // basis 미확정 → date=null, enabled=false.
    expect(useIndexSectorRankings).toHaveBeenCalledWith(null, false, expect.any(String));
    expect(screen.getByText('섹터 랭킹을 불러오는 중입니다.')).toBeInTheDocument();
  });

  it('종목 클릭은 활성 그룹 종목을 교체한다(activateLiveCode)', async () => {
    const user = userEvent.setup();
    useLiveIndexCandles.mockReturnValue(candlesResult([{ t_ms: TS_20260619, open: 1, high: 1, low: 1, close: 1, volume: 0 }]));
    useIndexSectorRankings.mockReturnValue({ data: ranking, isLoading: false, error: null });

    renderWindow();
    await user.click(screen.getByRole('button', { name: /삼성전자/ }));

    expect(activateLiveCode).toHaveBeenCalledWith('005930', '삼성전자');
  });

  it('ctrl+클릭은 새 탭으로 열고 활성 그룹 종목은 그대로 둔다', async () => {
    const user = userEvent.setup();
    useLiveIndexCandles.mockReturnValue(candlesResult([{ t_ms: TS_20260619, open: 1, high: 1, low: 1, close: 1, volume: 0 }]));
    useIndexSectorRankings.mockReturnValue({ data: ranking, isLoading: false, error: null });

    renderWindow();
    await user.keyboard('{Control>}');
    await user.click(screen.getByRole('button', { name: /삼성전자/ }));
    await user.keyboard('{/Control}');

    expect(openLiveInNewTab).toHaveBeenCalledWith({ kind: 'stock', code: '005930', label: '삼성전자' });
    expect(activateLiveCode).not.toHaveBeenCalled();
  });
});
