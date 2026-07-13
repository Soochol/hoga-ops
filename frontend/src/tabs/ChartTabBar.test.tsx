import { it, expect, vi } from 'vitest';
import { type ComponentProps } from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { ChartTabBar } from './ChartTabBar';
import { StudyTabBar } from '../studyViews/StudyTabBar';
import type { StudyTab } from '../state/studyTabs';

type TestTab = { id: string; code: string; label: string; pinned?: boolean };

function makeTabs(count: number): TestTab[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `tab-${index}`,
    code: String(100000 + index),
    label: `종목 ${index + 1}`,
  }));
}

function setup(over: Partial<ComponentProps<typeof ChartTabBar<TestTab>>> = {}) {
  const props: ComponentProps<typeof ChartTabBar<TestTab>> = {
    tabs: makeTabs(3),
    activeTabId: 'tab-0',
    activeLoading: false,
    onFocus: vi.fn(),
    onClose: vi.fn(),
    onReorder: vi.fn(),
    renderLabel: (tab) => tab.label,
    ...over,
  };
  render(<ChartTabBar {...props} />);
  return props;
}

/** jsdom은 레이아웃이 없어 스크롤 지표가 전부 0 — 오버플로 상황을 직접 주입한다. */
function fakeScrollMetrics(el: HTMLElement, { scrollWidth, clientWidth, scrollLeft }: {
  scrollWidth: number; clientWidth: number; scrollLeft: number;
}) {
  Object.defineProperty(el, 'scrollWidth', { value: scrollWidth, configurable: true });
  Object.defineProperty(el, 'clientWidth', { value: clientWidth, configurable: true });
  Object.defineProperty(el, 'scrollLeft', { value: scrollLeft, writable: true, configurable: true });
  // jsdom엔 Element.scrollBy가 없어 스크롤 화살표는 폴백 경로를 타지만,
  // 실브라우저의 smooth 스크롤 경로를 검증하려면 즉시 적용 스텁을 심는다.
  Object.defineProperty(el, 'scrollBy', {
    value: (opts: { left: number }) => { el.scrollLeft += opts.left; },
    configurable: true,
  });
}

it('shows no hidden-tab chip when every tab fits', () => {
  setup();
  expect(screen.queryByLabelText(/가려진 탭/)).toBeNull();
});

it('counts window-clipped tabs in the hidden chip and opens the full list from it', () => {
  setup({ tabs: makeTabs(80), activeTabId: 'tab-0' });

  // 렌더 윈도우 24개를 넘는 56개는 항상 '가려짐'
  const chip = screen.getByLabelText('가려진 탭 56개 목록 열기');
  expect(chip).toHaveTextContent('+56');

  fireEvent.click(chip);
  const dialog = screen.getByRole('dialog', { name: '열린 탭' });
  expect(within(dialog).getByPlaceholderText('탭 검색')).toBeInTheDocument();
  expect(within(dialog).getByText('종목 1')).toBeInTheDocument();
});

it('adds scrolled-out tabs to the hidden chip after a scroll event', () => {
  setup({ tabs: makeTabs(5), activeTabId: 'tab-0' });
  expect(screen.queryByLabelText(/가려진 탭/)).toBeNull();

  const tablist = screen.getByRole('tablist');
  // jsdom에선 모든 탭의 offsetLeft가 0이라, scrollLeft>0이면 5개 전부 뷰포트 밖으로 계산된다.
  fakeScrollMetrics(tablist, { scrollWidth: 500, clientWidth: 200, scrollLeft: 40 });
  fireEvent.scroll(tablist);

  expect(screen.getByLabelText('가려진 탭 5개 목록 열기')).toHaveTextContent('+5');
});

it('translates vertical wheel into horizontal tab scrolling when overflowing', () => {
  setup({ tabs: makeTabs(5), activeTabId: 'tab-0' });
  const tablist = screen.getByRole('tablist');
  fakeScrollMetrics(tablist, { scrollWidth: 500, clientWidth: 200, scrollLeft: 0 });

  fireEvent.wheel(tablist, { deltaY: 48, deltaX: 0 });
  expect(tablist.scrollLeft).toBe(48);

  // 트랙패드 가로 제스처(deltaX 우세)는 브라우저 기본 동작에 맡긴다
  fireEvent.wheel(tablist, { deltaY: 2, deltaX: 30 });
  expect(tablist.scrollLeft).toBe(48);
});

it('ignores vertical wheel when tabs fit (no overflow)', () => {
  setup({ tabs: makeTabs(2), activeTabId: 'tab-0' });
  const tablist = screen.getByRole('tablist');
  fakeScrollMetrics(tablist, { scrollWidth: 200, clientWidth: 200, scrollLeft: 0 });

  fireEvent.wheel(tablist, { deltaY: 48, deltaX: 0 });
  expect(tablist.scrollLeft).toBe(0);
});

it('makes render-window ellipsis markers interactive — click opens the tab list', () => {
  setup({ tabs: makeTabs(80), activeTabId: 'tab-40' });

  // windowStart = 40 - 12 = 28, 렌더 24개 → 앞 28개 / 뒤 28개가 윈도우 밖
  const prevMarker = screen.getByLabelText('이전 탭 28개 목록 열기');
  expect(screen.getByLabelText('다음 탭 28개 목록 열기')).toBeInTheDocument();

  fireEvent.click(prevMarker);
  expect(screen.getByRole('dialog', { name: '열린 탭' })).toBeInTheDocument();
});

it('shows scroll arrows only toward the overflowing side and pages by 60% viewport', () => {
  setup({ tabs: makeTabs(5), activeTabId: 'tab-0' });
  expect(screen.queryByLabelText('탭 왼쪽으로 스크롤')).toBeNull();
  expect(screen.queryByLabelText('탭 오른쪽으로 스크롤')).toBeNull();

  const tablist = screen.getByRole('tablist');
  fakeScrollMetrics(tablist, { scrollWidth: 500, clientWidth: 200, scrollLeft: 0 });
  fireEvent.scroll(tablist);

  // 왼쪽 여지 없음 → 오른쪽 화살표만
  expect(screen.queryByLabelText('탭 왼쪽으로 스크롤')).toBeNull();
  fireEvent.click(screen.getByLabelText('탭 오른쪽으로 스크롤'));
  expect(tablist.scrollLeft).toBe(120); // max(120, 200*0.6)

  fireEvent.scroll(tablist);
  fireEvent.click(screen.getByLabelText('탭 왼쪽으로 스크롤'));
  expect(tablist.scrollLeft).toBe(0);
});

it('renders the built-in tab list menu on the study tab bar', () => {
  const tabs: StudyTab[] = [
    { id: 's1', viewId: 'v1', code: '005930', label: '삼성전자 저장뷰', name: '삼성전자', timeframe: '1m' },
    { id: 's2', viewId: 'v2', code: '000660', label: '하이닉스 저장뷰', name: 'SK하이닉스', timeframe: 'D' },
  ];
  render(
    <StudyTabBar
      tabs={tabs}
      activeTabId="s1"
      activeLoading={false}
      onFocus={vi.fn()}
      onClose={vi.fn()}
      onReorder={vi.fn()}
      onNewTab={vi.fn()}
    />,
  );

  fireEvent.click(screen.getByLabelText('열린 탭 목록'));
  const dialog = screen.getByRole('dialog', { name: '열린 탭' });
  expect(within(dialog).getByText('삼성전자 저장뷰')).toBeInTheDocument();
  expect(within(dialog).getByText('하이닉스 저장뷰')).toBeInTheDocument();
});
