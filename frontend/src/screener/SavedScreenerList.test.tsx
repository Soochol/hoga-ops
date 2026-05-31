import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SavedScreenerList } from './SavedScreenerList';

vi.mock('../api/savedScreeners', () => ({
  listSaves: vi.fn(() => Promise.resolve({ schema_version: 1, saves: [
    { id: 's1', name: '급등주', conditions: [], universe: {}, created_at_ms: 1, updated_at_ms: 1 }] })),
  createSave: vi.fn(() => Promise.resolve({ id: 's2' })),
  updateSave: vi.fn(() => Promise.resolve({})),
  deleteSave: vi.fn(() => Promise.resolve()),
}));
import * as api from '../api/savedScreeners';

const wrap = (ui: React.ReactNode) =>
  render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);

beforeEach(() => vi.clearAllMocks());

describe('SavedScreenerList', () => {
  it('renders saved names and loads (no scan) on click', async () => {
    const onLoad = vi.fn();
    wrap(<SavedScreenerList current={{ conditions: [], universe: {} }} onLoad={onLoad} />);
    const item = await screen.findByText('급등주');
    fireEvent.click(item);
    expect(onLoad).toHaveBeenCalledWith(expect.objectContaining({ id: 's1' }));
  });

  it('creates a new save with a name', async () => {
    wrap(<SavedScreenerList current={{ conditions: [], universe: {} }} onLoad={vi.fn()} />);
    await screen.findByText('급등주');
    vi.spyOn(window, 'prompt').mockReturnValue('새이름');
    fireEvent.click(screen.getByRole('button', { name: '새로 저장' }));
    await waitFor(() => expect(api.createSave).toHaveBeenCalledWith(
      expect.objectContaining({ name: '새이름' })));
  });
});
