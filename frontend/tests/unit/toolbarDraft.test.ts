import { describe, it, expect, beforeEach } from 'vitest';
import { useToolbarDraftStore } from '../../src/state/toolbarDraft';

describe('toolbarDraftStore', () => {
  beforeEach(() => {
    useToolbarDraftStore.getState().reset();
  });

  it('starts empty for a fresh tab', () => {
    const d = useToolbarDraftStore.getState().getDraft('tab-1');
    expect(d).toEqual({ code: null, from: null, to: null, timeframe: '1m' });
  });

  it('setDraft persists per tab id', () => {
    useToolbarDraftStore.getState().setDraft('tab-1', { code: '003490', from: null, to: null });
    useToolbarDraftStore.getState().setDraft('tab-2', { code: '005930', from: '20260520', to: '20260520' });
    expect(useToolbarDraftStore.getState().getDraft('tab-1')).toEqual({
      code: '003490',
      from: null,
      to: null,
      timeframe: '1m',
    });
    expect(useToolbarDraftStore.getState().getDraft('tab-2')).toEqual({
      code: '005930',
      from: '20260520',
      to: '20260520',
      timeframe: '1m',
    });
  });

  it('setStock clears dates (mirrors Toolbar UX)', () => {
    useToolbarDraftStore
      .getState()
      .setDraft('tab-1', { code: '003490', from: '20260511', to: '20260511' });
    useToolbarDraftStore.getState().setStock('tab-1', '005930');
    expect(useToolbarDraftStore.getState().getDraft('tab-1')).toEqual({
      code: '005930',
      from: null,
      to: null,
      timeframe: '1m',
    });
  });

  it('clearTab removes the draft', () => {
    useToolbarDraftStore.getState().setDraft('tab-1', { code: '003490', from: null, to: null });
    useToolbarDraftStore.getState().clearTab('tab-1');
    expect(useToolbarDraftStore.getState().getDraft('tab-1')).toEqual({
      code: null,
      from: null,
      to: null,
      timeframe: '1m',
    });
  });
});
