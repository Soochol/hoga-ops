import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CaptureQueueRow } from './CaptureQueueRow';
import { useInventoryRecaptureOrigins } from '../inventory/useInventoryRecaptureOrigins';
import type { QueueItem } from '../api/types';

const base: QueueItem = {
  item_id: 'i1', code: '005930', date: '20260518',
  phase: 'queued', force_retry: false, pause_origin: false,
  enqueued_at_ms: 1, started_at_ms: null,
  progress: null, result: null, error: null, skip_reason: null,
  attempt: 1,
};

describe('CaptureQueueRow', () => {
  it('renders date / name / phase chip (code is in aria-label, not a column)', () => {
    const { container } = render(<CaptureQueueRow item={base} symbolName="삼성전자" onCancel={() => {}} onRetry={() => {}} />);
    expect(screen.getByText('20260518')).toBeTruthy();
    expect(screen.getByText(/queued/i)).toBeTruthy();
    expect(screen.getByText('삼성전자')).toBeTruthy();
    // 종목코드 칼럼은 제거됐지만 스크린리더용 aria-label 에는 남아 있다.
    expect(container.querySelector('[data-testid="queue-row-i1"]')!.getAttribute('aria-label'))
      .toContain('005930');
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

describe('CaptureQueueRow attempt badge (ADR-0031)', () => {
  it('hides the attempt badge when attempt === 1', () => {
    render(<CaptureQueueRow item={{ ...base, attempt: 1 }} symbolName="삼성전자"
                           onCancel={() => {}} onRetry={() => {}} />);
    expect(screen.queryByTitle(/Attempt/i)).toBeNull();
  });

  it('renders ×N badge when attempt > 1', () => {
    render(<CaptureQueueRow item={{ ...base, attempt: 3 }} symbolName="삼성전자"
                           onCancel={() => {}} onRetry={() => {}} />);
    const badge = screen.getByTitle(/Attempt 3/i);
    expect(badge).toBeTruthy();
    expect(badge.textContent).toBe('×3');
  });

  it('renders both ⚠ force and ×N badges together when both apply', () => {
    render(<CaptureQueueRow item={{ ...base, force_retry: true, attempt: 2 }}
                           symbolName="삼성전자"
                           onCancel={() => {}} onRetry={() => {}} />);
    expect(screen.getByTitle(/force re-capture/i)).toBeTruthy();
    expect(screen.getByTitle(/Attempt 2/i)).toBeTruthy();
  });
});

const baseItem: QueueItem = {
  item_id: 'item-1',
  code: '005930',
  date: '20260520',
  phase: 'queued',
  force_retry: false,
  pause_origin: false,
  enqueued_at_ms: 0,
  started_at_ms: null,
  progress: null,
  result: null,
  error: null,
  skip_reason: null,
  attempt: 1,
};

beforeEach(() => {
  useInventoryRecaptureOrigins.getState().clear();
});

afterEach(() => { vi.restoreAllMocks(); });

describe('CaptureQueueRow — inventory badge', () => {
  it('renders the "inventory" badge when item_id is in the origins store', () => {
    useInventoryRecaptureOrigins.getState().add(['item-1']);
    render(
      <CaptureQueueRow
        item={baseItem}
        symbolName="삼성전자"
        onCancel={() => {}}
        onRetry={() => {}}
      />,
    );
    expect(screen.getByTitle(/Triggered from inventory re-capture/i)).toBeTruthy();
    expect(screen.getByText('inventory')).toBeTruthy();
  });

  it('does not render the badge when item_id is NOT in the store', () => {
    render(
      <CaptureQueueRow
        item={baseItem}
        symbolName="삼성전자"
        onCancel={() => {}}
        onRetry={() => {}}
      />,
    );
    expect(screen.queryByText('inventory')).toBeNull();
  });
});

describe('CaptureQueueRow — Full Capture Count cell', () => {
  it('renders "—" when fullCaptureCount is undefined (first-ever capture)', () => {
    render(
      <CaptureQueueRow
        item={baseItem}
        symbolName="삼성전자"
        onCancel={() => {}}
        onRetry={() => {}}
      />,
    );
    const cell = screen.getByTestId('queue-row-full-capture-count');
    expect(cell.textContent).toBe('—');
  });

  it('renders faint "×1" when fullCaptureCount is null (legacy meta)', () => {
    render(
      <CaptureQueueRow
        item={baseItem}
        symbolName="삼성전자"
        fullCaptureCount={null}
        onCancel={() => {}}
        onRetry={() => {}}
      />,
    );
    const cell = screen.getByTestId('queue-row-full-capture-count');
    expect(cell.textContent).toBe('×1');
    expect(cell.querySelector('span')?.getAttribute('title')).toBe(
      'Full Capture 횟수 미기록 (≥1로 간주)',
    );
  });

  it('renders "×1" with honest tooltip when fullCaptureCount is exactly 1', () => {
    render(
      <CaptureQueueRow
        item={baseItem}
        symbolName="삼성전자"
        fullCaptureCount={1}
        onCancel={() => {}}
        onRetry={() => {}}
      />,
    );
    const cell = screen.getByTestId('queue-row-full-capture-count');
    expect(cell.textContent).toBe('×1');
    expect(cell.querySelector('span')?.getAttribute('title')).toBe(
      'Full Capture 누적 1회',
    );
  });

  it('renders "×3" with standard tone when fullCaptureCount is 3', () => {
    render(
      <CaptureQueueRow
        item={baseItem}
        symbolName="삼성전자"
        fullCaptureCount={3}
        onCancel={() => {}}
        onRetry={() => {}}
      />,
    );
    const cell = screen.getByTestId('queue-row-full-capture-count');
    expect(cell.textContent).toBe('×3');
    expect(cell.querySelector('span')?.getAttribute('title')).toBe(
      'Full Capture 누적 3회',
    );
  });
});
