import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { expect, it, vi } from 'vitest';
import { StudyViewsDrawer, filterStudyViews } from './StudyViewsDrawer';

vi.mock('./useStudyViews', () => ({
  useStudyViews: () => ({
    data: { schema_version: 1, saves: [
      { id: 'a', name: '급등 이후', code: '005930', label: '삼성전자', timeframe: '5m', memo: 'memo one' },
      { id: 'b', name: '눌림', code: '000660', label: 'SK하이닉스', timeframe: 'D', memo: 'space memo' },
    ] },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
}));

it('filters by name, code, and memo ignoring whitespace and case', () => {
  const rows = [
    { name: 'My View', code: '005930', memo: 'hello world' },
    { name: 'Other', code: '000660', memo: 'nothing' },
  ];
  expect(filterStudyViews(rows, 'myview')).toHaveLength(1);
  expect(filterStudyViews(rows, '005 930')).toHaveLength(1);
  expect(filterStudyViews(rows, 'HELLO WORLD')).toHaveLength(1);
});

it('renders list and no-match state', async () => {
  const qc = new QueryClient();
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/inventory']}><StudyViewsDrawer /></MemoryRouter>
    </QueryClientProvider>,
  );
  expect(screen.getByText('급등 이후')).toBeTruthy();
  await userEvent.type(screen.getByLabelText('저장 뷰 검색'), '없음');
  expect(screen.getByText('검색 결과가 없습니다.')).toBeTruthy();
  expect(screen.getByText('차트 화면에서 저장할 수 있습니다.')).toBeTruthy();
});
