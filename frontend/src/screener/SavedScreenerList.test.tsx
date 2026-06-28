import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SavedScreenerList } from './SavedScreenerList';

const SAVED_CONDS = [{ id: 'orig', type: 'new_high', params: { lookback: 200, period: 500 } }];
const SAVED_UNIVERSE = { markets: ['KOSPI'] };
vi.mock('../api/savedScreeners', () => ({
  listSaves: vi.fn(() => Promise.resolve({ schema_version: 1, saves: [
    { id: 's1', name: '급등주', conditions: SAVED_CONDS, universe: SAVED_UNIVERSE, created_at_ms: 1, updated_at_ms: 1 },
    { id: 's2', name: '눌림목', conditions: [], universe: {}, created_at_ms: 1, updated_at_ms: 1 }] })),
}));

const FILL = 'bg-tint-selection';
const BAR = 'shadow-[inset_2px_0_0_var(--accent)]';

type Props = React.ComponentProps<typeof SavedScreenerList>;
const mount = (over: Partial<Props> = {}) => {
  const props: Props = {
    anchorId: null, dirty: false,
    onLoad: vi.fn(), onNewDraft: vi.fn(), onSaveAsNew: vi.fn(),
    onDuplicate: vi.fn(), onRename: vi.fn(), onRemove: vi.fn(),
    ...over,
  };
  render(<QueryClientProvider client={new QueryClient()}><SavedScreenerList {...props} /></QueryClientProvider>);
  return props;
};
const rowOf = (name: string) => screen.getByText(name).closest('[role="button"]') as HTMLElement;

beforeEach(() => vi.clearAllMocks());

describe('SavedScreenerList', () => {
  it('＋ starts a blank draft (calls onNewDraft) then opens the name editor', async () => {
    const onNewDraft = vi.fn();
    mount({ onNewDraft });
    await screen.findByText('급등주');
    fireEvent.click(screen.getByRole('button', { name: '새 조건검색' }));
    expect(onNewDraft).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('조건검색 이름')).toBeInTheDocument();
  });

  it('renders saved names and loads (no scan) on click', async () => {
    const { onLoad } = mount();
    fireEvent.click(await screen.findByText('급등주'));
    expect(onLoad).toHaveBeenCalledWith(expect.objectContaining({ id: 's1' }));
  });

  it('fires onSaveAsNew via inline edit (＋ → type → blur)', async () => {
    const { onSaveAsNew } = mount();
    await screen.findByText('급등주');
    fireEvent.click(screen.getByRole('button', { name: '새 조건검색' }));
    const input = screen.getByLabelText('조건검색 이름');
    fireEvent.change(input, { target: { value: '새이름' } });
    fireEvent.blur(input);
    await waitFor(() => expect(onSaveAsNew).toHaveBeenCalledWith('새이름'));
  });

  it('create with an empty/whitespace name does not fire onSaveAsNew', async () => {
    const { onSaveAsNew } = mount();
    await screen.findByText('급등주');
    fireEvent.click(screen.getByRole('button', { name: '새 조건검색' }));
    const input = screen.getByLabelText('조건검색 이름');
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.blur(input);
    expect(onSaveAsNew).not.toHaveBeenCalled();
  });

  it('create cancels on Escape (no onSaveAsNew, editor closed)', async () => {
    const { onSaveAsNew } = mount();
    await screen.findByText('급등주');
    fireEvent.click(screen.getByRole('button', { name: '새 조건검색' }));
    const input = screen.getByLabelText('조건검색 이름');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onSaveAsNew).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('조건검색 이름')).not.toBeInTheDocument();
  });

  it('rename fires onRename(save, name); same name does not fire', async () => {
    const { onRename } = mount();
    await screen.findByText('급등주');
    fireEvent.click(within(rowOf('급등주')).getByRole('button', { name: '저장 조건 메뉴' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '이름변경' }));
    const input = screen.getByLabelText('조건검색 이름');
    fireEvent.change(input, { target: { value: '새이름' } });
    fireEvent.blur(input);
    await waitFor(() => expect(onRename).toHaveBeenCalledWith(expect.objectContaining({ id: 's1' }), '새이름'));
  });

  it('rename to the same name does not fire onRename', async () => {
    const { onRename } = mount();
    await screen.findByText('급등주');
    fireEvent.click(within(rowOf('급등주')).getByRole('button', { name: '저장 조건 메뉴' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '이름변경' }));
    const input = screen.getByLabelText('조건검색 이름');
    fireEvent.blur(input);   // value unchanged === '급등주'
    expect(onRename).not.toHaveBeenCalled();
  });

  it('rename reverts on Escape (no onRename)', async () => {
    const { onRename } = mount();
    await screen.findByText('급등주');
    fireEvent.click(within(rowOf('급등주')).getByRole('button', { name: '저장 조건 메뉴' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '이름변경' }));
    const input = screen.getByLabelText('조건검색 이름');
    fireEvent.change(input, { target: { value: '바뀐이름' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onRename).not.toHaveBeenCalled();
    expect(screen.getByText('급등주')).toBeInTheDocument();
  });

  it('delete 🗑 → confirm → 삭제 fires onRemove(save)', async () => {
    const { onRemove } = mount();
    await screen.findByText('급등주');
    fireEvent.click(within(rowOf('급등주')).getByRole('button', { name: '저장 조건 메뉴' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '삭제' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '삭제' }));
    expect(onRemove).toHaveBeenCalledWith(expect.objectContaining({ id: 's1' }));
  });

  it('filters saved screeners by name', async () => {
    mount();
    await screen.findByText('급등주');
    fireEvent.change(screen.getByLabelText('저장 조건검색 검색'), { target: { value: '눌림' } });
    expect(screen.queryByText('급등주')).not.toBeInTheDocument();
    expect(screen.getByText('눌림목')).toBeInTheDocument();
  });

  it('duplicate in the row menu fires onDuplicate(save)', async () => {
    const onDuplicate = vi.fn();
    mount({ onDuplicate } as Partial<Props>);
    await screen.findByText('급등주');
    fireEvent.click(within(rowOf('급등주')).getByRole('button', { name: '저장 조건 메뉴' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '복제' }));
    expect(onDuplicate).toHaveBeenCalledWith(expect.objectContaining({ id: 's1' }));
  });

  it('renders the row action menu as a fixed popover so it is not clipped by the list', async () => {
    mount();
    await screen.findByText('급등주');
    fireEvent.click(within(rowOf('급등주')).getByRole('button', { name: '저장 조건 메뉴' }));
    expect(screen.getByRole('menu').className).toContain('fixed');
    expect(screen.getByRole('menu').className).not.toContain('absolute');
  });

  it('anchored row is clean-highlighted (teal fill, no 수정됨) when not dirty', async () => {
    mount({ anchorId: 's1', dirty: false });
    await screen.findByText('급등주');
    expect(rowOf('급등주').className).toContain(FILL);
    expect(screen.queryByText('수정됨')).not.toBeInTheDocument();
  });

  it('anchored row shows 수정됨 and drops the fill (bar only) when dirty', async () => {
    mount({ anchorId: 's1', dirty: true });
    await screen.findByText('급등주');
    expect(screen.getByText('수정됨')).toBeInTheDocument();
    expect(rowOf('급등주').className).not.toContain(FILL);
    expect(rowOf('급등주').className).toContain(BAR);
  });
});
