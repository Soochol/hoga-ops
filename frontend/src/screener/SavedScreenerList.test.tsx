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
  createSave: vi.fn(() => Promise.resolve({ id: 's-new', name: '새이름', conditions: [], universe: {}, created_at_ms: 2, updated_at_ms: 2 })),
  updateSave: vi.fn(() => Promise.resolve({})),
  deleteSave: vi.fn(() => Promise.resolve()),
}));
import * as api from '../api/savedScreeners';
import type { ConditionLeaf } from '../api/screener';

const BUILDER = {
  conditions: [{ id: 'b', type: 'trade_value', params: { min_eok: 99 } }] as ConditionLeaf[],
  universe: { exclude_etf: true },
};
const FILL = 'bg-[rgba(20,184,166,0.14)]';
const BAR = 'shadow-[inset_2px_0_0_var(--accent)]';

type Props = React.ComponentProps<typeof SavedScreenerList>;
const mount = (over: Partial<Props> = {}) => {
  const props: Props = {
    current: { conditions: [], universe: {} },
    anchorId: null, dirty: false, onLoad: vi.fn(), onBeginSave: vi.fn(), onAnchorChange: vi.fn(), onNew: vi.fn(),
    ...over,
  };
  render(<QueryClientProvider client={new QueryClient()}><SavedScreenerList {...props} /></QueryClientProvider>);
  return props;
};
const rowOf = (name: string) => screen.getByText(name).closest('[role="button"]') as HTMLElement;

beforeEach(() => vi.clearAllMocks());

