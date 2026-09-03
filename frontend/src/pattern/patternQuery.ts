import { create } from 'zustand';

import type { PatternTimeframe } from '../api/screener';
import type { LiveTimeframe } from '../state/livePage';

/**
 * 차트 → 패턴 패널로 **구간 하나를 건네는** 시드 슬롯 (ADR-0166).
 *
 * `measure` 로 봉을 긋고 "이 봉들로 패턴 찾기" 를 누르면 그 구간이 여기 실리고,
 * 패널이 열리며 한 번 읽어 간다.
 *
 * ## 1회 소비다
 *
 * 패널이 읽으면 즉시 비운다. 사용자가 착지 후 봉수 스테퍼를 만졌을 때, 리렌더가
 * 일어났다는 이유로 화면을 그 구간으로 **되돌리면 안 된다** — `/live` 의 `?code=`
 * 시드와 저장뷰 딥링크(`useSavedRangeDeepLink` 의 `seeded` ref)가 같은 규칙이다.
 *
 * ## 영속하지 않는다
 *
 * `SavedRangeFocus` 가 비영속인 것과 같은 결이다: 차트에서 명시적으로 그은 구간이지
 * 새로고침으로 복원할 상태가 아니다.
 *
 * ## 드로어의 로컬 state 를 여기로 올리지 않는다
 *
 * 모드·봉수는 패널 안에서만 의미가 있어 드로어의 `useState` 로 남는다. 전부 스토어로
 * 올리면 "차트가 건넨 것" 과 "패널이 들고 있는 것" 의 경계가 사라진다.
 */
export type PatternQuerySeed = {
  code: string;
  label?: string;
  /** YYYYMMDD. 백엔드가 이 구간의 봉 수를 **길이로** 삼는다(`lengths` 무시). */
  from: string;
  to: string;
  /** 그은 창의 봉 단위. **이 값이 없으면 구간이 어느 코퍼스의 것인지 알 수 없다** —
   *  주봉 5개를 그은 날짜 범위를 일봉으로 세면 20봉대가 되어 다른 질문에 답한다
   *  (#1715 가 고친 결함이 정확히 그것이다). */
  timeframe: PatternTimeframe;
};

/**
 * 패턴 검색이 성립하는 timeframe — **서버 코퍼스가 있는 것뿐이다**(일봉·주봉).
 *
 * ⚠ 「분봉이 아닌가」로 물으면 안 된다. 두 질문은 일·주·월이 전부이던 시절 답이 같았고,
 * 지금도 타입·테스트를 통과하지만 주봉·월봉에서 **조용히 틀린 답**을 낸다: 봉 수 검증은
 * 화면의 집계 봉(주/월)을 세는데 서버로 가는 것은 날짜뿐이라, `_resolve_window` 가
 * 그 구간을 **일봉 봉수**로 다시 센다. 실측(삼성전자) — 주봉 5개를 그으면 서버가
 * 「일봉 ~20봉 패턴」에 답하고 화면에는 **그럴듯한 결과가 뜬다**. 주봉 10개·월봉은
 * 상한(30봉)을 넘겨 빈 결과가 되는데 그 빈 화면은 "이력이 없다" 로 읽힌다.
 *
 * 그래서 게이트는 **허용 집합을 직접** 쓴다. 여집합(`!isMinute`)으로 물으면 새 멤버가
 * 자동으로 통과하고 회귀 테스트가 원리적으로 없다 — 주봉이 코퍼스를 갖기 전까지 정확히
 * 그 상태였다. 월봉은 아직 코퍼스가 없다.
 */
export function isPatternSearchableTimeframe(tf: LiveTimeframe): tf is PatternTimeframe {
  return tf === 'D' || tf === 'W';
}

/** 최소 봉수 — 서버 `PATTERN_MIN_BARS` 의 짝. 이보다 짧으면 요청을 만들지 않는다. */
export const PATTERN_MIN_BARS = 5;
/** 최대 봉수 — 서버 `PATTERN_CEILING` 의 짝. 길수록 응답이 길어지고, 드래그 경로는
 *  요청이 길이를 말하지 않아 서버의 `lengths` 검증이 걸리지 않는다(실측: 33봉이
 *  상한을 우회해 24.7초). 여기서 먼저 막아 사용자가 기다리지 않게 한다. */
export const PATTERN_MAX_BARS = 30;

/**
 * `measure` 두 끝 → 시드. **못 만들 이유가 있으면 `null`** 이고, 호출부는 그때
 * 아무 일도 하지 않는다(버튼 자체를 안 그리거나 눌러도 조용하다).
 *
 * 막는 것 셋:
 * * 종목이 없거나 지수 창 — 코퍼스에 계열이 없다.
 * * 코퍼스가 없는 창(분봉·월봉) — `isPatternSearchableTimeframe` 이 허용 집합을 쥔다.
 * * 5봉 미만 / 30봉 초과 — 서버가 빈 결과로 답하는데 그 빈 화면은 "이력이 없다" 로
 *   읽혀 원인을 숨긴다. 실패를 만들 수 있는 입력은 만들기 전에 막는다.
 *
 * ⚠ timeframe 을 **값으로** 받는다. 호출부가 「분봉인가」 같은 파생 boolean 을 계산해
 * 넘기면 그 판정이 두 곳에 생기고, 한쪽만 낡아도 여기서는 보이지 않는다.
 */
export function patternSeedFromRange(args: {
  code: string | null;
  label?: string;
  timeframe: LiveTimeframe;
  candleTsMs: readonly number[];
  aRealMs: number;
  bRealMs: number;
  toYyyymmdd: (ms: number) => string;
}): PatternQuerySeed | null {
  const { code, timeframe, candleTsMs, aRealMs, bRealMs, toYyyymmdd } = args;
  if (!code || !isPatternSearchableTimeframe(timeframe)) return null;
  const [lo, hi] = aRealMs <= bRealMs ? [aRealMs, bRealMs] : [bRealMs, aRealMs];
  const bars = candleTsMs.filter((ts) => ts >= lo && ts <= hi).length;
  if (bars < PATTERN_MIN_BARS || bars > PATTERN_MAX_BARS) return null;
  return { code, label: args.label, from: toYyyymmdd(lo), to: toYyyymmdd(hi), timeframe };
}

type Store = {
  pending: PatternQuerySeed | null;
  /** 차트에서 호출 — 구간을 싣는다. 패널 열기는 호출부가 따로 한다(레일 스토어 소관). */
  requestPatternSearch: (seed: PatternQuerySeed) => void;
  /** 패널에서 호출 — 있으면 돌려주고 **비운다**. */
  consumePatternQuery: () => PatternQuerySeed | null;
};

export const usePatternQueryStore = create<Store>((set, get) => ({
  pending: null,
  requestPatternSearch: (seed) => set({ pending: seed }),
  consumePatternQuery: () => {
    const seed = get().pending;
    if (seed) set({ pending: null });
    return seed;
  },
}));
