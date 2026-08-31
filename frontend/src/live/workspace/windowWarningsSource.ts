import { useSyncExternalStore } from 'react';

/**
 * 창 → 타이틀바 경고 발행 채널 (종목 식별을 창 헤더/레전드→타이틀바로 이관).
 *
 * 타이틀바(WindowFrame)는 창 데이터 파이프라인(`useLiveChartData`, ChartWindowInner)
 * 의 **부모**라 백필 날짜 같은 번들 파생값에 직접 접근할 수 없다. ChartWindowInner 가
 * 이 값을 여기로 발행하고, 타이틀바의 종목 식별 행이 `windowId` 로 구독한다.
 * 현재가·등락률·히트맵은 `code` 만으로 전역 캐시 훅에서 self-fetch 되므로 이 채널에
 * 싣지 않는다 — 경고 데이터만 올려 발행 빈도를 낮춘다.
 *
 * `windowId` keyed Map 이라 여러 창이 동시에 자기 타이틀바를 갱신한다(단일 포커스
 * 창만 발행하던 #865 의 liveWindowStatusSource 와 다른 점).
 */
export type WindowWarnings = {
  /** 좌측 팬 딥 백필로 로드된 최고(最古) 거래일(YYYYMMDD). null 이면 진행 칩 미표시. */
  backfillEarliestDate: string | null;
};

/** 미발행 창의 안정 기본값 — useSyncExternalStore 가 매 렌더 같은 참조를 받게
 *  한다(새 객체 반환 시 무한 렌더). */
const EMPTY: WindowWarnings = { backfillEarliestDate: null };

/**
 * 진행 칩(`past-backfill-progress-chip`)에 **무슨 날짜를 실을지** 정한다. 발행부
 * (`ChartWindow`)가 부르는 순수 판정 — 게이트와 소스 선택이 한자리에 있어야 회귀를
 * 테이블로 잡을 수 있다.
 *
 * **왜 `earliestSegmentDate` 를 그대로 쓰면 안 되는가.** 그 세그먼트는 워크백 내내
 * `extending` 홀드(`useLiveBundle` 의 `lastSettledChartRef`) 대상이라 **날짜가
 * 고정된다.** 실측(2026-08-24, 000270 10m hogaplay, 1초 간격 샘플링): t+4~16s 동안
 * 「6/9까지」가 13초간 그대로였고 그 사이 7일 타일이 여러 개 도착했다. 13초 동안 같은
 * 날짜가 멈춰 있으면 사용자에겐 **멈춘 것과 구별되지 않는다** — 칩이 있는데도 "고장난
 * 것 같다" 가 되는 자리다.
 *
 * `settledFromDate`(캔들 병합본이 되싣는 from, PR #1561)는 홀드를 타지 않고 **타일
 * merge 마다 갱신**되므로 진행이 보인다.
 *
 * 두 가지를 일부러 방어한다:
 *  - **폴백** — `settledFromDate` 가 없는 경로(미배선·지수)에서 칩을 조용히 죽이지
 *    않는다. 종전 소스로 되돌아간다.
 *  - **후퇴 금지** — 축소나 오늘-델타로 좁아진 창이 되실리는 렌더에서 표시가 뒤로
 *    가지 않게, 둘 중 **더 과거**를 쓴다. 진행 표시는 단조로워야 읽힌다.
 */
export function backfillProgressDate(args: {
  /** 지금 과거 확장이 진행 중인가(`useLiveBundle` 의 `extending`). */
  extending: boolean;
  /**
   * 키움 분봉 보충(`useMinuteGapFill`)이 아직 도는 중인가(fetch 중이거나 미처리
   * run 잔여). 구멍 구간을 팬으로 건널 때의 실측(2026-08-25, 010140 5m,
   * 06-15~07-02 캡처 구멍): extend→stop 은 7초에 끝났지만 그 뒤 보충 콜들이 도는
   * 십수 초 동안 화면은 whitespace 였고 칩은 extending 게이트라 꺼져 있었다 —
   * **가장 긴 대기가 표시 없는 구간**이라 "갑자기 빈 화면 = 고장" 으로 읽혔다.
   * 미배선 호출자는 생략(false) — 종전 게이트 그대로다.
   */
  gapFillPending?: boolean;
  /** 창이 한 번이라도 확장됐는가. null 이면 백필이 아니라 첫 로드다. */
  historicalFromDate: string | null;
  /** 캔들 병합본이 되싣는 from — 홀드를 타지 않는다. 미배선 경로는 null. */
  settledFromDate: string | null;
  /** 홀드된 번들의 최고(最古) 세그먼트 날짜. 캔들이 0개면 null. */
  earliestSegmentDate: string | null;
}): string | null {
  const {
    extending, gapFillPending = false, historicalFromDate, settledFromDate, earliestSegmentDate,
  } = args;
  if (!extending && !gapFillPending) return null;
  if (historicalFromDate === null || earliestSegmentDate === null) return null;
  if (settledFromDate === null) return earliestSegmentDate;
  return settledFromDate < earliestSegmentDate ? settledFromDate : earliestSegmentDate;
}

const byWindow = new Map<string, WindowWarnings>();
const listeners = new Set<() => void>();

function notify(): void {
  listeners.forEach((l) => l());
}

export function publishWindowWarnings(windowId: string, next: WindowWarnings): void {
  byWindow.set(windowId, next);
  notify();
}

/** 자기 발행일 때만 걷는다 — 언마운트/대상 이탈 시. */
export function clearWindowWarnings(windowId: string): void {
  if (!byWindow.has(windowId)) return;
  byWindow.delete(windowId);
  notify();
}

export function useWindowWarnings(windowId: string): WindowWarnings {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => byWindow.get(windowId) ?? EMPTY,
    () => EMPTY,
  );
}