describe('SavedScreenerList', () => {
  it('＋ starts a blank draft (calls onNew) then opens the name editor', async () => {
    const onNew = vi.fn();
    mount({ onNew });
    await screen.findByText('급등주');
    fireEvent.click(screen.getByRole('button', { name: '새로 저장' }));
    expect(onNew).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('조건검색 이름')).toBeInTheDocument();
  });

  it('renders saved names and loads (no scan) on click', async () => {
    const { onLoad } = mount();
    fireEvent.click(await screen.findByText('급등주'));
    expect(onLoad).toHaveBeenCalledWith(expect.objectContaining({ id: 's1' }));
  });

  it('creates a new save via inline edit (＋ → type → blur)', async () => {
    mount();
    await screen.findByText('급등주');
    fireEvent.click(screen.getByRole('button', { name: '새로 저장' }));
    const input = screen.getByLabelText('조건검색 이름');
    fireEvent.change(input, { target: { value: '새이름' } });
    fireEvent.blur(input);
    await waitFor(() => expect(api.createSave).toHaveBeenCalledWith(expect.objectContaining({ name: '새이름' })));
  });

  it('re-anchors to the newly created save, signalling save-start first', async () => {
    const { onAnchorChange, onBeginSave } = mount({ current: BUILDER });
    await screen.findByText('급등주');
    fireEvent.click(screen.getByRole('button', { name: '새로 저장' }));
    const input = screen.getByLabelText('조건검색 이름');
    fireEvent.change(input, { target: { value: '새이름' } });
    fireEvent.blur(input);
    expect(onBeginSave).toHaveBeenCalled();
    await waitFor(() => expect(onAnchorChange).toHaveBeenCalledWith('s-new'));
  });

  it('create with an empty name does nothing', async () => {
    const { onBeginSave } = mount();
    await screen.findByText('급등주');
    fireEvent.click(screen.getByRole('button', { name: '새로 저장' }));
    const input = screen.getByLabelText('조건검색 이름');
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.blur(input);
    expect(api.createSave).not.toHaveBeenCalled();
    expect(onBeginSave).not.toHaveBeenCalled();
  });

  it('create cancels on Escape (no save)', async () => {
    mount();
    await screen.findByText('급등주');
    fireEvent.click(screen.getByRole('button', { name: '새로 저장' }));
    const input = screen.getByLabelText('조건검색 이름');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(api.createSave).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('조건검색 이름')).not.toBeInTheDocument();
  });

  it('rename changes ONLY the name, keeps the save\'s own conditions/universe, and does NOT re-anchor', async () => {
    const { onAnchorChange } = mount({ current: BUILDER });
    await screen.findByText('급등주');
    fireEvent.click(within(rowOf('급등주')).getByRole('button', { name: '이름변경' }));
    const input = screen.getByLabelText('조건검색 이름');
    fireEvent.change(input, { target: { value: '새이름' } });
    fireEvent.blur(input);
    await waitFor(() => expect(api.updateSave).toHaveBeenCalled());
    const [id, body] = vi.mocked(api.updateSave).mock.calls[0];
    expect(id).toBe('s1');
    expect(body.name).toBe('새이름');
    expect(body.conditions).toEqual(SAVED_CONDS);
    expect(body.universe).toEqual(SAVED_UNIVERSE);
    expect(onAnchorChange).not.toHaveBeenCalled();
  });

  it('rename reverts on Escape (no update)', async () => {
    mount();
    await screen.findByText('급등주');
    fireEvent.click(within(rowOf('급등주')).getByRole('button', { name: '이름변경' }));
    const input = screen.getByLabelText('조건검색 이름');
    fireEvent.change(input, { target: { value: '바뀐이름' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(api.updateSave).not.toHaveBeenCalled();
    expect(screen.getByText('급등주')).toBeInTheDocument();
  });

  it('overwrite saves the live builder onto the save (keeps name, re-anchors) after a target-naming confirm', async () => {
    const { onAnchorChange, onBeginSave } = mount({ current: BUILDER });
    await screen.findByText('급등주');
    fireEvent.click(within(rowOf('급등주')).getByRole('button', { name: '현재 조건으로 덮어쓰기' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('급등주');
    fireEvent.click(screen.getByRole('button', { name: '덮어쓰기' }));
    expect(onBeginSave).toHaveBeenCalled();
    await waitFor(() => expect(api.updateSave).toHaveBeenCalled());
    const [id, body] = vi.mocked(api.updateSave).mock.calls[0];
    expect(id).toBe('s1');
    expect(body.name).toBe('급등주');
    expect(body.conditions).toEqual(BUILDER.conditions);
    expect(body.universe).toEqual(BUILDER.universe);
    await waitFor(() => expect(onAnchorChange).toHaveBeenCalledWith('s1'));
  });

  it('overwrite does nothing when the modal is dismissed', async () => {
    const { onAnchorChange, onBeginSave } = mount({ current: BUILDER });
    await screen.findByText('급등주');
    fireEvent.click(within(rowOf('급등주')).getByRole('button', { name: '현재 조건으로 덮어쓰기' }));
    fireEvent.click(screen.getByRole('button', { name: '취소' }));
    expect(api.updateSave).not.toHaveBeenCalled();
    expect(onBeginSave).not.toHaveBeenCalled();
    expect(onAnchorChange).not.toHaveBeenCalled();
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

  it('delete clears the anchor when the deleted row was the anchor', async () => {
    const { onAnchorChange } = mount({ anchorId: 's1' });
    await screen.findByText('급등주');
    fireEvent.click(within(rowOf('급등주')).getByRole('button', { name: '삭제' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '삭제' }));
    await waitFor(() => expect(onAnchorChange).toHaveBeenCalledWith(null));
  });

  it('delete keeps the anchor when a different row is deleted', async () => {
    const { onAnchorChange } = mount({ anchorId: 's1' });
    await screen.findByText('눌림목');
    fireEvent.click(within(rowOf('눌림목')).getByRole('button', { name: '삭제' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '삭제' }));
    await waitFor(() => expect(api.deleteSave).toHaveBeenCalledWith('s2'));
    expect(onAnchorChange).not.toHaveBeenCalled();
  });
});
