import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { StudyViewSaveDialog } from './StudyViewSaveDialog';

it('shows snapshot summary and submits edited name and memo', async () => {
  const onSubmit = vi.fn();
  render(
    <StudyViewSaveDialog groups={[{ id: 'g', name: '복기' }]} initialGroupId="g"
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
  // capture 는 수집 체크박스 상태 — coverage 를 안 넘긴 이 다이얼로그에선 UI 가
  // 없지만 기본값(true)이 그대로 실린다. 호출측이 missing 이 비면 무시한다.
  expect(onSubmit).toHaveBeenCalledWith({ name: '내 저장뷰', memo: '중요', capture: true, group_id: 'g' });
});

it('renders in a body portal so workspace layers cannot cover it', () => {
  render(
    <StudyViewSaveDialog groups={[{ id: 'g', name: '복기' }]} initialGroupId="g"
      mode="create"
      defaultName="삼성전자 5분봉 2026.06.16"
      defaultMemo=""
      barCount={220}
      sizeBytes={12000}
      onCancel={() => {}}
      onSubmit={() => {}}
    />,
  );

  expect(screen.getByRole('dialog', { name: '저장뷰 저장' }).parentElement).toBe(document.body);
});

it('requires confirmation wording for overwrite mode', () => {
  const onSubmit = vi.fn();
  render(
    <StudyViewSaveDialog groups={[{ id: 'g', name: '복기' }]} initialGroupId="g"
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
  expect(screen.getByText(/기존 저장뷰를 현재 복기 구간/)).toBeTruthy();
});

it('shows save progress and backend errors', () => {
  render(
    <StudyViewSaveDialog groups={[{ id: 'g', name: '복기' }]} initialGroupId="g"
      mode="create"
      defaultName="삼성전자 5분봉 2026.06.16"
      defaultMemo=""
      barCount={220}
      sizeBytes={12000}
      isSubmitting
      errorMessage="저장 요청이 실패했습니다."
      onCancel={() => {}}
      onSubmit={() => {}}
    />,
  );

  expect(screen.getByRole('button', { name: '저장 중...' })).toBeDisabled();
  expect(screen.getByText('저장 요청이 실패했습니다.')).toBeTruthy();
});

it('creates a first group and defaults the name from the saved period', async () => {
  const submit = vi.fn();
  render(<StudyViewSaveDialog groups={[]} mode="create" defaultName="" defaultMemo="" subjectLabel="삼성전자 · 1분봉" rangeLabel="2026-09-10 09:00–10:30 KST" onCancel={vi.fn()} onSubmit={submit} />);
  expect(screen.getByRole('button', { name: '그룹 만들고 저장' })).toBeDisabled();
  await userEvent.type(screen.getByLabelText('새 그룹 이름'), ' 돌파 복기 ');
  await userEvent.click(screen.getByRole('button', { name: '그룹 만들고 저장' }));
  expect(submit).toHaveBeenCalledWith({ new_group_name: '돌파 복기', name: '삼성전자 · 1분봉 · 2026-09-10 09:00–10:30 KST', memo: '', capture: true });
});

it('keeps input on errors and requires choosing a valid group after deletion', async () => {
  const submit = vi.fn();
  const props = { mode: 'create' as const, defaultName: '돌파', defaultMemo: '메모', onCancel: vi.fn(), onSubmit: submit, initialGroupId: 'g' };
  const { rerender } = render(<StudyViewSaveDialog {...props} groups={[{ id: 'g', name: '복기' }]} />);
  rerender(<StudyViewSaveDialog {...props} groups={[]} errorMessage="그룹이 삭제되었습니다" />);
  expect(screen.getByLabelText('이름')).toHaveValue('돌파');
  expect(screen.getByLabelText('메모')).toHaveValue('메모');
  expect(screen.getByRole('button', { name: '저장' })).toBeDisabled();
  await userEvent.click(screen.getByRole('button', { name: '+ 새 그룹' }));
  await userEvent.type(screen.getByLabelText('새 그룹 이름'), '새 복기');
  await userEvent.click(screen.getByRole('button', { name: '그룹 만들고 저장' }));
  expect(submit).toHaveBeenCalledWith(expect.objectContaining({ new_group_name: '새 복기', memo: '메모' }));
});

it('prevents duplicate group creation and permits switching back to the existing group', async () => {
  render(<StudyViewSaveDialog groups={[{ id: 'g', name: '복기' }]} mode="create" defaultName="" defaultMemo="" onCancel={vi.fn()} onSubmit={vi.fn()} />);
  await userEvent.click(screen.getByRole('button', { name: '+ 새 그룹' }));
  await userEvent.type(screen.getByLabelText('새 그룹 이름'), ' 복기 ');
  expect(screen.getByRole('alert')).toHaveTextContent('이미 있는 그룹');
  expect(screen.getByRole('button', { name: '그룹 만들고 저장' })).toBeDisabled();
  await userEvent.click(screen.getByRole('button', { name: '기존 그룹 선택' }));
  await userEvent.selectOptions(screen.getByLabelText('저장 그룹'), 'g');
  expect(screen.getByRole('button', { name: '저장' })).toBeEnabled();
});
