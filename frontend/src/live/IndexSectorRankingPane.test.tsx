import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { IndexSectorRankingPane } from './IndexSectorRankingPane';
import type { IndexSectorRankingResponse } from '../api/indexSectorRankings';

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
      finite_count: 2,
      total_count: 2,
      stocks: [
        { code: '005930', name: '삼성전자', folder_id: 'semi', folder_name: '반도체', order: 0, close: 110, previous_close: 100, change_pct: 10, missing_reason: null },
        { code: '000660', name: 'SK하이닉스', folder_id: 'semi', folder_name: '반도체', order: 1, close: 210, previous_close: 200, change_pct: 5, missing_reason: null },
      ],
    },
    {
      folder_id: 'bio',
      folder_name: '바이오',
      order: 1,
      change_pct: -2,
      finite_count: 1,
      total_count: 1,
      stocks: [
        { code: '068270', name: '셀트리온', folder_id: 'bio', folder_name: '바이오', order: 0, close: 98, previous_close: 100, change_pct: -2, missing_reason: null },
      ],
    },
  ],
};

describe('IndexSectorRankingPane', () => {
  it('renders basis date, sector ranking, and default rank 1 stocks', () => {
    render(
      <IndexSectorRankingPane
        basisDate="20260619"
        basisMode="hover"
        ranking={ranking}
        isLoading={false}
        error={null}
        onClearDatePin={() => {}}
        onOpenStock={() => {}}
      />,
    );

    expect(screen.getByText('2026/06/19 기준 · hover')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /1위 반도체/ })).toBeInTheDocument();
    expect(screen.getByText('삼성전자')).toBeInTheDocument();
    expect(screen.queryByText('셀트리온')).toBeNull();
  });

  it('previews sector stocks on hover and returns to rank 1 after leave', async () => {
    const user = userEvent.setup();
    render(
      <IndexSectorRankingPane
        basisDate="20260619"
        basisMode="hover"
        ranking={ranking}
        isLoading={false}
        error={null}
        onClearDatePin={() => {}}
        onOpenStock={() => {}}
      />,
    );

    await user.hover(screen.getByRole('button', { name: /2위 바이오/ }));
    expect(screen.getByText('셀트리온')).toBeInTheDocument();

    await user.unhover(screen.getByRole('button', { name: /2위 바이오/ }));
    expect(screen.queryByText('셀트리온')).toBeNull();
    expect(screen.getByText('삼성전자')).toBeInTheDocument();
  });

  it('keeps the preview while a pinned sector remains hovered and clears on leave', async () => {
    const user = userEvent.setup();
    render(
      <IndexSectorRankingPane
        basisDate="20260619"
        basisMode="hover"
        ranking={ranking}
        isLoading={false}
        error={null}
        onClearDatePin={() => {}}
        onOpenStock={() => {}}
      />,
    );

    await user.click(screen.getByRole('button', { name: /2위 바이오/ }));
    expect(screen.getByText('셀트리온')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /2위 바이오/ }));
    expect(screen.getByText('셀트리온')).toBeInTheDocument();

    await user.unhover(screen.getByRole('button', { name: /2위 바이오/ }));
    expect(screen.queryByText('셀트리온')).toBeNull();
    expect(screen.getByText('삼성전자')).toBeInTheDocument();
  });

  it('opens a stock through the supplied navigation callback', async () => {
    const user = userEvent.setup();
    const onOpenStock = vi.fn();
    render(
      <IndexSectorRankingPane
        basisDate="20260619"
        basisMode="hover"
        ranking={ranking}
        isLoading={false}
        error={null}
        onClearDatePin={() => {}}
        onOpenStock={onOpenStock}
      />,
    );

    await user.click(screen.getByRole('button', { name: /삼성전자 005930/ }));

    expect(onOpenStock).toHaveBeenCalledWith('005930', '삼성전자');
  });

  it('shows unavailable state for missing daily corpus', () => {
    render(
      <IndexSectorRankingPane
        basisDate="20260619"
        basisMode="hover"
        ranking={{ date: '20260619', source: 'unavailable', unavailable_reason: 'screener_daily_corpus_missing', sectors: [] }}
        isLoading={false}
        error={null}
        onClearDatePin={() => {}}
        onOpenStock={() => {}}
      />,
    );

    expect(screen.getByText('일봉 랭킹 데이터를 사용할 수 없습니다.')).toBeInTheDocument();
  });
});
