import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { JumpToMinuteButton } from './JumpToMinuteButton';

const NOW = new Date('2026-08-22T05:00:00Z').getTime(); // KST 14:00
const DAY_MS = 24 * 60 * 60 * 1000;
/** 어제 KST 12:00 — 보유 한계 안. */
const YESTERDAY = Date.UTC(2026, 7, 21, 3, 0, 0);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const button = () => screen.getByTestId('live-jump-to-minute-button');

describe('JumpToMinuteButton', () => {
  it('그룹에 분봉 창이 없으면 비활성이고 **사유를 말한다**', () => {
    render(
      <JumpToMinuteButton readTargetMs={() => YESTERDAY} hasMinuteWindow={false} onRun={vi.fn()} />,
    );
    expect(button()).toBeDisabled();
    expect(button().getAttribute('title')).toBe('이 창번호에 분봉 창이 없습니다');
  });

  it('호버하면 목적지를 **누르기 전에** 보여준다', () => {
    render(
      <JumpToMinuteButton readTargetMs={() => YESTERDAY} hasMinuteWindow onRun={vi.fn()} />,
    );
    // 호버 전에는 규칙(호버한 봉 / 뷰 우측 끝)이 아직 안 정해졌으므로 날짜가 없다.
    expect(button().getAttribute('title')).toBe('분봉으로');
    fireEvent.pointerEnter(button());
    expect(button().getAttribute('title')).toBe('분봉으로 — 08-21');
    expect(button().getAttribute('aria-label')).toBe('분봉 창을 08-21 로 이동');
  });

  it('목적지가 보유 한계 밖이면 호버 시 사유가 뜬다', () => {
    render(
      <JumpToMinuteButton
        readTargetMs={() => NOW - 400 * DAY_MS}
        hasMinuteWindow
        onRun={vi.fn()}
      />,
    );
    fireEvent.pointerEnter(button());
    expect(button().getAttribute('title')).toContain('분봉 보유 기간(13개월) 밖입니다');
  });

  it('누르면 창이 소유한 실행자를 부른다 — 판정이 갈리지 않게 발행은 한 곳이다', () => {
    const onRun = vi.fn();
    render(<JumpToMinuteButton readTargetMs={() => YESTERDAY} hasMinuteWindow onRun={onRun} />);
    fireEvent.click(button());
    expect(onRun).toHaveBeenCalledTimes(1);
  });

  it('분봉 창이 없으면 눌러도 실행자를 부르지 않는다', () => {
    const onRun = vi.fn();
    render(
      <JumpToMinuteButton readTargetMs={() => YESTERDAY} hasMinuteWindow={false} onRun={onRun} />,
    );
    fireEvent.click(button());
    expect(onRun).not.toHaveBeenCalled();
  });

  it('라벨을 접으면 텍스트가 빠지고 aria-label 만 남는다(#762 접힘 정책)', () => {
    render(
      <JumpToMinuteButton
        readTargetMs={() => YESTERDAY}
        hasMinuteWindow
        onRun={vi.fn()}
        showLabel={false}
      />,
    );
    expect(button().textContent).toBe('');
    expect(button().getAttribute('aria-label')).toBeTruthy();
  });
});
