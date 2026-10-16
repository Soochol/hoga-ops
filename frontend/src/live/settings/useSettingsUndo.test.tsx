import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { create } from 'zustand';
import { useSettingsUndo } from './useSettingsUndo';
import { readIndicatorEditor, restoreIndicatorEditor, subscribeIndicatorEditor } from './editorSnapshots';
import { FACTORY_INDICATOR_SETTINGS } from '../../state/indicatorSettingsV2';
import { useLivePageStore } from '../../state/livePage';
import { useChartPrefsStore } from '../../state/chartPrefs';

const store = create(() => ({ a: 1, b: 2 }));
const read = () => ({ ...store.getState() });
const restore = (patch: Record<string, unknown>) => store.setState(patch);
const subscribe = (changed: () => void) => store.subscribe(changed);
function Editor({ scope = 'one', fail = false }: { scope?: string; fail?: boolean }) {
  const undo = useSettingsUndo({ scopeKey: scope, read, restore, subscribe });
  return <div {...undo.captureProps}>
    <button onClick={() => { store.setState({ a: 3 }); store.setState({ b: 4 }); }}>두 값 변경</button>
    <button onClick={() => store.setState({ a: 5 })}>한 값 변경</button>
    <button onClick={() => undo.record({ isCurrent: () => true, undo: async () => { if (fail) throw new Error('저장 실패'); store.setState({ a: 1 }); } })}>서버 성공 기록</button>
    <button data-settings-undo disabled={!undo.canUndo} onClick={() => void undo.undo()}>되돌리기</button>
    <span role="status">{undo.message}</span>
  </div>;
}
const undoButton = () => screen.getByRole('button', { name: '되돌리기' });
beforeEach(() => store.setState({ a: 1, b: 2 }));

describe('설정 변경 되돌리기', () => {
  it('한 이벤트의 여러 저장소 쓰기를 한 번에 복원한다', async () => {
    render(<Editor />); fireEvent.click(screen.getByText('두 값 변경'));
    await waitFor(() => expect(undoButton()).toBeEnabled());
    fireEvent.click(undoButton());
    await waitFor(() => expect(store.getState()).toEqual({ a: 1, b: 2 }));
    expect(undoButton()).toBeDisabled();
  });
  it('바뀌지 않은 필드에 외부 갱신이 와도 그것을 보존한다', async () => {
    render(<Editor />); fireEvent.click(screen.getByText('한 값 변경'));
    await waitFor(() => expect(undoButton()).toBeEnabled());
    act(() => store.setState({ b: 99 })); fireEvent.click(undoButton());
    await waitFor(() => expect(store.getState()).toEqual({ a: 1, b: 99 }));
  });
  it('같은 필드의 외부 변경은 오래된 복원을 무효화한다', async () => {
    render(<Editor />); fireEvent.click(screen.getByText('한 값 변경'));
    await waitFor(() => expect(undoButton()).toBeEnabled());
    act(() => store.setState({ a: 7 })); expect(undoButton()).toBeDisabled();
  });
  it('대상이 달라지면 이전 기록과 아직 처리하지 않은 이벤트를 버린다', async () => {
    const view = render(<Editor />); fireEvent.click(screen.getByText('한 값 변경'));
    view.rerender(<Editor scope="two" />);
    await act(async () => {});
    expect(undoButton()).toBeDisabled(); expect(store.getState().a).toBe(5);
    view.rerender(<Editor scope="one" />);
    expect(undoButton()).toBeDisabled();
  });
  it('서버 복원이 실패하면 오류를 알리고 다시 시도할 수 있다', async () => {
    const view = render(<Editor fail />); fireEvent.click(screen.getByText('서버 성공 기록'));
    fireEvent.click(undoButton());
    await screen.findByText('저장 실패'); expect(undoButton()).toBeEnabled();
    view.rerender(<Editor />);
    fireEvent.click(screen.getByText('서버 성공 기록')); fireEvent.click(undoButton());
    await screen.findByText('이전 설정으로 되돌렸습니다'); expect(undoButton()).toBeDisabled();
  });
});

const scope = { windowKey: 'live:editor-undo-one' };
const other = { windowKey: 'live:editor-undo-two' };
const scopedRead = () => readIndicatorEditor(scope, 'D', false);
const scopedRestore = (patch: Record<string, unknown>) => restoreIndicatorEditor(scope, 'D', patch);
function ScopedEditor() {
  const undo = useSettingsUndo({ scopeKey: 'one:D', read: scopedRead, restore: scopedRestore, subscribe: subscribeIndicatorEditor });
  return <div {...undo.captureProps}><button onClick={() => {
    useLivePageStore.getState().patchIndicatorsScoped(scope, 'D', { bollingerPeriod: 31 });
    useChartPrefsStore.getState().setPrefScoped(scope, 'D', 'surgeMarkerEnabled', true);
  }}>지표와 필터 변경</button><button data-settings-undo disabled={!undo.canUndo} onClick={() => void undo.undo()}>되돌리기</button></div>;
}
it('지표·필터를 같은 창과 봉으로 복원하고 다른 창과 봉은 보존한다', async () => {
  useLivePageStore.setState({ ...FACTORY_INDICATOR_SETTINGS, indicatorsByTimeframe: {}, indicatorsByWindow: {}, indicatorTimeframe: '1m' });
  useChartPrefsStore.setState({ indicatorModalByWindow: {}, indicatorModalByTimeframe: {} });
  useLivePageStore.getState().patchIndicatorsScoped(scope, 'D', { bollingerPeriod: 20 });
  useLivePageStore.getState().patchIndicatorsScoped(scope, 'W', { bollingerPeriod: 40 });
  useChartPrefsStore.getState().setPrefScoped(scope, 'D', 'surgeMarkerEnabled', false);
  useLivePageStore.getState().patchIndicatorsScoped(other, 'D', { bollingerPeriod: 50 });
  const before = scopedRead(), weekly = readIndicatorEditor(scope, 'W', false);
  render(<ScopedEditor />); fireEvent.click(screen.getByText('지표와 필터 변경'));
  await waitFor(() => expect(undoButton()).toBeEnabled());
  act(() => useLivePageStore.getState().patchIndicatorsScoped(other, 'D', { bollingerPeriod: 60 }));
  fireEvent.click(undoButton());
  await waitFor(() => expect(scopedRead()).toEqual(before));
  expect(readIndicatorEditor(scope, 'W', false)).toEqual(weekly);
  expect(readIndicatorEditor(other, 'D', false)['indicator:bollingerPeriod']).toBe(60);
});
