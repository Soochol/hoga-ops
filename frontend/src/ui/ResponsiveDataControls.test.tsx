import { fireEvent, render, screen, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { ResponsiveDataControls } from './ResponsiveDataControls';

it('keeps secondary controls usable in a portal and restores focus on Escape', () => {
  const onChange = vi.fn();
  render(<ResponsiveDataControls secondary={<button onClick={onChange}>단위 변경</button>}>
    <button>20일</button>
  </ResponsiveDataControls>);
  const trigger = screen.getByRole('button', { name: '표시 설정' });
  fireEvent.click(trigger);
  const dialog = screen.getByRole('dialog', { name: '표시 설정' });
  fireEvent.click(within(dialog).getByRole('button', { name: '단위 변경' }));
  expect(onChange).toHaveBeenCalledOnce();
  fireEvent.keyDown(dialog, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
});

it('keeps query status visible independently of the collapsed settings', () => {
  render(<ResponsiveDataControls status="조회 지연" secondary={<button>수량</button>}><button>20일</button></ResponsiveDataControls>);
  expect(screen.getByRole('status')).toHaveTextContent('조회 지연');
});
