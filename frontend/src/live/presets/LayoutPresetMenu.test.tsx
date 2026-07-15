import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LayoutPresetMenu } from './LayoutPresetMenu';
import { useLiveLayoutStore } from '../../state/liveLayout';
import type { LiveLayoutPreset } from '../../api/liveLayoutPresets';

const createMutate = vi.fn();
const updateMutate = vi.fn();
const removeMutate = vi.fn();
let mockedPresets: LiveLayoutPreset[] = [];

vi.mock('./useLiveLayoutPresets', () => ({
  useLiveLayoutPresets: () => ({ data: { schema_version: 1, presets: mockedPresets } }),
  useLiveLayoutPresetMutations: () => ({
    create: { mutate: createMutate },
    update: { mutate: updateMutate },
    remove: { mutate: removeMutate },
  }),
}));

const applyMock = vi.fn();
vi.mock('./layoutPresetSnapshot', () => ({
  applyPresetPayload: (...args: unknown[]) => applyMock(...args),
  capturePresetPayload: () => ({ pane_order: ['candle'] }),
  defaultPresetPayload: () => ({ pane_order: ['candle'], _default: true }),
}));

const preset = (id: string, name: string): LiveLayoutPreset => ({
  schema_version: 1,
  id,
  name,
  payload: {
    pane_order: [],
    pane_prefs_by_timeframe: {},
    indicator_flags: {},
    right_panel_width_px: 400,
    right_card_order: [],
    right_card_hidden: {},
    right_card_collapsed: {},
    right_card_weights: {},
  },
  created_at_ms: 1,
  updated_at_ms: 1,
});

function renderMenu() {
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <LayoutPresetMenu />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  mockedPresets = [preset('p1', '단타용'), preset('p2', '스윙용')];
  useLiveLayoutStore.setState({ lastAppliedPresetId: null });
});

describe('LayoutPresetMenu', () => {
  it('lists presets and applies one on click', () => {
    renderMenu();
    act(() => screen.getByTestId('layout-preset-button').click());
    expect(screen.getByTestId('layout-preset-apply-p1')).toHaveTextContent('단타용');
    act(() => screen.getByTestId('layout-preset-apply-p2').click());
    expect(applyMock).toHaveBeenCalledWith(expect.anything(), 'p2');
  });

  it('save-current is disabled without an active preset, enabled with one', () => {
    renderMenu();
    act(() => screen.getByTestId('layout-preset-button').click());
    expect(screen.getByTestId('layout-preset-save-current')).toBeDisabled();

    act(() => { useLiveLayoutStore.setState({ lastAppliedPresetId: 'p1' }); });
    expect(screen.getByTestId('layout-preset-save-current')).not.toBeDisabled();
    act(() => screen.getByTestId('layout-preset-save-current').click());
    expect(updateMutate).toHaveBeenCalledWith(expect.objectContaining({ id: 'p1' }), expect.anything());
  });

  it('saves as a new preset via the inline name input', () => {
    renderMenu();
    act(() => screen.getByTestId('layout-preset-button').click());
    act(() => screen.getByTestId('layout-preset-save-as-open').click());
    fireEvent.change(screen.getByTestId('layout-preset-save-as-input'), { target: { value: '신규' } });
    act(() => screen.getByTestId('layout-preset-save-as-confirm').click());
    expect(createMutate).toHaveBeenCalledWith(
      expect.objectContaining({ name: '신규' }),
      expect.anything(),
    );
  });

  it('deletes a preset with a two-step confirm', () => {
    renderMenu();
    act(() => screen.getByTestId('layout-preset-button').click());
    act(() => screen.getByTestId('layout-preset-delete-p1').click());
    // 1차 클릭 = 확인 대기, 아직 삭제 안 함.
    expect(removeMutate).not.toHaveBeenCalled();
    act(() => screen.getByTestId('layout-preset-confirm-delete-p1').click());
    expect(removeMutate).toHaveBeenCalledWith('p1', expect.anything());
  });

  it('surfaces an error and keeps the menu open when a mutation fails', () => {
    // update.mutate 가 실패하면 onError 콜백을 호출하도록 목.
    updateMutate.mockImplementationOnce((_body, opts) => opts?.onError?.(new Error('서버 오류')));
    renderMenu();
    act(() => screen.getByTestId('layout-preset-button').click());
    act(() => { useLiveLayoutStore.setState({ lastAppliedPresetId: 'p1' }); });
    act(() => screen.getByTestId('layout-preset-save-current').click());

    // 에러가 표면화되고 메뉴는 닫히지 않는다.
    expect(screen.getByTestId('layout-preset-error')).toHaveTextContent('서버 오류');
    expect(screen.getByTestId('layout-preset-menu')).toBeInTheDocument();
  });

  it('resets to the default layout', () => {
    renderMenu();
    act(() => screen.getByTestId('layout-preset-button').click());
    act(() => screen.getByTestId('layout-preset-reset').click());
    expect(applyMock).toHaveBeenCalledWith(expect.objectContaining({ _default: true }), null);
  });
});
