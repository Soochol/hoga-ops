import { render, screen } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';
import OnboardingCard from '../../src/replay/OnboardingCard';
import { useToolbarDraftStore } from '../../src/state/toolbarDraft';

const baseTab: any = {
  id: 'tab-1',
  selection: null,
  cursorMs: null,
  status: 'empty',
  bundles: new Map(),
};

describe('OnboardingCard', () => {
  beforeEach(() => {
    useToolbarDraftStore.getState().reset();
  });

  it('highlights step 1 (종목 선택) when draft is empty', () => {
    render(<OnboardingCard tab={baseTab} />);
    // Step 1 has the active style; step 2 and 3 are dim/inactive
    const step1 = screen.getByText('종목 선택');
    expect(step1.className).toMatch(/font-medium/);
  });

  it('ticks step 1 and highlights step 2 once a stock is in draft', () => {
    useToolbarDraftStore
      .getState()
      .setDraft('tab-1', { code: '003490', from: null, to: null });
    render(<OnboardingCard tab={baseTab} />);
    // Step 1 should show ✓
    expect(screen.getByText('✓', { selector: 'span' })).toBeInTheDocument();
    const step2 = screen.getByText('기간 선택');
    expect(step2.className).toMatch(/font-medium/);
  });

  it('ticks steps 1+2 and highlights step 3 once dates are in draft', () => {
    useToolbarDraftStore
      .getState()
      .setDraft('tab-1', { code: '003490', from: '20260511', to: '20260511' });
    render(<OnboardingCard tab={baseTab} />);
    const checkmarks = screen.getAllByText('✓');
    expect(checkmarks).toHaveLength(2); // 두 단계 완료
    const step3 = screen.getByText('데이터 불러오기');
    expect(step3.className).toMatch(/font-medium/);
  });
});
