import { useMemo } from 'react';
import { useQueries } from '@tanstack/react-query';

import { useOrderflowSourcePref } from '../state/sourcePreference';
import type { LiveDataWarning } from '../live/liveDataWarnings';
import type { LiveEffectiveSession } from '../api/livePastCandles';
import type { StudyViewReference } from '../api/studyViews';
import type { RangeBundle } from '../api/types';
import type { LiveTimeframe } from '../state/livePage';
import type { IndicatorSettings } from '../state/indicatorSettingsV2';
import type { LiveVenueOption } from '../state/liveVenue';
import { buildStudyReferenceBundleModel } from './studyReferenceBundleModel';
import { studyDailyContextWindow, type StudyDailyContextWindow } from './studyDailyContext';
import { STUDY_VENUE } from './studyVenuePolicy';
import { studyReferenceQueryOptions, studyReferenceQuerySettings } from './studyReferenceQueries';

function mergeStudyRangeBundles(
  hoga: RangeBundle | null,
  sidecars: RangeBundle | null,
): RangeBundle | null {
  if (!hoga) return sidecars;
  if (!sidecars) return hoga;
  return {
    ...hoga,
    ask_peaks: sidecars.ask_peaks ?? [],
    bid_peaks: sidecars.bid_peaks ?? [],
    broker_late_entries: sidecars.broker_late_entries ?? [],
    trade_volume_pocs: sidecars.trade_volume_pocs ?? [],
    depth_heatmap: sidecars.depth_heatmap ?? [],
    volume_distributions: sidecars.volume_distributions ?? [],
  };
}

// 복기뷰 캔들은 디스크 캡처(hogaplay + 스크리너 일봉)만 쓴다 — KIS rate-limit/지연 경고
// 채널이 없으므로 항상 빈 배열. RangeBundle의 data_warnings는 invariant 위반 타입이라
// KIS 지연 칩(LiveDataWarning)으로 표기하면 오해를 준다(디스크는 지연 개념이 없음).
const EMPTY_WARNINGS: LiveDataWarning[] = [];

/** 창 하나가 거는 4종 쿼리 중 아무거나 — `useQueries` 배열의 원소 타입. */
type StudyPlanQuery =
  ReturnType<typeof studyReferenceQueryOptions>[keyof ReturnType<typeof studyReferenceQueryOptions>];

/** 번들 한 벌을 요구하는 차트 창. 봉과 지표가 곧 쿼리 키라 둘 다 창에서 온다(#904). */
export type StudyReferenceWindowSpec = {
  windowId: string;
  timeframe: LiveTimeframe;
  indicators: IndicatorSettings;
};

export type StudyReferenceBundleResult = {
  bundle: RangeBundle | null;
  chartBundle: RangeBundle | null;
  isLoading: boolean;
  error: Error | null;
  pastDataWarnings: LiveDataWarning[];
  venue: LiveVenueOption;
  /** 이 창이 표시 중인 봉으로 덮어쓴 저장뷰 — 밴드·뷰포트 파생의 입력. */
  displayedSave: StudyViewReference | null;
  dailyContext: StudyDailyContextWindow;
};

/**
 * 차트 창마다 번들 한 벌 (#801 단계 1).
 *
 * 창이 여러 개면 봉도 여러 개고, 봉은 곧 쿼리 키다. 훅을 창 개수만큼 부를 수는
 * 없으므로(훅 순서) `useQueries` 로 **4 × N 쿼리를 한 배열**에 펴서 넣고 다시
 * 창별로 접는다 — `useWarmStudyReferenceTabQueries` 가 탭에 대해 쓰는 것과 같은 수법.
 *
 * **키가 같은 창끼리는 react-query 가 알아서 dedupe** 한다. 같은 봉·같은 지표 창을
 * 두 개 열어도 요청은 한 벌이다.
 *
 * venue 는 종목·창과 무관한 **상수**다(`STUDY_VENUE`) — 창별 저장뷰가 생겨 종목이
 * 갈리는 날에도 이 값은 갈리지 않는다. sourcePref 는 전역 설정이라 역시 한 번만 푼다.
 */
