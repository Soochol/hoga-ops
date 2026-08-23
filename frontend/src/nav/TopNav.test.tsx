import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import TopNav from './TopNav';
import { useRightRailStore } from '../state/rightRail';

vi.mock('./CaptureInlineStatus', () => ({
  CaptureInlineStatus: () => null,
}));

// 라벨의 오리진은 런타임 설정에서 나온다(StatusDot.test.tsx 가 검증) — 여기서
// 특정 포트를 흉내 내면 그 리터럴이 다시 계약처럼 보인다.
vi.mock('./StatusDot', () => ({
  default: () => <span>WS</span>,
}));

// The symbol search now lives in the TopNav header line but only on /live.
// Stub it so these nav-structure assertions stay isolated from live stores.
vi.mock('../live/LiveSymbolSearch', () => ({
  LiveSymbolSearch: () => <div data-testid="live-symbol-search" />,
}));

function W({ children, route = '/live' }: { children: ReactNode; route?: string }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[route]}>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

describe('TopNav', () => {
  beforeEach(() => {
    cleanup();
    localStorage.clear();
    useRightRailStore.setState({ activePanel: null, lastPanel: 'watchlist' });
  });

  it('renders workspace links in the approved order and Settings at the end', () => {
    render(<TopNav onOpenSettings={vi.fn()} />, { wrapper: W });

    const labels = screen.getAllByRole('link').map((link) => link.textContent);

    expect(labels).toEqual([
      '라이브', '히트맵', '시장 종합', '스크리너', '옵션심리', '보관함', '캡처',
    ]);
    expect(screen.getByRole('button', { name: '설정' })).toBeInTheDocument();
    expect(screen.queryByText('Watchlist')).not.toBeInTheDocument();
  });

  it('renders only the hoga-ops brand text, without the old subtitle', () => {
    render(<TopNav onOpenSettings={vi.fn()} />, { wrapper: W });

    expect(screen.getByText('hoga-ops')).toBeInTheDocument();
    expect(screen.queryByText(/orderbook replay/i)).not.toBeInTheDocument();
  });

  it('uses text-only active styling for the current route', () => {
    render(<TopNav onOpenSettings={vi.fn()} />, { wrapper: W });

    const liveLink = screen.getByRole('link', { name: '라이브' });

    expect(liveLink).toHaveClass('text-fg', 'font-bold');
    expect(liveLink.className).not.toContain('before:');
    expect(liveLink).not.toHaveClass('border-border-strong', 'bg-tint-selection');
    expect(liveLink.querySelector('[aria-hidden="true"]')).toBeNull();
  });

  it('mounts the symbol search in the header on /live', () => {
    render(<TopNav onOpenSettings={vi.fn()} />, {
      wrapper: ({ children }) => <W route="/live">{children}</W>,
    });

    expect(screen.getByTestId('live-symbol-search')).toBeInTheDocument();
  });

  it('hides the symbol search on non-live routes', () => {
    render(<TopNav onOpenSettings={vi.fn()} />, {
      wrapper: ({ children }) => <W route="/heatmap">{children}</W>,
    });

    expect(screen.queryByTestId('live-symbol-search')).toBeNull();
  });

  it('라이브 nav 는 관심종목 패널을 함께 연다', () => {
    render(<TopNav onOpenSettings={vi.fn()} />, { wrapper: W });

    fireEvent.click(screen.getByRole('link', { name: '라이브' }));

    expect(useRightRailStore.getState().activePanel).toBe('watchlist');
  });

  // 「복기」 nav 가 저장뷰 패널을 함께 열던 케이스가 여기 있었다 — 그 라우트와 함께
  // 사라졌다(2026-08-23). 저장뷰 패널은 이제 우측 레일 버튼으로만 연다.

  // 열림이 아니라 **교체**다: 다른 패널을 보던 중에 눌러도 그 라우트의 패널로 간다.
  it('다른 패널이 열려 있어도 그 라우트의 패널로 교체한다', () => {
    useRightRailStore.setState({ activePanel: 'screener', lastPanel: 'screener' });
    render(<TopNav onOpenSettings={vi.fn()} />, { wrapper: W });

    fireEvent.click(screen.getByRole('link', { name: '라이브' }));

    expect(useRightRailStore.getState().activePanel).toBe('watchlist');
    // 레일 쉐브론이 다시 열 대상도 방금 연 패널이어야 한다(setActivePanel 계약).
    expect(useRightRailStore.getState().lastPanel).toBe('watchlist');
  });

  // toggle 이었다면 여기서 닫힌다 — "누르면 열린다" 와 정반대다.
  it('같은 nav 를 다시 눌러도 패널이 닫히지 않는다', () => {
    render(<TopNav onOpenSettings={vi.fn()} />, { wrapper: W });
    const live = screen.getByRole('link', { name: '라이브' });

    fireEvent.click(live);
    fireEvent.click(live);

    expect(useRightRailStore.getState().activePanel).toBe('watchlist');
  });

  it('패널이 지정되지 않은 nav 는 열린 패널을 그대로 둔다', () => {
    useRightRailStore.setState({ activePanel: 'watchlist', lastPanel: 'watchlist' });
    render(<TopNav onOpenSettings={vi.fn()} />, { wrapper: W });

    fireEvent.click(screen.getByRole('link', { name: '히트맵' }));

    expect(useRightRailStore.getState().activePanel).toBe('watchlist');
  });

  // 새 탭으로 여는 클릭은 이 탭에서 이동이 일어나지 않는다 — 그런데 패널만 바뀌면
  // 사용자는 건드린 적 없는 화면이 변한 걸 보게 된다.
  it('새 탭 클릭(ctrl/meta/shift/alt)은 이 탭의 패널을 바꾸지 않는다', () => {
    render(<TopNav onOpenSettings={vi.fn()} />, { wrapper: W });
    const live = screen.getByRole('link', { name: '라이브' });

    for (const modifier of ['ctrlKey', 'metaKey', 'shiftKey', 'altKey'] as const) {
      fireEvent.click(live, { [modifier]: true });
      expect(useRightRailStore.getState().activePanel).toBeNull();
    }
  });

  it('opens settings through a button instead of navigating', () => {
    const onOpenSettings = vi.fn();
    render(<TopNav onOpenSettings={onOpenSettings} />, { wrapper: W });

    const settings = screen.getByRole('button', { name: '설정' });

    settings.click();
    expect(onOpenSettings).toHaveBeenCalledOnce();
    expect(screen.queryByRole('link', { name: '설정' })).toBeNull();
  });
});
