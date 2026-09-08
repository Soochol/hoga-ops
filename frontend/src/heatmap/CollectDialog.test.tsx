import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { expect, it, vi } from 'vitest';
import { CollectDialog } from './CollectDialog';
import { coveragePreview } from '../api/captures';
vi.mock('../api/captures', () => ({ coveragePreview: vi.fn(), bulkItems: vi.fn() }));
it('그룹 검색은 선택을 유지하고 전체 해제 후 선택한 고유 코드만 조회한다', async () => {
  vi.mocked(coveragePreview).mockImplementation(() => new Promise(() => {}));
  render(<QueryClientProvider client={new QueryClient()}><CollectDialog groups={[
    { id: 'a', name: '반도체', codes: ['005930', '000660'] },
    { id: 'b', name: '대형주', codes: ['005930'] },
  ]} onClose={() => {}} /></QueryClientProvider>);
  fireEvent.change(screen.getByRole('textbox', { name: '수집 대상 그룹 검색' }), { target: { value: '대형' } });
  expect(screen.getByText('대상 그룹 · 2/2개 선택')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '전체 해제' }));
  expect(screen.getByRole('button', { name: '커버리지 확인' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '대형주 1' }));
  fireEvent.click(screen.getByRole('button', { name: '커버리지 확인' }));
  await waitFor(() => expect(coveragePreview).toHaveBeenCalledWith({ codes: ['005930'], lookback_days: 10 }));
  expect(screen.getByRole('button', { name: '전체 선택' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '5일' })).toBeDisabled();
});
