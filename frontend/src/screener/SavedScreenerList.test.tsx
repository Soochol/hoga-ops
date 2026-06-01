import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SavedScreenerList } from './SavedScreenerList';

// Saved screener with its OWN conditions/universe, deliberately DISTINCT from
// the live-builder state the tests pass in — so a rename that wrongly forwarded
// the builder (the ✎ data-loss bug) is unambiguously visible.
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

// Live builder state — distinct from the saved screener above.
const BUILDER = {
  conditions: [{ id: 'b', type: 'trade_value', params: { min_eok: 99 } }] as ConditionLeaf[],
  universe: { exclude_etf: true },
};
const FILL = 'bg-[rgba(20,184,166,0.14)]';            // teal fill = exact match
const BAR = 'shadow-[inset_2px_0_0_var(--accent)]';   // anchor bar

type Props = React.ComponentProps<typeof SavedScreenerList>;
const mount = (over: Partial<Props> = {}) => {
  const props: Props = {
    current: { conditions: [], universe: {} },
    anchorId: null, dirty: false, onLoad: vi.fn(), onBeginSave: vi.fn(), onAnchorChange: vi.fn(),
    ...over,
  };
  render(<QueryClientProvider client={new QueryClient()}><SavedScreenerList {...props} /></QueryClientProvider>);
  return props;
};
const rowOf = (name: string) => screen.getByText(name).closest('[role="button"]') as HTMLElement;

beforeEach(() => vi.clearAllMocks());

describe('SavedScreenerList', () => {
  it('renders saved names and loads (no scan) on click', async () => {
    const { onLoad } = mount();
    fireEvent.click(await screen.findByText('급등주'));
    expect(onLoad).toHaveBeenCalledWith(expect.objectContaining({ id: 's1' }));
  });

  it('creates a new save with a name', async () => {
    mount();
    await screen.findByText('급등주');
    vi.spyOn(window, 'prompt').mockReturnValue('새이름');
    fireEvent.click(screen.getByRole('button', { name: '새로 저장' }));
    await waitFor(() => expect(api.createSave).toHaveBeenCalledWith(expect.objectContaining({ name: '새이름' })));
  });

  it('re-anchors to the newly created save (auto-highlight), signalling save-start first', async () => {
    const { onAnchorChange, onBeginSave } = mount({ current: BUILDER });
    await screen.findByText('급등주');
    vi.spyOn(window, 'prompt').mockReturnValue('새이름');
    fireEvent.click(screen.getByRole('button', { name: '새로 저장' }));
    // onBeginSave must fire synchronously at dispatch so the parent can snapshot
    // the edit generation (the guard against the in-flight-edit false-clean).
    expect(onBeginSave).toHaveBeenCalled();
    await waitFor(() => expect(onAnchorChange).toHaveBeenCalledWith('s-new'));
  });

  it('rename changes ONLY the name, keeps the save\'s own conditions/universe, and does NOT re-anchor', async () => {
    // Regression for the ✎ data-loss bug: PUT is full-replace, so rename must
    // carry the SAVED screener's conditions, never the (unrelated) builder state.
    const { onAnchorChange } = mount({ current: BUILDER });
    await screen.findByText('급등주');
    vi.spyOn(window, 'prompt').mockReturnValue('새이름');
    fireEvent.click(within(rowOf('급등주')).getByRole('button', { name: '이름변경' }));
    await waitFor(() => expect(api.updateSave).toHaveBeenCalled());
    const [id, body] = vi.mocked(api.updateSave).mock.calls[0];
    expect(id).toBe('s1');
    expect(body.name).toBe('새이름');
    expect(body.conditions).toEqual(SAVED_CONDS);        // save's own, NOT BUILDER.conditions
    expect(body.universe).toEqual(SAVED_UNIVERSE);        // save's own, NOT BUILDER.universe
    expect(onAnchorChange).not.toHaveBeenCalled();        // rename leaves the anchor alone
  });

  it('overwrite saves the live builder onto the save, keeps its name, re-anchors, after a target-naming confirm', async () => {
    const { onAnchorChange, onBeginSave } = mount({ current: BUILDER });
    await screen.findByText('급등주');
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(within(rowOf('급등주')).getByRole('button', { name: '현재 조건으로 덮어쓰기' }));
    expect(onBeginSave).toHaveBeenCalled();
    await waitFor(() => expect(api.updateSave).toHaveBeenCalled());
    // Load-bearing safety: the confirm MUST name the target save, else "load A →
    // 덮어쓰기 on B" silently clobbers the wrong screener (C1 round two).
    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining('급등주'));
    const [id, body] = vi.mocked(api.updateSave).mock.calls[0];
    expect(id).toBe('s1');
    expect(body.name).toBe('급등주');                     // keeps the save's name
    expect(body.conditions).toEqual(BUILDER.conditions);  // intentional: live builder
    expect(body.universe).toEqual(BUILDER.universe);
    await waitFor(() => expect(onAnchorChange).toHaveBeenCalledWith('s1'));  // builder now matches → clean
  });

  it('overwrite does nothing when the confirm is dismissed', async () => {
    const { onAnchorChange, onBeginSave } = mount({ current: BUILDER });
    await screen.findByText('급등주');
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    fireEvent.click(within(rowOf('급등주')).getByRole('button', { name: '현재 조건으로 덮어쓰기' }));
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
    expect(rowOf('급등주').className).not.toContain(FILL);   // no false "exact match" fill
    expect(rowOf('급등주').className).toContain(BAR);          // still anchored
  });

  it('delete clears the anchor when the deleted row was the anchor', async () => {
    const { onAnchorChange } = mount({ anchorId: 's1' });
    await screen.findByText('급등주');
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(within(rowOf('급등주')).getByRole('button', { name: '삭제' }));
    await waitFor(() => expect(onAnchorChange).toHaveBeenCalledWith(null));
  });

  it('delete keeps the anchor when a different row is deleted', async () => {
    const { onAnchorChange } = mount({ anchorId: 's1' });
    await screen.findByText('눌림목');
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(within(rowOf('눌림목')).getByRole('button', { name: '삭제' }));
    await waitFor(() => expect(api.deleteSave).toHaveBeenCalledWith('s2'));
    expect(onAnchorChange).not.toHaveBeenCalled();
  });
});
