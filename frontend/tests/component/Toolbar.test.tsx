import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/api/stock-dates', () => ({
  useStockDates: () => ({
    data: [
      {
        date: '20260511',
        code: '003490',
        name: '대한항공',
        regular_session_open_ms: 1_778_457_600_000,
        regular_session_close_ms: 1_778_481_000_000,
      },
    ],
  }),
}));

import Toolbar from '../../src/replay/Toolbar';
import { useTabsStore } from '../../src/state/tabs';
import { useToolbarDraftStore } from '../../src/state/toolbarDraft';

describe('Toolbar', () => {
  beforeEach(() => {
    useTabsStore.getState().reset();
    useToolbarDraftStore.getState().reset();
  });

  it('writes stock selection to the draft store', () => {
    render(<Toolbar />);
    fireEvent.click(screen.getByRole('button', { name: /종목 선택/ }));
    fireEvent.click(screen.getByText('대한항공'));
    const activeId = useTabsStore.getState().activeTabId;
    expect(useToolbarDraftStore.getState().getDraft(activeId).code).toBe('003490');
  });
});
