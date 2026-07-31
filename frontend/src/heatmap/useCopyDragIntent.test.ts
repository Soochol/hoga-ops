import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useCopyDragIntent } from './useCopyDragIntent';

const key = (type: 'keydown' | 'keyup', ctrlKey: boolean) =>
  window.dispatchEvent(new KeyboardEvent(type, { key: 'Control', ctrlKey }));

describe('useCopyDragIntent', () => {
  it('activatorEvent 의 ctrlKey 로 시드 — "Ctrl 먼저 누르고 끌기"가 잡힌다', () => {
    const { result, rerender } = renderHook(({ d }) => useCopyDragIntent(d), {
      initialProps: { d: false },
    });
    act(() => result.current.seed({ ctrlKey: true }));
    rerender({ d: true });
    expect(result.current.copyIntent).toBe(true);
    expect(result.current.isCopy()).toBe(true);
  });

  it('드래그 중 Ctrl 을 누르면 켜지고 떼면 꺼진다', () => {
    const { result } = renderHook(({ d }) => useCopyDragIntent(d), { initialProps: { d: true } });
    expect(result.current.isCopy()).toBe(false);
    act(() => { key('keydown', true); });
    expect(result.current.copyIntent).toBe(true);
    act(() => { key('keyup', false); });
    expect(result.current.copyIntent).toBe(false);
  });

  it('드래그가 아니면 키를 눌러도 반응하지 않는다(전역 키 입력마다 리렌더 금지)', () => {
    const { result } = renderHook(({ d }) => useCopyDragIntent(d), { initialProps: { d: false } });
    act(() => { key('keydown', true); });
    expect(result.current.copyIntent).toBe(false);
    expect(result.current.isCopy()).toBe(false);
  });

  it('드래그가 끝나면 초기화 — 다음 드래그가 이전 Ctrl 을 물려받지 않는다', () => {
    const { result, rerender } = renderHook(({ d }) => useCopyDragIntent(d), {
      initialProps: { d: true },
    });
    act(() => { key('keydown', true); });
    expect(result.current.isCopy()).toBe(true);
    rerender({ d: false });
    expect(result.current.isCopy()).toBe(false);
  });
});
