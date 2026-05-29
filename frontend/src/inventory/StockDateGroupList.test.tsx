import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StockDateGroupList } from './StockDateGroupList';
import type { StockDate } from '../api/types';

const row = (code: string, name: string, date: string, capturedAt = 1000, size = 1_000_000): StockDate => ({
  date, code, name,
  regular_session_open_ms: 0, regular_session_close_ms: 0,
  data_window_first_ms: 0, data_window_last_ms: 0,
  price_min: 0, price_max: 0,
  captured_at: capturedAt,
  total_volume: 0, pages_collected: 0, file_size_bytes: size,
  today_open: 0, today_high: 0, today_low: 0, today_close: 0,
  disk_state: 'complete',
  full_capture_count: null,
  fail_streak: 0,
  blocked: false,
});

const rows: StockDate[] = [
  row('005930', '삼성전자', '20260522', 3000),
  row('005930', '삼성전자', '20260521', 2000),
  row('000660', 'SK하이닉스', '20260521', 4000),
  row('035720', '카카오',    '20260522', 5000),
];

describe('StockDateGroupList', () => {
  it('renders the header summary (groups count and dates count)', () => {
    render(<StockDateGroupList rows={rows} selectedCode={null} onSelect={() => {}} />);
    expect(screen.getByText(/종목 3개/)).toBeTruthy();
    expect(screen.getByText(/캡처 4건/)).toBeTruthy();
  });

  it('renders all groups sorted by lastCapturedAt desc', () => {
    render(<StockDateGroupList rows={rows} selectedCode={null} onSelect={() => {}} />);
    const codes = screen.getAllByText(/^0\d{5}$|^03\d{4}$/).map(el => el.textContent);
    expect(codes).toEqual(['035720', '000660', '005930']);
  });

  it('filters by name when search input changes', async () => {
    render(<StockDateGroupList rows={rows} selectedCode={null} onSelect={() => {}} />);
    const search = screen.getByPlaceholderText('종목명 또는 코드…');
    await userEvent.type(search, '삼성');
    expect(screen.queryByText('SK하이닉스')).toBeNull();
    expect(screen.getByText('삼성전자')).toBeTruthy();
    expect(screen.getByText('1 matches')).toBeTruthy();
  });

  it('filters by code prefix', async () => {
    render(<StockDateGroupList rows={rows} selectedCode={null} onSelect={() => {}} />);
    const search = screen.getByPlaceholderText('종목명 또는 코드…');
    await userEvent.type(search, '0059');
    expect(screen.queryByText('SK하이닉스')).toBeNull();
    expect(screen.getByText('삼성전자')).toBeTruthy();
  });

  it('shows "검색 결과 없음" when filter returns 0 groups', async () => {
    render(<StockDateGroupList rows={rows} selectedCode={null} onSelect={() => {}} />);
    const search = screen.getByPlaceholderText('종목명 또는 코드…');
    await userEvent.type(search, 'NOMATCH_XYZ');
    expect(screen.getByText('검색 결과 없음')).toBeTruthy();
  });

  it('calls onSelect with the group code when an item is clicked', () => {
    const onSelect = vi.fn();
    render(<StockDateGroupList rows={rows} selectedCode={null} onSelect={onSelect} />);
    fireEvent.click(screen.getByText('삼성전자'));
    expect(onSelect).toHaveBeenCalledWith('005930');
  });

  it('clear button (×) appears when input has value and clears the search', async () => {
    render(<StockDateGroupList rows={rows} selectedCode={null} onSelect={() => {}} />);
    const search = screen.getByPlaceholderText('종목명 또는 코드…') as HTMLInputElement;
    await userEvent.type(search, '삼성');
    const clear = screen.getByRole('button', { name: /clear search/i });
    fireEvent.click(clear);
    expect(search.value).toBe('');
    expect(screen.getByText('SK하이닉스')).toBeTruthy();
  });
});