export function useStudyReferenceBundles(
  save: StudyViewReference | null,
  windows: readonly StudyReferenceWindowSpec[],
): Record<string, StudyReferenceBundleResult> {
  // 복기뷰는 **공유 venue 스토어를 읽지 않는다** — `/study` 는 항상 KRX 다
  // (`studyVenuePolicy`, ADR-0144). 여기 있던 스토어 읽기 + `useEffectiveVenue` 해석은
  // ADR-0140 §7.2 의 선택기 부활에 딸린 것이었고, 그 정책이 되돌려졌다.
  //
  // 코드별 해석(`effectiveLiveVenue`)도 함께 사라진다 — 그 규칙은 UN 을 KRX 로
  // 강등하는 것뿐이라 입력이 KRX 면 **항등**이다. 남겨 두면 하는 일 없는 훅 호출이
  // 여기 venue 가 아직 가변인 것처럼 읽히게 만든다.
  const venue = STUDY_VENUE;
  const sourcePref = useOrderflowSourcePref();

  const plans = useMemo(
    () => windows.map((win) => {
      const displayedSave = save ? { ...save, timeframe: win.timeframe } : null;
      const dailyContext = studyDailyContextWindow(displayedSave);
      // 펴는 것은 `studyReferenceQuerySettings` 한 곳에서만 한다 — 워밍 경로와 이
      // 경로가 같은 매핑을 손으로 반복하다 한쪽이 다른 봉의 지표를 읽었다(그 함수 주석).
      const options = studyReferenceQueryOptions(
        displayedSave,
        studyReferenceQuerySettings(win.indicators, sourcePref, venue),
        dailyContext,
      );
      return { win, displayedSave, dailyContext, options };
    }),
    [save, sourcePref, venue, windows],
  );

  // 창마다 [hoga, sidecars, candles, screenerDaily] 4개. 같은 봉·지표 창이 둘이면
  // **키가 완전히 같아지는데**, 그대로 `useQueries` 에 넣으면 react-query 가
  // `Duplicate Queries found` 를 경고한다(실측). 캐시는 어차피 키 하나를 공유하므로
  // 여기서 키로 접어 넘기고, 결과는 키→인덱스로 되짚는다.
  const { queries, slots } = useMemo(() => {
    const uniqueQueries: StudyPlanQuery[] = [];
    const indexByKey = new Map<string, number>();
    const take = (options: StudyPlanQuery): number => {
      const key = JSON.stringify(options.queryKey);
      const existing = indexByKey.get(key);
      if (existing !== undefined) return existing;
      const index = uniqueQueries.length;
      uniqueQueries.push(options);
      indexByKey.set(key, index);
      return index;
    };
    return {
      queries: uniqueQueries,
      slots: plans.map((p) => ({
        hoga: take(p.options.rangeHoga),
        sidecars: take(p.options.rangeSidecars),
        candles: take(p.options.rangeCandles),
        screenerDaily: take(p.options.screenerDaily),
      })),
    };
  }, [plans]);
  const results = useQueries({ queries });

  return useMemo(() => {
    const out: Record<string, StudyReferenceBundleResult> = {};
    plans.forEach((plan, i) => {
      const slot = slots[i];
      const pastHoga = results[slot.hoga];
      const pastSidecars = results[slot.sidecars];
      const rangeCandles = results[slot.candles];
      const screenerDaily = results[slot.screenerDaily];
      if (!pastHoga || !pastSidecars || !rangeCandles || !screenerDaily) return;

      const pastBundle = mergeStudyRangeBundles(
        (pastHoga.data as RangeBundle | undefined) ?? null,
        (pastSidecars.data as RangeBundle | undefined) ?? null,
      );
      const candleData = rangeCandles.data as RangeBundle | undefined;
      // 세션 경계: 캡처 meta의 정규장 경계(RangeSegment)를 effective session으로 주입.
      // 세그먼트가 없는 날짜는 모델의 venue 폴백이 처리.
      const sessions: LiveEffectiveSession[] = (candleData?.segments ?? []).map((s) => ({
        date: s.date,
        venue,
        open_ms: s.session_open_ms,
        close_ms: s.session_close_ms,
      }));
      const model = buildStudyReferenceBundleModel({
        save: plan.displayedSave,
        venue,
        pastBundle,
        rangeCandles: candleData?.candles ?? [],
        screenerDailyCandles:
          (screenerDaily.data as { candles?: never[] } | undefined)?.candles ?? [],
        sessions,
        dailyContext: plan.dailyContext,
      });

      out[plan.win.windowId] = {
        bundle: model.bundle,
        chartBundle: model.chartBundle,
        // 사이드카(최대벽·POC·거래량분포·프로그램매매)도 첫 커밋에 캔들과 함께 등장하도록
        // 풀스크린 게이트에 포함(개선안 1-C). 비활성 쿼리는 react-query v5에서 isLoading=false라
        // 분봉/캘린더 저장을 단일식으로 커버한다. data==null 조건: 에러/캐시 히트로
        // settle되면 즉시 열림.
        //
        // 여기 있던 "캘린더 봉은 rangeCandles 를 기다리지 않는다" 예외는 **사라졌다.**
        // 그 예외는 캘린더 봉이 1분봉 36,000개를 받던 시절, 화면을 스크리너로 먼저
        // 그리기 위한 것이었다. 이제 캘린더 봉은 그 쿼리를 **아예 걸지 않으므로**
        // (`studyReferenceQueryInputs`) 기다릴 것이 없고, 술어는 항상 false 인
        // 죽은 코드가 됐다. 같은 목적이 예외가 아니라 구조로 달성된 셈이다:
        //   분봉    = pastHoga + rangeCandles + sidecars   (screenerDaily 비활성)
        //   D/W/M   = screenerDaily                        (나머지 셋 비활성)
        isLoading:
          pastHoga.isLoading ||
          rangeCandles.isLoading ||
          screenerDaily.isLoading ||
          (pastSidecars.isLoading && pastSidecars.data == null),
        error: (pastHoga.error
          ?? rangeCandles.error
          ?? screenerDaily.error
          ?? pastSidecars.error
          ?? null) as Error | null,
        pastDataWarnings: EMPTY_WARNINGS,
        venue,
        displayedSave: plan.displayedSave,
        dailyContext: plan.dailyContext,
      };
    });
    return out;
  }, [plans, results, slots, venue]);
}
