import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { LiveVenuePicker } from './LiveVenuePicker';
import { useLiveVenueStore } from '../state/liveVenue';

afterEach(() => {
  cleanup();
  localStorage.clear();
  useLiveVenueStore.setState({ venue: 'KRX' });
});

describe('LiveVenuePicker', () => {
  it('트리거가 현재 거래소와 그 세션 창을 함께 인다', () => {
    useLiveVenueStore.setState({ venue: 'UN' });
    render(<LiveVenuePicker />);
    const trigger = screen.getByTestId('live-venue-picker');
    expect(trigger.textContent).toContain('통합');
    // 세션 창이 트리거에 있는 것이 이 컴포넌트의 요점 — 전환 비용(x축 리플로우)을
    // 닫힌 상태에서도 알린다. 라벨이 사라지면 선택기가 그냥 드롭다운이 된다.
    expect(trigger.textContent).toContain('08:00–20:00');
  });

  it('팝오버는 선택지마다 세션 창을 병기해 고르기 전에 결과를 알린다', () => {
    render(<LiveVenuePicker />);
    fireEvent.click(screen.getByTestId('live-venue-picker'));
    expect(screen.getByTestId('live-venue-option-KRX').textContent).toContain('09:00–15:30');
    expect(screen.getByTestId('live-venue-option-NXT').textContent).toContain('08:00–20:00');
    expect(screen.getByTestId('live-venue-option-UN').textContent).toContain('08:00–20:00');
  });

  it('선택이 전역 store 에 반영되고 팝오버가 닫힌다', () => {
    render(<LiveVenuePicker />);
    fireEvent.click(screen.getByTestId('live-venue-picker'));
    fireEvent.click(screen.getByTestId('live-venue-option-NXT'));
    expect(useLiveVenueStore.getState().venue).toBe('NXT');
    expect(screen.queryByTestId('live-venue-popover')).toBeNull();
    expect(screen.getByTestId('live-venue-picker').textContent).toContain('NXT');
  });

  it('팝오버 내부 mousedown 은 dismiss 로 전파되지 않는다', () => {
    // 회귀 방어: 패널은 body 포털이라 `useDismissablePopover` 의 anchor-contains
    // 예외 밖이다. 전파를 안 끊으면 mousedown 이 먼저 닫고 → 버튼이 언마운트되어
    // click 이 영영 안 온다(선택이 통째로 죽는데 화면상 "그냥 닫힘" 으로 보인다).
    render(<LiveVenuePicker />);
    fireEvent.click(screen.getByTestId('live-venue-picker'));
    fireEvent.mouseDown(screen.getByTestId('live-venue-option-NXT'));
    expect(screen.getByTestId('live-venue-popover')).toBeTruthy();
  });

  it('바깥 mousedown 과 Escape 로 닫힌다', () => {
    render(<LiveVenuePicker />);
    fireEvent.click(screen.getByTestId('live-venue-picker'));
    fireEvent.mouseDown(document.body);
    expect(screen.queryByTestId('live-venue-popover')).toBeNull();

    fireEvent.click(screen.getByTestId('live-venue-picker'));
    expect(screen.getByTestId('live-venue-popover')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('live-venue-popover')).toBeNull();
  });
});
