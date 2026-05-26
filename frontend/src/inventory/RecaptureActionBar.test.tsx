import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { RecaptureActionBar } from './RecaptureActionBar';
import { RECAPTURABLE_DISK_STATES } from './DiskStateBadge';

const baseProps = {
  recapturableCount: 3,
  onRecaptureAll: () => {},
  status: null,
  isPending: false,
};

describe('RecaptureActionBar', () => {
  it('renders nothing when count is 0 and no status', () => {
    const { container } = render(
      <RecaptureActionBar {...baseProps} recapturableCount={0} status={null} />,
    );
    expect(container.textContent).toBe('');
  });

  it('shows "Re-capture all incomplete (N)" with refresh icon when count > 0', () => {
    render(<RecaptureActionBar {...baseProps} recapturableCount={3} />);
    expect(screen.getByRole('button', { name: /Re-capture all incomplete \(3\)/i })).toBeTruthy();
  });

  it('button tooltip is derived from RECAPTURABLE_DISK_STATES (no hardcoded string)', () => {
    render(<RecaptureActionBar {...baseProps} recapturableCount={3} />);
    const btn = screen.getByRole('button', { name: /Re-capture all incomplete/i });
    const expected = RECAPTURABLE_DISK_STATES.map((s) => s.replace(/_/g, ' ')).join(' · ');
    expect(btn.getAttribute('title')).toBe(expected);
  });

  it('clicking the button calls onRecaptureAll', () => {
    const onAll = vi.fn();
    render(<RecaptureActionBar {...baseProps} onRecaptureAll={onAll} />);
    fireEvent.click(screen.getByRole('button', { name: /Re-capture all incomplete/i }));
    expect(onAll).toHaveBeenCalledTimes(1);
  });

  it('button is disabled while isPending', () => {
    render(<RecaptureActionBar {...baseProps} isPending={true} />);
    const btn = screen.getByRole('button', { name: /Re-capture all incomplete/i }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('renders success status when present', () => {
    render(
      <RecaptureActionBar
        {...baseProps}
        status={{ kind: 'success', enqueued: 2, skipped: 1 }}
      />,
    );
    expect(screen.getByText(/Queued 2 capture/)).toBeTruthy();
    expect(screen.getByText(/1 skipped/)).toBeTruthy();
  });

  it('renders error status with role=alert', () => {
    render(
      <RecaptureActionBar
        {...baseProps}
        status={{ kind: 'error', message: 'something broke' }}
      />,
    );
    expect(screen.getByRole('alert').textContent).toContain('something broke');
  });

  it('renders ONLY status when count is 0 but status is present', () => {
    render(
      <RecaptureActionBar
        {...baseProps}
        recapturableCount={0}
        status={{ kind: 'success', enqueued: 1, skipped: 0 }}
      />,
    );
    // button is gone, but the status is rendered.
    expect(screen.queryByRole('button', { name: /Re-capture all incomplete/i })).toBeNull();
    expect(screen.getByText(/Queued 1 capture/)).toBeTruthy();
  });
});
