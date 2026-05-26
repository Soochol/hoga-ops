import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { RecaptureActionBar } from './RecaptureActionBar';

describe('RecaptureActionBar', () => {
  it('renders nothing when recapturableCount is 0', () => {
    const { container } = render(
      <RecaptureActionBar
        recapturableCount={0}
        selectedCount={0}
        onRecaptureSelected={() => {}}
        onRecaptureAll={() => {}}
        onClearSelection={() => {}}
        status={null}
        isPending={false}
      />,
    );
    expect(container.textContent).toBe('');
  });

  it('shows "Re-capture all incomplete (N)" when no selection but recapturable rows exist', () => {
    render(
      <RecaptureActionBar
        recapturableCount={3}
        selectedCount={0}
        onRecaptureSelected={() => {}}
        onRecaptureAll={() => {}}
        onClearSelection={() => {}}
        status={null}
        isPending={false}
      />,
    );
    expect(screen.getByRole('button', { name: /Re-capture all incomplete \(3\)/i })).toBeTruthy();
  });

  it('calls onRecaptureAll when "Re-capture all incomplete" clicked', () => {
    const onAll = vi.fn();
    render(
      <RecaptureActionBar
        recapturableCount={3}
        selectedCount={0}
        onRecaptureSelected={() => {}}
        onRecaptureAll={onAll}
        onClearSelection={() => {}}
        status={null}
        isPending={false}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Re-capture all incomplete/i }));
    expect(onAll).toHaveBeenCalledTimes(1);
  });

  it('shows selection mode "K selected · Re-capture · Clear" when selectedCount > 0', () => {
    render(
      <RecaptureActionBar
        recapturableCount={3}
        selectedCount={2}
        onRecaptureSelected={() => {}}
        onRecaptureAll={() => {}}
        onClearSelection={() => {}}
        status={null}
        isPending={false}
      />,
    );
    expect(screen.getByText(/2 selected/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /^.*Re-capture$/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Clear/i })).toBeTruthy();
  });

  it('calls onRecaptureSelected and onClearSelection from selection mode', () => {
    const onSel = vi.fn();
    const onClear = vi.fn();
    render(
      <RecaptureActionBar
        recapturableCount={3}
        selectedCount={2}
        onRecaptureSelected={onSel}
        onRecaptureAll={() => {}}
        onClearSelection={onClear}
        status={null}
        isPending={false}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /^.*Re-capture$/i }));
    expect(onSel).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: /Clear/i }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('disables the primary action while isPending is true', () => {
    render(
      <RecaptureActionBar
        recapturableCount={3}
        selectedCount={2}
        onRecaptureSelected={() => {}}
        onRecaptureAll={() => {}}
        onClearSelection={() => {}}
        status={null}
        isPending={true}
      />,
    );
    const btn = screen.getByRole('button', { name: /^.*Re-capture$/i }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('renders success status', () => {
    render(
      <RecaptureActionBar
        recapturableCount={3}
        selectedCount={0}
        onRecaptureSelected={() => {}}
        onRecaptureAll={() => {}}
        onClearSelection={() => {}}
        status={{ kind: 'success', enqueued: 2, skipped: 1 }}
        isPending={false}
      />,
    );
    expect(screen.getByText(/Queued 2 capture/)).toBeTruthy();
    expect(screen.getByText(/1 skipped/)).toBeTruthy();
  });

  it('renders error status', () => {
    render(
      <RecaptureActionBar
        recapturableCount={3}
        selectedCount={0}
        onRecaptureSelected={() => {}}
        onRecaptureAll={() => {}}
        onClearSelection={() => {}}
        status={{ kind: 'error', message: 'something broke' }}
        isPending={false}
      />,
    );
    expect(screen.getByRole('alert').textContent).toContain('something broke');
  });
});
