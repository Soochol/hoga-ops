import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { expect, it } from 'vitest';
import LandingPage from './LandingPage';

it('links to the workspace and switches the example with keyboard navigation', () => {
  render(<MemoryRouter><LandingPage /></MemoryRouter>);
  expect(screen.getByRole('link', { name: /라이브 시작하기/ })).toHaveAttribute('href', '/live');
  const observe = screen.getByRole('tab', { name: '01 관찰' });
  fireEvent.keyDown(observe, { key: 'ArrowRight' });
  expect(screen.getByRole('tab', { name: '02 기록' })).toHaveFocus();
  expect(screen.getByRole('tabpanel')).toHaveTextContent('종목뷰에 기간 저장');
  fireEvent.click(screen.getByRole('tab', { name: '03 복기' }));
  expect(screen.getByRole('tabpanel')).toHaveTextContent('같은 종목, 서로 다른 구간');
});
