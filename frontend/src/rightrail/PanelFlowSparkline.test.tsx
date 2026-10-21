import { render, screen, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { PanelGroupSparkline, PanelStockSparkline } from './PanelFlowSparkline';
import { QuoteRow } from './QuoteRow';
import type { PanelStockFlow } from '../api/panelFlow';

afterEach(cleanup);
const flow: PanelStockFlow = { code: '005930', venue: 'KRX', pct: [1, null, -2, null, null], last_observed_ms: 1792530060000, missing_reason: null };

describe('panel flow glyph', () => {
  it('keeps full-day positions, breaks gaps, and leaves future space', () => {
    const { container } = render(<PanelStockSparkline flow={flow} name="삼성전자" />);
    const path = container.querySelector('path[fill="none"]')!;
    const d = path.getAttribute('d')!;
    expect(d.match(/M/g)).toHaveLength(2);
    expect(d).not.toContain('L');
    expect(d).toContain('M32.00'); // Third of five buckets is the middle, not the right edge.
    expect(container.querySelectorAll('circle')).toHaveLength(2);
    expect(container.querySelector('svg')).toHaveClass('text-price-down');
    expect(screen.getByRole('img')).toHaveAccessibleName(/삼성전자 당일 흐름.*마지막 관측/);
  });

  it('reports missing data and sample coverage without synthesizing a flat line', () => {
    render(<PanelStockSparkline flow={null} name="삼성전자" />);
    expect(screen.getByText('—')).toBeVisible();
    expect(document.querySelector('path')).toBeNull();
    cleanup();
    render(<PanelGroupSparkline name="반도체" flow={{ folder_id: 'f1', total: 4, pct: [2, null, 3, null], counts: [4, 0, 2, 0] }} />);
    expect(screen.getByRole('img')).toHaveAccessibleName(/평균 반영 2\/4종목/);
  });

  it('adds flow alongside prices only for the opted-in panels and retains click/keyboard row semantics', () => {
    const props = { name: '삼성전자', price: 72000, pct: 2, changeWon: 1000, active: false, ariaLabel: '삼성전자 차트 열기', testId: 'row', onClick: () => {} };
    const { rerender } = render(<ul><QuoteRow {...props} /></ul>);
    expect(screen.getByText('72,000')).toBeVisible();
    rerender(<ul><QuoteRow {...props} flow={flow} /></ul>);
    expect(screen.getByText('72,000')).toBeVisible();
    expect(screen.getByRole('button')).toHaveAttribute('tabindex', '0');
    expect(screen.getByText('+2.00%')).toBeVisible();
    expect(screen.getByRole('img')).toBeVisible();
  });
});
