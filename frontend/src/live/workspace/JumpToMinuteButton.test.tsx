import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { JumpToMinuteButton } from './JumpToMinuteButton';

const NOW = new Date('2026-08-22T05:00:00Z').getTime(); // KST 14:00
/** 어제 KST — 올해라 라벨이 `MM-DD` 로 접힌다. */
const YESTERDAY = '20260821';
/** 작년 — `YY-MM-DD` 로 펴진다. */
const LAST_YEAR = '20250718';

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
      <JumpToMinuteButton timeframe="D" destinationDate={YESTERDAY} hasMinuteWindow={false} onRun={vi.fn()} />,
    );
    expect(button()).toBeDisabled();
    expect(button().getAttribute('title')).toBe('이 창번호에 분봉 창이 없습니다');
  });

  // 종전엔 호버해야만 목적지가 보였다 — 터치·펜에는 호버가 없어 볼 방법이 아예
  // 없었고, 좁은 헤더에서는 20px 아이콘 하나였다(2026-08-23 실측).
  it('호버 없이 목적지를 **라벨과 툴팁 둘 다**에 보여준다', () => {
    render(
      <JumpToMinuteButton timeframe="D" destinationDate={YESTERDAY} hasMinuteWindow onRun={vi.fn()} />,
    );
    expect(button().textContent).toContain('08-21');
    expect(button().getAttribute('title')).toBe('분봉으로 — 08-21');
    expect(button().getAttribute('aria-label')).toBe('분봉 창을 08-21 로 이동');
  });

  it('차트가 아직 날짜를 밀지 않았으면 동사만 남는다', () => {
    render(<JumpToMinuteButton timeframe="D" destinationDate={null} hasMinuteWindow onRun={vi.fn()} />);
    expect(button().getAttribute('title')).toBe('분봉으로');
    expect(button().getAttribute('aria-label')).toBe('분봉으로');
  });

  // 「갈 수 없다」는 이 버튼이 말하지 않는다 — 하한은 소비하는 분봉 창만 안다(#1497).
  // 여기서 하드코딩된 13개월로 막으면 디스크 모드에서 갈 수 있는 곳을 막게 된다.
  it('아주 과거인 목적지도 막지 않고 날짜만 보여준다', () => {
    const onRun = vi.fn();
    render(
      <JumpToMinuteButton timeframe="D" destinationDate={LAST_YEAR} hasMinuteWindow onRun={onRun} />,
    );
    expect(button().getAttribute('title')).toBe('분봉으로 — 25-07-18');
    fireEvent.click(button());
    expect(onRun).toHaveBeenCalledTimes(1);
  });

  it('누르면 창이 소유한 실행자를 부른다 — 판정이 갈리지 않게 발행은 한 곳이다', () => {
    const onRun = vi.fn();
    render(<JumpToMinuteButton timeframe="D" destinationDate={YESTERDAY} hasMinuteWindow onRun={onRun} />);
    fireEvent.click(button());
    expect(onRun).toHaveBeenCalledTimes(1);
  });

  it('분봉 창이 없으면 눌러도 실행자를 부르지 않는다', () => {
    const onRun = vi.fn();
    render(
      <JumpToMinuteButton timeframe="D" destinationDate={YESTERDAY} hasMinuteWindow={false} onRun={onRun} />,
    );
    fireEvent.click(button());
    expect(onRun).not.toHaveBeenCalled();
  });

  // 주·월봉은 착지 날짜를 **발행 창이 모른다** — 그 칸의 마지막 거래일은 분봉 창의
  // 캔들에만 있다. 상한 날짜를 약속하면 거래일이 아닌 날을 말하게 된다(실측 2026-08-23,
  // 일요일: 주·월봉 모두 `08-23` 을 보여줬는데 실제 착지는 `08-21`).
  it('주봉은 **그 주**로, 월봉은 **그 달**로 말한다', () => {
    render(<JumpToMinuteButton timeframe="W" destinationDate="20260818" hasMinuteWindow onRun={vi.fn()} />);
    expect(button().getAttribute('title')).toBe('분봉으로 — 08-18 주');
    cleanup();
    render(<JumpToMinuteButton timeframe="M" destinationDate="20260803" hasMinuteWindow onRun={vi.fn()} />);
    expect(button().getAttribute('title')).toBe('분봉으로 — 08월');
    cleanup();
    render(<JumpToMinuteButton timeframe="M" destinationDate="20251215" hasMinuteWindow onRun={vi.fn()} />);
    expect(button().getAttribute('title')).toBe('분봉으로 — 25년 12월');
  });

  it('라벨을 접으면 텍스트가 빠지고 aria-label 만 남는다(#762 접힘 정책)', () => {
    render(
      <JumpToMinuteButton
        timeframe="D"
        destinationDate={YESTERDAY}
        hasMinuteWindow
        onRun={vi.fn()}
        showLabel={false}
      />,
    );
    expect(button().textContent).toBe('');
    expect(button().getAttribute('aria-label')).toBeTruthy();
  });
});
