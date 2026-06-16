import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { StudyViewSaveDialog } from './StudyViewSaveDialog';

it('shows snapshot summary and submits edited name and memo', async () => {
  const onSubmit = vi.fn();
  render(
    <StudyViewSaveDialog
      mode="create"
      defaultName="삼성전자 5분봉 2026.06.16"
      defaultMemo=""
      barCount={220}
      sizeBytes={12000}
      onCancel={() => {}}
      onSubmit={onSubmit}
    />,
  );
  expect(screen.getByText(/220개 봉/)).toBeTruthy();
  await userEvent.clear(screen.getByLabelText('이름'));
  await userEvent.type(screen.getByLabelText('이름'), ' 내 저장뷰 ');
  await userEvent.type(screen.getByLabelText('메모'), ' 중요 ');
  await userEvent.click(screen.getByRole('button', { name: '저장' }));
  expect(onSubmit).toHaveBeenCalledWith({ name: '내 저장뷰', memo: '중요' });
});

it('requires confirmation wording for overwrite mode', () => {
  const onSubmit = vi.fn();
  render(
    <StudyViewSaveDialog
      mode="overwrite"
      defaultName="기존"
      defaultMemo=""
      barCount={200}
      sizeBytes={1}
      onCancel={() => {}}
      onSubmit={onSubmit}
    />,
  );
  expect(screen.getByRole('heading', { name: '덮어쓰기' })).toBeTruthy();
  expect(screen.getByText(/기존 저장뷰를 현재 차트 스냅샷/)).toBeTruthy();
});
