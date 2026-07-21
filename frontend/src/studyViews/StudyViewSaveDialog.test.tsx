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
  // capture 는 수집 체크박스 상태 — coverage 를 안 넘긴 이 다이얼로그에선 UI 가
  // 없지만 기본값(true)이 그대로 실린다. 호출측이 missing 이 비면 무시한다.
  expect(onSubmit).toHaveBeenCalledWith({ name: '내 저장뷰', memo: '중요', capture: true });
});

it('renders in a body portal so workspace layers cannot cover it', () => {
  render(
    <StudyViewSaveDialog
      mode="create"
      defaultName="삼성전자 5분봉 2026.06.16"
      defaultMemo=""
      barCount={220}
      sizeBytes={12000}
      onCancel={() => {}}
      onSubmit={() => {}}
    />,
  );

  expect(screen.getByRole('dialog', { name: '저장뷰 만들기' }).parentElement).toBe(document.body);
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
  expect(screen.getByText(/기존 저장뷰를 현재 복기 구간/)).toBeTruthy();
});

it('shows save progress and backend errors', () => {
  render(
    <StudyViewSaveDialog
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
