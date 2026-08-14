import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { WatchlistHeartActionButton } from './WatchlistHeartActionButton';
import { COMPACT_PADDING_INLINE } from './chartHeaderCompact';

function renderHeart(props: Partial<Parameters<typeof WatchlistHeartActionButton>[0]> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(['watchlist'], {
    folders: [{ id: 'f_1', name: '매매후보', order: 0 }],
    entries: [],
    next_run_at_ms: 0,
  });
  render(
    <QueryClientProvider client={qc}>
      <WatchlistHeartActionButton code="005930" name="삼성전자" isMember={false} {...props} />
    </QueryClientProvider>,
  );
  return screen.getByRole('button', { name: '관심 그룹 편집' });
}

describe('WatchlistHeartActionButton', () => {
  it('opens the shared group picker on click', () => {
    const btn = renderHeart();

    expect(screen.queryByTestId('watchlist-group-picker')).toBeNull();
    fireEvent.click(btn);

    // v3 에는 "미분류" 기본 대상이 없어 하트가 곧 그룹 선택이다(ADR-0070) —
    // 토글이 아니라 피커가 열리는 것이 옳은 동작이다.
    expect(screen.getByTestId('watchlist-group-picker')).toBeTruthy();
  });

  // 지수 창은 종목 코드가 없다. **숨기지 않고 비활성**으로 두는 것이 CollectButton 과
  // 같은 규칙이고, 헤더 폭 예산이 종목 유무에 따라 달라지지 않게 한다.
  it('is disabled and inert for an index window', () => {
    const btn = renderHeart({ code: null, name: null });

    expect((btn as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(btn);
    expect(screen.queryByTestId('watchlist-group-picker')).toBeNull();
  });

  it('reports membership through aria-pressed', () => {
    expect(renderHeart({ isMember: true }).getAttribute('aria-pressed')).toBe('true');
  });

  // 라벨이 없어 접을 것이 없지만, 이웃이 아이콘만 남을 때 혼자 넓은 패딩을 유지하면
  // 클릭 타겟이 어긋나고 2단계 폭 예산(LIVE_HEADER_NEED)도 어긋난다.
  it('narrows its padding with the rest of the action row', () => {
    expect(renderHeart({ compact: true }).style.paddingInline).toBe(COMPACT_PADDING_INLINE);
  });

  it('keeps the default padding while the row is expanded', () => {
    expect(renderHeart({ compact: false }).style.paddingInline).toBe('');
  });
});

describe('useWatchlistMembership 계약', () => {
  it('창이 한 번 부르고 내린다 — 버튼이 직접 부르지 않는다', async () => {
    // 훅의 계약은 "Call ONCE per component". 이 버튼은 창마다 하나뿐이라 직접 불러도
    // 리스트만큼 나쁘진 않지만, 소유권이 갈리면 같은 창에서 옵저버가 둘로 늘고
    // 타이틀바와 채움 상태가 갈릴 수 있다. 이름이 아니라 **import 문**을 본다.
    const src = (await import('./WatchlistHeartActionButton.tsx?raw')).default;
    expect(src).not.toMatch(/^import .*useWatchlistMembership/m);
    expect((await import('./ChartWindow.tsx?raw')).default).toContain('useWatchlistMembership()');
  });
});
