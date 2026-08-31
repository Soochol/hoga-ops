/**
 * **뷰포트 앵커의 축-간 왕복이 봉 정체성을 보존하는가** — `useViewportBackfill` 의
 * 리포지셔너가 서 있는 전제를 순수 함수 층에서 직접 잰다.
 *
 * 그 훅은 커밋마다 화면 오른쪽 끝을 이렇게 기억하고 되찾는다:
 *
 * ```
 * 저장(효과 1, 구축):  refMs  = prevAxis.toReal(vr.to)
 * 복원(효과 2, 신축):  newIdx = timeToIndex(axis.toVirtual(refMs))
 *                     shift  = newIdx - snap.refIdx
 * ```
 *
 * 즉 **`refMs` 가 두 축에서 같은 봉을 가리킨다**는 것이 shift 계산의 전제다. 그
 * 전제가 깨지면 shift 는 축의 실제 이동량과 달라지고, 뷰포트가 그 오차만큼 엉뚱한
 * 곳에 앉는다 — 2026-08-26 실측한 「좌팬 중인데 화면이 미래로」의 후보 ① 이 그것이다.
 *
 * 여기서 재는 것은 **축뿐**이다(인덱스는 lightweight-charts 소유). 축이 봉 정체성을
 * 보존하면 ① 은 이 층에서 성립하지 않고, 깨지면 ① 의 하한이 잡힌다.
 */
import { describe, it, expect } from 'vitest';
import { createVirtualAxis } from './virtualAxis';
import { INTER_SEGMENT_GAP_MS } from './time';

const SESSION_LEN_MS = 6.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_MS = 60_000;

/** 2025-10-13 09:00 KST 근방 — 사용자가 재현을 지목한 구간의 형태를 그대로 쓴다. */
const D1_OPEN = 1760313600000;
const day = (n: number) => ({
  date: `2025101${n}`,
  sessionOpenMs: D1_OPEN + n * DAY_MS,
  sessionCloseMs: D1_OPEN + n * DAY_MS + SESSION_LEN_MS,
});

/** 캡처 구멍이 있는 창(day2 없음) → gap fill 이 day2 를 채운 창. */
const WITH_HOLE = [day(0), day(1), day(3), day(4)];
const FILLED = [day(0), day(1), day(2), day(3), day(4)];
/** 좌팬 프리펜드까지 겹친 창 — 앞에 하루가 더 붙는다. */
const PREPENDED = [
  { date: '20251009', sessionOpenMs: D1_OPEN - DAY_MS, sessionCloseMs: D1_OPEN - DAY_MS + SESSION_LEN_MS },
  ...FILLED,
];

describe('앵커 왕복 — 같은 축 안에서', () => {
  it('세션 안의 시각은 왕복이 닫힌다 (정상 경로의 대조군)', () => {
    const axis = createVirtualAxis(WITH_HOLE);
    const barMs = day(3).sessionOpenMs + 120 * MIN_MS;
    expect(axis.toReal(axis.toVirtual(barMs))).toBe(barMs);
  });

  it('세그먼트 사이 1초 갭 안의 가상 시각은 왕복이 **뒤로 당겨진다**', () => {
    const axis = createVirtualAxis(WITH_HOLE);
    // day0 의 가상 끝 + 0.5초 = 어느 세션에도 속하지 않는 가상 좌표.
    const seg0End = axis.segments[0].virtualStart + SESSION_LEN_MS;
    const inGap = seg0End + INTER_SEGMENT_GAP_MS / 2;
    const backAndForth = axis.toVirtual(axis.toReal(inGap));
    // 왕복이 닫히지 않는다 — 갭 좌표는 세션 끝으로 흡수된다.
    expect(backAndForth).not.toBe(inGap);
    expect(backAndForth).toBe(seg0End);
  });
});

describe('앵커 왕복 — 축이 갈릴 때 (프로덕션 경로)', () => {
  it('구멍 뒤의 봉을 보고 있었다면, gap fill 후에도 같은 봉을 가리킨다', () => {
    const before = createVirtualAxis(WITH_HOLE);
    const after = createVirtualAxis(FILLED);
    // 화면 오른쪽 끝 = day3 의 어떤 봉.
    const barMs = day(3).sessionOpenMs + 90 * MIN_MS;
    const refMs = before.toReal(before.toVirtual(barMs));
    // 새 축에서 되찾은 좌표를 실제 시각으로 되돌리면 원래 봉이어야 한다.
    expect(after.toReal(after.toVirtual(refMs))).toBe(barMs);
  });

  it('프리펜드까지 겹쳐도 봉 정체성이 보존된다', () => {
    const before = createVirtualAxis(WITH_HOLE);
    const after = createVirtualAxis(PREPENDED);
    const barMs = day(4).sessionOpenMs + 30 * MIN_MS;
    const refMs = before.toReal(before.toVirtual(barMs));
    expect(after.toReal(after.toVirtual(refMs))).toBe(barMs);
  });

  it('⚠ **구멍 위를 보고 있었다면 gap fill 이 앵커를 다른 날로 옮긴다**', () => {
    const before = createVirtualAxis(WITH_HOLE);
    const after = createVirtualAxis(FILLED);
    // 사용자가 보던 화면 오른쪽 끝이 구멍(day2) 자리 — 구축엔 그 날 세션이 없으므로
    // day1 close 와 day3 open 사이의 1초 갭이 그 자리다. 좌팬으로 빈 구간에
    // 들어갔을 때 실제로 이 좌표가 나온다.
    const seg1End = before.segments[1].virtualStart + SESSION_LEN_MS;
    const onHole = seg1End + INTER_SEGMENT_GAP_MS / 2;
    const refMs = before.toReal(onHole);
    // 구축에서 이 앵커는 day1 의 마지막 봉을 뜻한다.
    expect(refMs).toBe(day(1).sessionCloseMs);
    // 신축에서 되찾으면 — day2 가 생겼어도 day1 마지막 봉 그대로여야 한다.
    const recovered = after.toReal(after.toVirtual(refMs));
    expect(recovered).toBe(day(1).sessionCloseMs);
  });

  it('앵커가 데이터 최좌단보다 과거면 구축에서 첫 봉으로 클램프된다', () => {
    const before = createVirtualAxis(WITH_HOLE);
    const after = createVirtualAxis(PREPENDED);
    // 좌팬으로 데이터 왼쪽 밖을 보는 상태 — 가상 원점보다 과거.
    const beyondLeft = before.segments[0].virtualStart - 5 * 60 * MIN_MS;
    const refMs = before.toReal(beyondLeft);
    // 구축: 첫 봉으로 클램프. **정보가 여기서 소실된다.**
    expect(refMs).toBe(day(0).sessionOpenMs);
    // 신축에는 그 앞에 하루가 더 있으므로, 같은 refMs 는 이제 첫 봉이 아니라
    // **두 번째 날의 시작**이다 — 앵커 자체는 여전히 같은 봉을 가리킨다.
    expect(after.toReal(after.toVirtual(refMs))).toBe(day(0).sessionOpenMs);
    expect(after.toVirtual(refMs)).toBe(after.segments[1].virtualStart);
  });
});
