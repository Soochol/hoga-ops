import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WatchlistHeartButton } from './WatchlistHeartButton';

function renderHeartInInteractiveParent(onPointerDown = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(['watchlist'], {
    folders: [],
    entries: [],
    next_run_at_ms: 0,
  });
  render(
    <QueryClientProvider client={qc}>
      <div data-testid="parent" onPointerDown={onPointerDown}>
        <WatchlistHeartButton code="005930" name="삼성전자" isMember={false} variant="row" />
      </div>
    </QueryClientProvider>,
  );
  return { onPointerDown };
}

describe('WatchlistHeartButton', () => {
  it('does not bubble pointer down to an interactive row parent', () => {
    const { onPointerDown } = renderHeartInInteractiveParent();

    fireEvent.pointerDown(screen.getByRole('button', { name: '관심 그룹 편집' }));

    expect(onPointerDown).not.toHaveBeenCalled();
  });
});

describe('행마다 훅을 부르지 않는다 (useWatchlistMembership 계약)', () => {
  it('WatchlistHeartButton 은 useWatchlistMembership 을 직접 부르지 않는다', async () => {
    // 이 컴포넌트의 소비처는 둘 다 **리스트**라, 여기서 훅을 부르면 행마다 부르는
    // 셈이 된다(1,000행 = react-query 옵저버 1,000개). 훅 자신의 docstring 이
    // "Call ONCE per component (not per row)" 라고 못박고 있다. 실측(재렌더):
    // 500행 44 → 30 ms, 1,000행 65 → 59 ms. 리스트 소유자가 한 번 부르고 내려 준다.
    // 이름이 아니라 **import 문**을 본다 — 위 docstring 이 사연을 적으며 훅 이름을
    // 언급하므로, 이름만 grep 하면 주석에 걸려 항상 실패한다.
    const src = (await import('./WatchlistHeartButton.tsx?raw')).default;
    expect(src).not.toMatch(/^import .*useWatchlistMembership/m);
  });

  it('리스트 소유자들이 훅을 직접 부른다', async () => {
    for (const mod of [
      import('../screener/ResultTable.tsx?raw'),
      import('../live/LiveSymbolSearch.tsx?raw'),
    ]) {
      expect((await mod).default).toContain('useWatchlistMembership()');
    }
  });
});
