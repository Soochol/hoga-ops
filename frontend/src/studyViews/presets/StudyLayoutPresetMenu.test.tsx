import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StudyLayoutPresetMenu } from './StudyLayoutPresetMenu';
import { useStudyActivePresetStore } from '../../state/studyActivePreset';
import type { StudyLayoutPreset } from '../../api/studyLayoutPresets';

const createMutate = vi.fn();
const updateMutate = vi.fn();
const removeMutate = vi.fn();
const refetchMock = vi.fn();
let mockedPresets: StudyLayoutPreset[] = [];

vi.mock('./useStudyLayoutPresets', () => ({
  useStudyLayoutPresets: () => ({
    data: { schema_version: 1, presets: mockedPresets },
    refetch: refetchMock,
  }),
  useStudyLayoutPresetMutations: () => ({
    create: { mutate: createMutate },
    update: { mutate: updateMutate },
    remove: { mutate: removeMutate },
  }),
}));

const applyMock = vi.fn();
vi.mock('./studyLayoutPresetSnapshot', () => ({
  applyStudyPresetPayload: (...args: unknown[]) => applyMock(...args),
  captureStudyPresetPayload: () => ({ windows: [{ id: 'w1' }], zOrder: ['w1'] }),
  defaultStudyPresetPayload: () => ({ windows: [], zOrder: [], _default: true }),
}));

const preset = (id: string, name: string): StudyLayoutPreset => ({
  schema_version: 1,
  id,
  name,
  payload: { windows: [], zOrder: [] },
  created_at_ms: 1,
  updated_at_ms: 1,
});

function renderMenu() {
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <StudyLayoutPresetMenu />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.clearAllMocks();
  mockedPresets = [preset('s1', '분석용'), preset('s2', '관찰용')];
  useStudyActivePresetStore.setState({ activePresetId: null });
});

describe('StudyLayoutPresetMenu', () => {
  it('목록을 보여주고 클릭하면 적용한다', () => {
    renderMenu();
    act(() => screen.getByTestId('study-layout-preset-button').click());
    expect(screen.getByTestId('study-layout-preset-apply-s1')).toHaveTextContent('분석용');

    act(() => screen.getByTestId('study-layout-preset-apply-s2').click());
    expect(applyMock).toHaveBeenCalledWith(expect.anything(), 's2');
  });

  it('안내 문구가 "탭은 그대로" 계약을 알린다 — /live 와 다른 지점', () => {
    renderMenu();
    act(() => screen.getByTestId('study-layout-preset-button').click());
    expect(screen.getByTestId('study-layout-preset-menu')).toHaveTextContent('보고 있는 저장뷰는 그대로');
  });

  it('활성 프리셋이 없으면 덮어쓰기 저장이 비활성이다', () => {
    renderMenu();
    act(() => screen.getByTestId('study-layout-preset-button').click());
    expect(screen.getByTestId('study-layout-preset-save-current')).toBeDisabled();

    act(() => { useStudyActivePresetStore.setState({ activePresetId: 's1' }); });
    expect(screen.getByTestId('study-layout-preset-save-current')).not.toBeDisabled();
  });

  it('덮어쓰기 저장은 읽었던 updated_at_ms 를 실어 보낸다', () => {
    mockedPresets = [{ ...preset('s1', '분석용'), updated_at_ms: 777 }];
    renderMenu();
    act(() => screen.getByTestId('study-layout-preset-button').click());
    act(() => { useStudyActivePresetStore.setState({ activePresetId: 's1' }); });
    act(() => screen.getByTestId('study-layout-preset-save-current').click());

    expect(updateMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 's1',
        body: expect.objectContaining({ expected_updated_at_ms: 777 }),
      }),
      expect.anything(),
    );
  });

  it('409 충돌이면 조용히 덮어쓰지 않고 목록을 다시 읽어 알린다', () => {
    const conflict = Object.assign(new Error('changed elsewhere'), {
      code: 'study_layout_preset_conflict',
      status: 409,
    });
    updateMutate.mockImplementationOnce((_vars, opts) => opts?.onError?.(conflict));
    renderMenu();
    act(() => screen.getByTestId('study-layout-preset-button').click());
    act(() => { useStudyActivePresetStore.setState({ activePresetId: 's1' }); });
    refetchMock.mockClear(); // 메뉴 열기분 제외.
    act(() => screen.getByTestId('study-layout-preset-save-current').click());

    expect(screen.getByTestId('study-layout-preset-error')).toHaveTextContent('다른 곳에서 먼저 변경된');
    expect(refetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('study-layout-preset-menu')).toBeInTheDocument();
  });

  it('새 프리셋으로 저장하면 그것이 활성 프리셋이 된다', () => {
    createMutate.mockImplementationOnce((_vars, opts) => opts?.onSuccess?.({ id: 'new-1' }));
    renderMenu();
    act(() => screen.getByTestId('study-layout-preset-button').click());
    act(() => screen.getByTestId('study-layout-preset-save-as-open').click());
    fireEvent.change(screen.getByTestId('study-layout-preset-save-as-input'), {
      target: { value: '신규 배치' },
    });
    act(() => screen.getByTestId('study-layout-preset-save-as-confirm').click());

    expect(createMutate).toHaveBeenCalledWith(
      expect.objectContaining({ name: '신규 배치' }),
      expect.anything(),
    );
    expect(useStudyActivePresetStore.getState().activePresetId).toBe('new-1');
  });

  it('메뉴를 열 때마다 목록을 다시 읽는다', () => {
    renderMenu();
    expect(refetchMock).not.toHaveBeenCalled();
    act(() => screen.getByTestId('study-layout-preset-button').click());
    expect(refetchMock).toHaveBeenCalledTimes(1);
    // 닫을 때는 읽지 않는다.
    act(() => screen.getByTestId('study-layout-preset-button').click());
    expect(refetchMock).toHaveBeenCalledTimes(1);
  });

  it('기본 배치로 초기화하면 빈 스냅샷을 적용하고 활성 프리셋을 지운다', () => {
    renderMenu();
    act(() => screen.getByTestId('study-layout-preset-button').click());
    act(() => screen.getByTestId('study-layout-preset-reset').click());
    expect(applyMock).toHaveBeenCalledWith(expect.objectContaining({ _default: true }), null);
  });

  it('삭제는 2단 확인을 거친다', () => {
    renderMenu();
    act(() => screen.getByTestId('study-layout-preset-button').click());
    act(() => screen.getByTestId('study-layout-preset-delete-s1').click());
    expect(removeMutate).not.toHaveBeenCalled();
    act(() => screen.getByTestId('study-layout-preset-confirm-delete-s1').click());
    expect(removeMutate).toHaveBeenCalledWith('s1', expect.anything());
  });
});
