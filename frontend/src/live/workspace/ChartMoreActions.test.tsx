import { expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { ChartMoreActions } from './ChartMoreActions';

function Draft() {
  const [value, setValue] = useState('');
  return <input aria-label="저장 이름" value={value} onChange={(event) => setValue(event.target.value)} />;
}

it('keeps secondary state alive across Escape dismissal and restores focus to its trigger', async () => {
  const user = userEvent.setup();
  render(<ChartMoreActions><Draft /></ChartMoreActions>);
  const trigger = screen.getByRole('button', { name: '차트 더보기' });
  expect(screen.queryByRole('dialog', { name: '차트 추가 기능' })).toBeNull();
  await user.click(trigger);
  await user.type(screen.getByRole('textbox', { name: '저장 이름' }), '복기');
  await user.keyboard('{Escape}');
  expect(trigger).toHaveFocus();
  await user.click(trigger);
  expect(screen.getByRole('textbox', { name: '저장 이름' })).toHaveValue('복기');
});
