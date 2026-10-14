import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StudyGroupPicker } from './StudyGroupPicker';
import type { StudyGroupChoice } from './StudyGroupPickerHelpers';
import { ModalShell } from '../ui/ModalShell';

const groups = [{ id: 'one', name: '돌파 복기' }, { id: 'two', name: '매물대 복기' }];
function Picker() {
  const [value, setValue] = useState<StudyGroupChoice>({});
  return <StudyGroupPicker groups={groups} value={value} onChange={setValue} />;
}

describe('searchable save group', () => {
  it('filters and picks a group by keyboard without submitting the save form', async () => {
    const user = userEvent.setup();
    const submit = vi.fn(event => event.preventDefault());
    render(<form onSubmit={submit}><Picker /></form>);
    const input = screen.getByRole('combobox', { name: '저장 그룹' });
    await user.click(input);
    await user.type(input, '매물');
    expect(screen.queryByRole('option', { name: '돌파 복기' })).not.toBeInTheDocument();
    await user.keyboard('{Enter}');
    expect(input).toHaveValue('매물대 복기');
    expect(input).toHaveAttribute('aria-expanded', 'false');
    expect(submit).not.toHaveBeenCalled();
  });

  it('Escape closes the group list before dismissing the surrounding modal', async () => {
    const user = userEvent.setup();
    const close = vi.fn();
    render(<ModalShell ariaLabel="저장" onClose={close}><Picker /></ModalShell>);
    await user.click(screen.getByRole('combobox', { name: '저장 그룹' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(close).not.toHaveBeenCalled();
    await user.keyboard('{Escape}');
    expect(close).toHaveBeenCalledOnce();
  });
});
