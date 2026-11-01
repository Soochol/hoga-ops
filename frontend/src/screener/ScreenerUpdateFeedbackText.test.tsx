import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { ScreenerUpdateFeedbackText } from './ScreenerUpdateFeedbackText';

it('shows the original completion date in KST even after midnight or reconnect', () => {
  const atMs = Date.parse('2026-10-31T15:33:59Z');
  render(<ScreenerUpdateFeedbackText feedback={{ source: 'update', tone: 'warn', atMs,
    message: '서버 종료로 갱신 중단' }} />);
  expect(screen.getByText('2026-11-01 00:33')).toHaveAttribute('datetime', '2026-10-31T15:33:59.000Z');
  expect(document.body).toHaveTextContent('지난 갱신 2026-11-01 00:33 · 서버 종료로 갱신 중단');
});
