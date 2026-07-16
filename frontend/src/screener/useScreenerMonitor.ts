import { useEffect, useRef } from 'react';
import { useQuotes } from '../api/liveQuotes';
import { useLiveVenueStore } from '../state/liveVenue';

/** 스코프 유니버스(관심∪히트맵)면 15초, 전체 시장이면 30초. 서버 intraday overlay TTL
 *  (15초)과 정합 — 그보다 짧으면 같은 캐시를 히트할 뿐이라 낭비. 좁은 스코프는 fetch
 *  비용이 작아 짧은 주기가 실용적이다. */
export const MONITOR_PERIOD_SCOPED_MS = 15_000;
export const MONITOR_PERIOD_FULL_MS = 30_000;
/** 에러 백오프 상한 + 자동 종료 임계(연속 실패 횟수). */
export const MONITOR_MAX_BACKOFF_MS = 300_000;
export const MONITOR_FAIL_LIMIT = 5;

export type MonitorPausedReason = 'closed' | null;

export interface UseScreenerMonitorArgs {
  /** 모니터링 on/off(스토어 monitoringActive). */
  active: boolean;
  /** 선택 저장본 id — 변경되면 즉시 1회 재조회(재앵커). null 이면 루프 미가동. */
  selectedId: string | null;
  /** 선택 저장본의 스코프 유무 — 재조회 주기를 정한다. */
  scoped: boolean;
  /** 시드 안 됨 등 조회 불가 게이트. */
  disabled: boolean;
  /** 결과 코드 — 장 상태(phase)를 추가 요청 없이 얻기 위한 quotes 키(드로어와 동일). */
  resultCodes: string[];
  /** 1회 조회 + 결과 처리. 성공 true. 드로어의 수동 조회와 공유하는 단일 seam. */
  scanOnce: () => Promise<boolean>;
  /** 연속 MONITOR_FAIL_LIMIT 회 실패 시 호출 — 드로어가 모니터링을 끄고 피드백 표시. */
  onAutoStop: (message: string) => void;
}

export interface ScreenerMonitorStatus {
  /** 활성이지만 장마감이라 재조회를 멈춘 상태(표시용). */
  paused: MonitorPausedReason;
}

/**
 * 드로어 실시간 모니터링 루프. setInterval 이 아니라 응답 완료 후 chained setTimeout
 * 으로 다음 회차를 예약해 요청 겹침·배압 사고를 원천 차단한다(/live 딥백필 런어웨이
 * 교훈). 탭 비가시·장마감이면 재조회를 멈추고, 복귀/개장 시 재개한다. 에러는 지수
 * 백오프하고 연속 실패가 임계를 넘으면 자동 종료(침묵 사망 금지, ADR-0064).
 *
 * phase·scanOnce 는 ref 로 보관해 루프 effect 가 그 변화마다 재시작(타이머 리셋)되지
 * 않게 한다 — 재예약 트리거는 active/selectedId/disabled/scoped 뿐.
 */
export function useScreenerMonitor(args: UseScreenerMonitorArgs): ScreenerMonitorStatus {
  const { active, selectedId, scoped, disabled, resultCodes, scanOnce, onAutoStop } = args;
  const venue = useLiveVenueStore((s) => s.venue);
  // 드로어 내부 useScreenerRowsLive 와 동일 queryKey(codes+venue) → react-query 캐시
  // 공유, 추가 요청 0. 장 상태만 읽는다.
  const phase = useQuotes(resultCodes, venue).data?.phase;

  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const scanOnceRef = useRef(scanOnce);
  scanOnceRef.current = scanOnce;
  const onAutoStopRef = useRef(onAutoStop);
  onAutoStopRef.current = onAutoStop;

  useEffect(() => {
    if (!active || disabled || selectedId === null) return;

    const periodMs = scoped ? MONITOR_PERIOD_SCOPED_MS : MONITOR_PERIOD_FULL_MS;
    let timer: number | undefined;
    let cancelled = false;
    let failStreak = 0;

    const schedule = (ms: number) => {
      timer = window.setTimeout(tick, ms);
    };

    const tick = async () => {
      if (cancelled) return;
      // 게이트: 탭 숨김·장마감이면 조회를 건너뛰고 나중에 재확인만(무요청 no-op).
      if (document.hidden || phaseRef.current === 'closed') {
        schedule(periodMs);
        return;
      }
      const ok = await scanOnceRef.current();
      if (cancelled) return;
      if (ok) {
        failStreak = 0;
        schedule(periodMs);
        return;
      }
      failStreak += 1;
      if (failStreak >= MONITOR_FAIL_LIMIT) {
        onAutoStopRef.current('조회가 반복 실패해 실시간 모니터링을 종료했습니다.');
        return;
      }
      schedule(Math.min(periodMs * 2 ** failStreak, MONITOR_MAX_BACKOFF_MS));
    };

    // 시작·재앵커 즉시 1회 조회.
    void tick();

    // 탭 복귀 시 대기 타이머를 버리고 즉시 재조회 후 루프 재개.
    const onVisibility = () => {
      if (cancelled || document.hidden) return;
      window.clearTimeout(timer);
      void tick();
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [active, selectedId, scoped, disabled]);

  return { paused: active && phase === 'closed' ? 'closed' : null };
}
