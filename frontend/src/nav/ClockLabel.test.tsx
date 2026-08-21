import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { act } from 'react';
import ClockLabel, { kstClockParts } from './ClockLabel';

/** **이 파일은 UTC 워크스테이션을 흉내 낸다.**
 *
 * 개발 머신 tz 가 Asia/Seoul 이라, 그대로 두면 컴포넌트가 `timeZone` 을 안 박아도
 * 우연히 같은 값이 나와 tz 고정 계약이 무신호가 된다. `vi.hoisted` 는 import 평가보다
 * 먼저 돌므로 모듈 레벨 포매터가 만들어지기 전에 TZ 가 바뀐다(Node 16+ 는 process.env.TZ
 * 변경 시 V8 의 기본 tz 캐시를 무효화한다). */
// tsconfig.test.json 은 node 타입을 싣지 않는다(CLAUDE.md: e2e 의 `types: ["node"]` 를
// 앱·테스트 프로젝트에 얹으면 setTimeout 반환형이 바뀌어 src/ 에 없는 에러가 생긴다).
// 여기서 필요한 것은 `process.env` 한 칸뿐이라 파일 지역 앰비언트로 좁혀 선언한다.
declare const process: { env: Record<string, string | undefined> };

vi.hoisted(() => {
  process.env.TZ = 'UTC';
});

/** 2026-08-21 14:03:27 KST == 05:03:27 UTC (금요일). */
const T = Date.parse('2026-08-21T05:03:27.000Z');

describe('kstClockParts', () => {
  it('UTC 워크스테이션에서도 KST 로 찍는다', () => {
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('UTC'); // 위 흉내가 실제로 걸렸는지
    expect(kstClockParts(T)).toEqual({
      date: '2026-08-21 (금)',
      time: '14:03:27',
      iso: '2026-08-21T14:03:27+09:00',
    });
  });

  it('자정을 24시로 넘기지 않는다', () => {
    // 날짜가 함께 넘어가는지(KST 22일)가 이 테스트가 **실제로 잡는** 것이다.
    // ⚠ `hourCycle: 'h23'` → `hour12: false` 로 바꿔도 이 단언은 초록이다(실측) —
    // 현재 ICU 가 ko-KR 자정을 `00` 으로 내기 때문. h23 은 다른 ICU·로케일에 대한
    // 보험이지 이 테스트가 증명하는 계약이 아니다.
    const midnight = Date.parse('2026-08-21T15:00:05.000Z');
    expect(kstClockParts(midnight)).toEqual({
      date: '2026-08-22 (토)',
      time: '00:00:05',
      iso: '2026-08-22T00:00:05+09:00',
    });
  });

  it('ICU 기본 패턴(`2026. 08. 21.`)이 아니라 조립한 형식으로 낸다', () => {
    expect(kstClockParts(T).date).not.toContain('. ');
  });
});

describe('ClockLabel', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T);
  });
  afterEach(() => vi.useRealTimers());
  afterAll(() => {
    process.env.TZ = 'Asia/Seoul';
  });

  it('날짜·시각을 초까지 렌더한다', () => {
    render(<ClockLabel />);
    const clock = screen.getByRole('timer');
    expect(clock).toHaveTextContent('2026-08-21 (금)');
    expect(clock).toHaveTextContent('14:03:27');
  });

  it('기계 판독용 dateTime 을 함께 싣는다', () => {
    render(<ClockLabel />);
    expect(screen.getByRole('timer')).toHaveAttribute('datetime', '2026-08-21T14:03:27+09:00');
  });

  it('초가 흐르면 라벨이 따라 바뀐다 — 경계 +20ms 에', () => {
    // 순수 함수 테스트는 포맷만 증명한다 — 훅 배선이 실제로 리렌더를 일으키는지는
    // 여기서만 드러난다.
    //
    // **표시는 벽시계보다 최대 20ms 늦다**(BOUNDARY_EPSILON_MS). 타이머를 경계 정각에
    // 걸면 마이크로초 단위로 일찍 깨어날 때 같은 초를 두 번 그리므로, 경계를 확실히
    // 넘긴 뒤 읽는 쪽을 골랐다. 아래 두 단언이 그 20ms 창을 양쪽에서 고정한다.
    render(<ClockLabel />);
    expect(screen.getByRole('timer')).toHaveTextContent('14:03:27');
    act(() => vi.advanceTimersByTime(3000)); // 벽시계 :30 정각 — 아직 여유 구간
    expect(screen.getByRole('timer')).toHaveTextContent('14:03:29');
    act(() => vi.advanceTimersByTime(20));
    expect(screen.getByRole('timer')).toHaveTextContent('14:03:30');
  });

  it('font-data 로 렌더한다 — tnum 이 없으면 폭이 매초 흔들린다', () => {
    // DESIGN.md: tnum 은 `font-data` 유틸리티에 결속돼 있다. 호출부가 `tabular-nums`
    // 를 따로 적는 것도, 다른 폰트 유틸을 쓰는 것도 계약 위반이다.
    render(<ClockLabel />);
    expect(screen.getByRole('timer').className).toContain('font-data');
  });

  it('스크린리더를 매초 방해하지 않는다 — live region 이지만 announce 는 off', () => {
    render(<ClockLabel />);
    expect(screen.getByRole('timer')).not.toHaveAttribute('aria-live');
  });
});
