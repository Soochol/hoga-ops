import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import RangeAdjustmentNotice from './RangeAdjustmentNotice';

describe('RangeAdjustmentNotice', () => {
  it('renders fromDate-skip message when first segment date > requested fromDate', () => {
    render(
      <RangeAdjustmentNotice
        requestedFrom="20260501"
        requestedTo="20260530"
        actualFirst="20260503"
        actualLast="20260530"
        onAdjust={() => {}}
        onDismiss={() => {}}
      />,
    );
    expect(screen.getByText(/5\/1.*아직 캡처/)).toBeInTheDocument();
  });

  it('renders toDate-skip message when last segment date < requested toDate', () => {
    render(
      <RangeAdjustmentNotice
        requestedFrom="20260501"
        requestedTo="20260530"
        actualFirst="20260501"
        actualLast="20260525"
        onAdjust={() => {}}
        onDismiss={() => {}}
      />,
    );
    expect(screen.getByText(/5\/30.*아직 캡처/)).toBeInTheDocument();
  });

  it('renders nothing when requested matches actual', () => {
    const { container } = render(
      <RangeAdjustmentNotice
        requestedFrom="20260501"
        requestedTo="20260530"
        actualFirst="20260501"
        actualLast="20260530"
        onAdjust={() => {}}
        onDismiss={() => {}}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('calls onDismiss when close button clicked', () => {
    const onDismiss = vi.fn();
    render(
      <RangeAdjustmentNotice
        requestedFrom="20260501"
        requestedTo="20260530"
        actualFirst="20260503"
        actualLast="20260530"
        onAdjust={() => {}}
        onDismiss={onDismiss}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Dismiss/ }));
    expect(onDismiss).toHaveBeenCalled();
  });

  it('calls onAdjust when "실제 범위로 조정" button clicked', () => {
    const onAdjust = vi.fn();
    render(
      <RangeAdjustmentNotice
        requestedFrom="20260501"
        requestedTo="20260530"
        actualFirst="20260503"
        actualLast="20260530"
        onAdjust={onAdjust}
        onDismiss={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /실제 범위로 조정/ }));
    expect(onAdjust).toHaveBeenCalled();
  });
});
