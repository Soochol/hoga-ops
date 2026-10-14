import type { ProgramTradePoint } from '../api/types';
import { realMsToYyyymmdd } from '../live/liveDateTime';


export type SparkPoint = { t: number; v: number };

export type SparkSegment =
  | { kind: 'solid'; pts: SparkPoint[] }
  | { kind: 'dashed'; pts: SparkPoint[] };
 // always exactly 2 points

/** 이웃 점 사이 시간 간격이 임계를 넘으면 그 브리지만 2점 점선으로 떼어내고
 *  나머지는 solid run 으로 묶는다 (브로커 buildSegments 와 같은 규칙). */
export function buildTimeGapSegments(
  pts: readonly SparkPoint[],
  thresholdMs: number,
): SparkSegment[] {
  if (pts.length === 0) return [];
  if (pts.length === 1) return [{ kind: 'solid', pts: [pts[0]] }];

  const out: SparkSegment[] = [];
  let run: SparkPoint[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].t - pts[i - 1].t <= thresholdMs) {
      run.push(pts[i]);
    } else {
      if (run.length >= 1) out.push({ kind: 'solid', pts: run });
      out.push({ kind: 'dashed', pts: [pts[i - 1], pts[i]] });
      run = [pts[i]];
    }
  }
  if (run.length >= 1) out.push({ kind: 'solid', pts: run });
  return out;
}


export function pickProgramTradePoint(
  points: readonly ProgramTradePoint[],
  cursorMs: number | null,
  todayKst: string | null = null,
): ProgramTradePoint | null {
  const last = points.length > 0 ? points[points.length - 1] : null;
  if (last == null) return null;
  // latest 모드, 또는 커서가 마지막 관측 이후(미래 whitespace·다음날 칸)면 최신값
  // 고정 — 거래원·호가가 미래 whitespace 에서 latest 로 복귀하는 것과 일관.
  // 이 클램프가 없으면 아래 floor 가 "다음날 이하 최대 = 전날 마지막 점"을 집어
  // 전날 값이 새어나온다(병합 번들이 여러 날을 담기 때문).
  if (cursorMs === null || cursorMs >= last.t) {
    // 커서가 마지막 관측과 같은 KST 날짜(장중·장 마감 후 미래 whitespace)면
    // 오늘 스코프와 무관하게 최신값 고정 — 전일 캔들 뒤쪽 호버도 그 날 마지막
    // 값을 읽는다(floor 의 날짜 경계 가드와 같은 "같은 날" 규칙).
    if (cursorMs !== null && realMsToYyyymmdd(last.t) === realMsToYyyymmdd(cursorMs)) {
      return last;
    }
    // 오늘 스코프(거래원 latest 와 같은 의미론, ADR-0044): todayKst 가 주어지면
    // 마지막 점이 오늘일 때만 latest 로 인정한다 — 새날 아침(오늘 관측 0건)에
    // 전일 마감 누적이 현재값처럼 남는 것을 막는다.
    return todayKst === null || realMsToYyyymmdd(last.t) === todayKst ? last : null;
  }
  for (let i = points.length - 1; i >= 0; i -= 1) {
    const p = points[i];
    if (p != null && p.t <= cursorMs) {
      // 날짜 경계 가드: floor 결과가 커서와 다른 KST 날짜면(그 날엔 관측 없음)
      // 전날 값으로 넘기지 않는다. 스파크라인의 날짜 스코프(realMsToYyyymmdd
      // 필터)와 대칭 — 카드 숫자와 궤적의 날짜 규칙을 일치시킨다.
      return realMsToYyyymmdd(p.t) === realMsToYyyymmdd(cursorMs) ? p : null;
    }
  }
  return null;
}
