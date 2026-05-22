import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CaptureQueueRow, statusIcon, phaseChipColor } from './CaptureQueueRow';
import type { QueueItem } from '../api/types';

const base: QueueItem = {
  item_id: 'i1', code: '005930', date: '20260518',
  phase: 'queued', force_retry: false, pause_origin: false,
  enqueued_at_ms: 1, started_at_ms: null,
  progress: null, result: null, error: null, skip_reason: null,
};

describe('statusIcon', () => {
  it('maps phases to glyphs', () => {
    expect(statusIcon('done')).toBe('✓');
    expect(statusIcon('failed')).toBe('✕');
    expect(statusIcon('cancelled')).toBe('✕');
    expect(statusIcon('skipped')).toBe('⚠');
    expect(statusIcon('capturing')).toBe('●');
    expect(statusIcon('queued')).toBe('○');
  });
});

describe('phaseChipColor', () => {
  it('teal tint for in-progress', () => {
    expect(phaseChipColor('capturing')).toContain('20,184,166');
  });
  it('up tint for done', () => {
    expect(phaseChipColor('done')).toContain('34,197,94');
  });
  it('down tint for failed', () => {
    expect(phaseChipColor('failed')).toContain('244,63,94');
  });
});

describe('CaptureQueueRow', () => {
  it('renders date / code / phase chip', () => {
    render(<CaptureQueueRow item={base} symbolName="삼성전자" onCancel={() => {}} onRetry={() => {}} />);
    expect(screen.getByText('20260518')).toBeTruthy();
    expect(screen.getByText('005930')).toBeTruthy();
    expect(screen.getByText(/queued/i)).toBeTruthy();
    expect(screen.getByText('삼성전자')).toBeTruthy();
  });

  it('Q16: shows ⚠ force chip when force_retry=true', () => {
    render(<CaptureQueueRow item={{ ...base, force_retry: true }} symbolName="삼성전자" onCancel={() => {}} onRetry={() => {}} />);
    expect(screen.getByTitle(/force re-capture/i)).toBeTruthy();
  });

  it('queued row action button is ✕ remove (calls onCancel)', () => {
    const onCancel = vi.fn();
    render(<CaptureQueueRow item={base} symbolName="삼성전자" onCancel={onCancel} onRetry={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /cancel|remove|✕/i }));
    expect(onCancel).toHaveBeenCalledWith('i1');
  });

  it('failed row shows ↻ retry button (calls onRetry)', () => {
    const onRetry = vi.fn();
    render(<CaptureQueueRow item={{ ...base, phase: 'failed' }} symbolName="삼성전자" onCancel={() => {}} onRetry={onRetry} />);
    fireEvent.click(screen.getByRole('button', { name: /retry|↻/i }));
    expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({ item_id: 'i1' }));
  });

  it('done / skipped rows show no action button', () => {
    const { rerender } = render(<CaptureQueueRow item={{ ...base, phase: 'done' }} symbolName="삼성전자" onCancel={() => {}} onRetry={() => {}} />);
    expect(screen.queryByRole('button', { name: /cancel|retry/i })).toBeNull();
    rerender(<CaptureQueueRow item={{ ...base, phase: 'skipped' }} symbolName="삼성전자" onCancel={() => {}} onRetry={() => {}} />);
    expect(screen.queryByRole('button', { name: /cancel|retry/i })).toBeNull();
  });

  it('clicking the row toggles a `data-expanded` flag', () => {
    const { container } = render(<CaptureQueueRow item={base} symbolName="삼성전자" onCancel={() => {}} onRetry={() => {}} />);
    const row = container.querySelector('[data-testid="queue-row-i1"]')!;
    expect(row.getAttribute('data-expanded')).toBe('false');
    fireEvent.click(row);
    expect(row.getAttribute('data-expanded')).toBe('true');
  });

  it('keyboard Enter expands the row; aria-expanded reflects state', () => {
    const { container } = render(<CaptureQueueRow item={base} symbolName="삼성전자" onCancel={() => {}} onRetry={() => {}} />);
    const row = container.querySelector('[data-testid="queue-row-i1"]')!;
    expect(row.getAttribute('role')).toBe('button');
    expect(row.getAttribute('tabIndex') ?? row.getAttribute('tabindex')).toBe('0');
    expect(row.getAttribute('aria-expanded')).toBe('false');
    fireEvent.keyDown(row, { key: 'Enter' });
    expect(row.getAttribute('aria-expanded')).toBe('true');
    fireEvent.keyDown(row, { key: ' ' });
    expect(row.getAttribute('aria-expanded')).toBe('false');
  });
});
