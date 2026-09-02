import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { HeatmapEntry } from '../api/heatmap';

/**
 * 보드(`/heatmap`) 카드의 「＋종목」 — 이미 그 그룹에 있는 종목을 고르면 **말해 준다**.
 *
 * 그전엔 중복 검사가 아예 없었다: 서버 add 가 멱등(이름만 갱신)이라 「추가」를 눌러도
 * 팝오버만 닫히고 **아무 일도 안 일어났다**. `api/watchlist.ts` 의 `addMember` 주석이
 * 조건하는 바로 그 모양이다 — "눌렀는데 아무 일도 안 일어난다".
 *
 * 판정과 하이라이트를 **그룹 블록이 소유한다**: 카드가 자기 `entries` 로 판정하므로
 * 카드마다 react-query 옵저버가 늘지 않고, 하이라이트 스코프가 카드 경계와 같아진다
 * (`heatmap-row-<code>` 는 다중 소속이라 보드 전체에서 고유하지 않다).
 */

vi.mock('../capture/SymbolSearch', () => ({
  SymbolSearch: ({ onChange }: { onChange: (h: { code: string; name: string; market: string }) => void }) =>
    <button data-testid="pick" onClick={() => onChange({ code: '005930', name: '삼성전자', market: 'KOSPI' })}>pick</button>,
}));
const { addToFolder } = vi.hoisted(() => ({ addToFolder: vi.fn(() => Promise.resolve()) }));
vi.mock('./useAddToFolder', () => ({
  useAddToFolder: () => ({ addToFolder, isPending: false, error: null }),
}));

import { HeatmapFolder } from './HeatmapFolder';

const entry = (code: string, name: string): HeatmapEntry =>
  ({ code, name, folder_id: 'f1', order: 0 } as HeatmapEntry);

function renderCard(entries: HeatmapEntry[]) {
  return render(
    <HeatmapFolder
      folder={{ id: 'f1', name: '반도체', order: 0 }}
      entries={entries}
      quoteByCode={new Map()}
      sortMode="manual"
      onPick={vi.fn()}
    />,
  );
}

function openAddAndPick() {
  fireEvent.click(screen.getByRole('button', { name: '종목 추가' }));
  fireEvent.click(screen.getByTestId('pick'));
}

describe('HeatmapFolder — 카드 ＋종목의 중복 안내', () => {
  beforeEach(() => {
    cleanup();
    addToFolder.mockClear();
    // jsdom 에는 scrollIntoView 가 없다(구현부도 `?.` 로 호출한다).
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('이미 그 그룹에 있으면 알리고, 추가를 보내지 않는다', async () => {
    renderCard([entry('005930', '삼성전자'), entry('000660', 'SK하이닉스')]);
    openAddAndPick();

    expect(await screen.findByText(/이미 이 그룹에 있습니다/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '추가' })).toBeDisabled();
    // 서버가 멱등이라 보내 봐야 아무 일도 안 일어난다 — 아예 보내지 않는 것이 계약이다.
    fireEvent.click(screen.getByRole('button', { name: '추가' }));
    expect(addToFolder).not.toHaveBeenCalled();
  });

  it('그 행을 하이라이트하고 그 자리로 스크롤한다', async () => {
    renderCard([entry('000660', 'SK하이닉스'), entry('005930', '삼성전자')]);
    expect(screen.getByTestId('heatmap-row-005930').className).not.toContain('row-flash');

    openAddAndPick();

    await waitFor(() =>
      expect(screen.getByTestId('heatmap-row-005930').className).toContain('row-flash'));
    // 하이라이트만으로는 부족하다 — 화면 밖이면 아무것도 안 보인다(보드는 multicolumn).
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ block: 'center' });
    // 다른 행은 건드리지 않는다.
    expect(screen.getByTestId('heatmap-row-000660').className).not.toContain('row-flash');
  });

  it('없는 종목이면 평소대로 추가한다', async () => {
    renderCard([entry('000660', 'SK하이닉스')]);
    openAddAndPick();

    expect(screen.queryByText(/이미 이 그룹에 있습니다/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '추가' }));
    await waitFor(() => expect(addToFolder).toHaveBeenCalledWith('005930', 'f1'));
  });
});
