/**
 * **디스크로 읽는 분봉 창의** 미캡처 거래일을 키움으로 보충할 요청 계획.
 *
 * 소비자는 둘이다 — 얼린 저장뷰(`frozenRangeFrom`)와 창별 hogaplay 소스
 * (`hogaplaySourceEnabled`, 2026-08-22 합류). 계획 규칙은 같지만 **창의 성질이
 * 다르다**: 저장뷰는 구간이 얼어 있고 hogaplay 토글은 좌측 팬을 따라 자란다.
 * 그 차이가 아래 {@link MAX_GAP_FILL_DATES} 의 트림 방향에서 실제로 드러난다.
 *
 * 두 창 다 디스크(hogaplay)를 읽으므로(`useLiveBundle` 의 `restBypassEnabled`),
 * 캡처되지 않은 거래일은 차트에서 **그냥 사라진다.** 그 날짜 목록은 백엔드가 이미
 * `/api/range` 응답의 `missing_dates` 로 내려주고 있고, 그것은 **거래일 달력 기반**이라
 * 주말·공휴일을 구멍으로 오인하지 않는다. 이 모듈은 그 목록을 **벤더에 물어볼 요청
 * 구간**으로 바꾸는 일만 한다.
 *
 * 백엔드에서 그 목록을 만드는 곳이 **둘**이다(`hoga/api/bundle.py`): 캡처 흔적이 전혀
 * 없는 날(`uncaptured_trading_days`)과, 파일은 있으나 업스트림 만료 스텁이라 쓸 수 없는
 * 날(`is_expired_upstream_stub`, 2026-08-24 합류). 뒤쪽은 **재캡처가 영구히 막힌**
 * 클래스라 이 모듈이 유일한 복구 경로다 — 그전까지 그 날짜들은 `excluded_dates` 로만
 * 가서 여기 닿지 않았고, 화면에서 사유 없이 사라졌다.
 *
 * ## 왜 요청을 좁혀야 하나 — 이 모듈의 존재 이유
 *
 * 백엔드 walk 는 요청 구간 안의 **가장 최신 미캐시일**에서 커서를 시작해 가장 오래된
 * 날까지 뒤로 민다(`live_candle_backfill._walk_pending`). 오늘에 앵커되지 않는다.
 * 키움 1콜 = 900행 ≈ 2.35 거래일이므로:
 *
 * - 8개월 전 5일짜리 구멍을 **그 구간으로 좁혀** 요청 → 약 2~3콜
 * - 같은 구멍을 `from=구멍 … to=오늘` 로 요청 → 그 사이 전부가 pending → 수십 콜
 *
 * 즉 이 계획 함수가 곧 성능 설계다. 구간을 좁히는 것 외에 다른 최적화는 필요 없다.
 *
 * ## 왜 구멍을 **묶는가**, 그리고 왜 무한정 묶지 않는가
 *
 * 한 콜이 어차피 인접 2~3거래일을 함께 실어 오므로 가까운 구멍은 한 요청으로 묶는 편이
 * 싸다. 반대로 멀리 떨어진 구멍까지 한 구간으로 묶으면 **그 사이의 이미 캡처된 날짜**가
 * 벤더 pending 에 들어간다 — 디스크에 있는 것을 키움에서 다시 받는 낭비다. 그래서
 * {@link RUN_MERGE_GAP_DAYS} 안쪽만 묶는다.
 *
 * ## 이 계획이 **원리적으로 채울 수 없는 것**
 *
 * 키움 분봉 보유는 롤링이고 그 하한은 **약 13개월**이다({@link KIWOOM_MINUTE_RETENTION_DAYS}
 * 의 실측표 — 코드베이스가 적어 온 "1년" 보다 넓다). 그보다 오래된 구멍은 요청해도
 * **200 + 빈 배열 + 경고 0** 이 온다. 조용히 아무 일이 없다는 뜻이라, 화면이 "채우는
 * 중" 이라고 거짓말하지 않으려면 그 판정이 요청 **전**에, 즉 계획 단계에 있어야 한다.
 *
 * 실측(2026-08-21): 한 종목의 캡처 477일 중 **312일이 250일 벽 밖**(최고 20240827)이다.
 * 기존 저장뷰 구멍의 큰 몫은 이 기능으로 채워지지 않는다.
 */
import type { RangeMissingDate } from '../api/types';
import { subtractDaysKst } from './liveDateTime';

/** 한 번의 `/api/live/past-candles` 요청으로 처리할 구간. */
export interface GapFillRun {
  /** 요청 `from` — 이 run 의 가장 오래된 구멍 날짜. */
  from: string;
  /** 요청 `to` — 이 run 의 가장 최신 구멍 날짜. 백엔드 walk 의 커서 시작점이 된다. */
  to: string;
  /** 이 run 이 채우려는 거래일들(오름차순). 응답에서 이 날짜만 취한다. */
  dates: readonly string[];
}

export interface GapFillPlan {
  /** 요청할 구간들 — **최신 run 이 먼저**. */
  runs: readonly GapFillRun[];
  /** 키움 보유(1년) 밖이라 요청하지 않는 날짜들. 안내 문구가 이 개수를 쓴다. */
  unfillable: readonly string[];
  /** 총량 상한에 걸려 이번 계획에서 빠진 날짜들. */
  deferred: readonly string[];
}

/**
 * 키움 분봉 보유 기간(일) — **실측값**이다.
 *
 * 코드베이스가 오래 적어 온 "1년 롤링"(#1008)은 보수적이었다. 2026-08-21 실측
 * (005930, 5거래일씩 프로브):
 *
 * | 오늘로부터 | 봉 수 | 소요 |
 * |---|---|---|
 * | 354일 전 | 1,910 | — |
 * | 368일 전 | 1,910 | — |
 * | **382일 전** | **1,910** | 2,276ms |
 * | **400일 전** | **0** | 77ms |
 * | 410일 전 | 0 | 133ms |
 *
 * 경계는 382~400일 사이 — 약 13개월이다. 1년(365)으로 자르면 **살아 있는 2~3주를
 * 버린다.** 380 은 그 경계 안쪽에서 최대한 넓게 잡되, 롤링이 매일 하루씩 미는 것을
 * 감안한 며칠의 여유다.
 *
 * ⚠ **보유 밖 응답은 200 + 빈 배열 + 경고 0 이다**(위 표의 77ms 행). 즉 요청해도
 * 조용히 아무 일이 없다 — 그래서 "못 채운다" 를 화면이 말하려면 그 판정이 요청 전,
 * 이 상수 위에 있어야 한다. 비용은 작지만(walk 진행 보장 가드가 즉시 멈춘다) 유량
 * 버킷은 그대로 1 을 소비한다.
 */
export const KIWOOM_MINUTE_RETENTION_DAYS = 380;

/**
 * 구멍 사이 간격이 이 캘린더 일수 이하면 한 run 으로 묶는다.
 *
 * 5일 = 주말 하나를 건너뛴 인접 거래일까지는 묶고, 그 이상 떨어지면 나눈다는 뜻이다.
 * 900행/콜이 2.35거래일을 덮으므로 이 폭 안의 병합은 **콜을 늘리지 않으면서** 요청 수를
 * 줄인다. 더 넓히면 그 사이 캡처된 날짜가 벤더 pending 으로 새어 들어간다.
 */
export const RUN_MERGE_GAP_DAYS = 5;

/**
 * 한 창이 한 번에 보충할 거래일 총량 상한.
 *
 * 저장뷰는 구간이 고정이라 "가시 범위" 가드가 실효가 없다 — 대신 총량을 막는다. 백엔드
 * 자체 예산(`_max_fresh_dates_per_collect`, 1분 기준 12일)이 그 아래에서 다시 나눠 주므로
 * 이 상한은 **요청 수의 상한**이지 벤더 유량의 상한이 아니다.
 *
 * ## ⚠ 창이 자라는 소비자에서는 **최신 쪽만 채워진다** (알려진 한계)
 *
 * 초과분은 아래에서 **오래된 쪽부터** `deferred` 로 잘린다. 저장뷰에서는 그게 맞다
 * (차트가 우측부터 보인다). 창별 hogaplay 소스에서는 좌측으로 팬할수록 구멍이 앞에
 * 쌓이므로, 총 구멍이 40일을 넘어가면 **사용자가 보고 있는 왼쪽 끝이 유예되는** 방향이
 * 된다.
 *
 * 그런데도 방향을 뒤집지 않는다: 백엔드 예산 트림이 `pending[-fresh_budget:]` 로 같은
 * 방향이라(아래 트림 주석) 여기서만 뒤집으면 **두 트림이 서로 다른 쪽을 잘라 아무것도
 * 완결되지 않는다.** 제대로 고치려면 계획이 가시 범위를 입력으로 받아야 하는데, 그건
 * 이 훅이 뷰포트를 모른다는 층 구분을 바꾸는 일이라 별건이다.
 *
 * 유예된 개수는 `deferredCount` 로 올라간다 — 화면이 "다 채웠다" 고 말하지 않는 것이
 * 지금 지키는 선이다.
 */
export const MAX_GAP_FILL_DATES = 40;

/**
 * 한 요청이 담을 수 있는 거래일 수 — **1분 기준**. 실효값은 `bucketMs` 배수다.
 *
 * ## 이 상수가 없으면 넓은 구멍이 절반만 채워진다
 *
 * 백엔드는 collect 당 **새로 가져올 날짜 수에 예산**을 건다
 * (`LiveMinuteCandleBackfill._max_fresh_dates_per_collect = 12`, 1분 기준이고
 * `_fresh_budget_for` 가 tic_scope 분 수를 곱한다). 초과분은 봉 없이
 * `fetch_budget_exhausted`(blocking) 경고로 유예되고, 백엔드는 **"프론트가 박제하지
 * 않으므로 다음 사이클에 이어서 받는다"** 를 회복 계약으로 삼는다 — 좌측 팬 경로가
 * 청크를 ~11 거래일로 자르는 이유가 그것이다.
 *
 * **이 훅의 커서는 run 을 한 번만 지나간다.** 그래서 그 계약을 지킬 방법이 청크뿐이다.
 * 안 자르면 27거래일 run 이 최신 12일만 채우고 조용히 끝나며, 안내는 나머지를 "보충도
 * 되지 않았습니다" 로 **거짓 보고**한다.
 *
 * 실측(2026-08-21, 005930, 20251001~20251107 한 요청): `fresh_dates` **12** ·
 * `fetch_budget_exhausted` **10건**(오래된 쪽) · 봉은 12일치만.
 *
 * 10 인 이유: 예산 12 에 2일 여유다. run 은 구멍 날짜만 묶지만 백엔드 pending 은
 * `from~to` **범위 안 모든 미캐시 거래일**이라, 주말을 건너뛰며 병합된 run 은 사이에
 * 낀 거래일만큼 pending 이 더 많다.
 */
export const MAX_DATES_PER_RUN_1MIN = 10;

/** `20260821` → `Date`(UTC 자정). 캘린더 일수 차이 계산 전용. */
function toUtcDate(yyyymmdd: string): Date {
  return new Date(Date.UTC(
    Number(yyyymmdd.slice(0, 4)),
    Number(yyyymmdd.slice(4, 6)) - 1,
    Number(yyyymmdd.slice(6, 8)),
  ));
}

/** 캘린더 일수 차이(b - a). 둘 다 YYYYMMDD. */
function calendarDaysBetween(a: string, b: string): number {
  return Math.round((toUtcDate(b).getTime() - toUtcDate(a).getTime()) / 86_400_000);
}

/**
 * 보충 대상이 되는 결손 사유.
 *
 * `not_captured`(아직 캡처 안 함)와 `no_upstream_data`(hogaplay 가 그날을 통째로 못 줌 —
 * 센티넬이든 만료 스텁이든) **둘 다** 캔들은 벤더에서 다시 받을 수 있다 — 소급 불가인
 * 것은 호가 파생 지표뿐이다.
 * 반면 `venue_unsupported`/`source_missing` 류는 그 시장·그 소스에 애초에 없다는 뜻이라
 * 키움 KRX 분봉으로 대신할 성질이 아니다(그렇게 채우면 NXT 차트에 KRX 봉이 섞인다).
 */
const FILLABLE_REASONS: ReadonlySet<string> = new Set(['not_captured', 'no_upstream_data']);

/**
 * 미캡처 거래일 목록 → 벤더 요청 계획.
 *
 * 순수 함수다. 훅(`useMinuteGapFill`)이 이 결과를 순차로 소비한다.
 */
export function planMinuteGapFill(args: {
  missingDates: readonly RangeMissingDate[] | undefined;
  /** 기준일(KST). 이 날짜와 이후는 대상이 아니다 — 오늘분은 실시간 경로가 소유한다. */
  todayKstYyyymmdd: string;
  /**
   * 벤더에 요청할 봉 주기(ms). **청크 크기를 정하는 값이다** — 백엔드 예산이
   * tic_scope 분 수에 비례하므로(`_fresh_budget_for`) 10분 요청은 한 번에 10배 넓은
   * 구간을 완결할 수 있다. 미지정이면 1분(가장 좁은 쪽)으로 본다.
   */
  bucketMs?: number;
  retentionDays?: number;
  maxDates?: number;
}): GapFillPlan {
  const {
    missingDates,
    todayKstYyyymmdd,
    bucketMs = 60_000,
    retentionDays = KIWOOM_MINUTE_RETENTION_DAYS,
    maxDates = MAX_GAP_FILL_DATES,
  } = args;
  if (!missingDates || missingDates.length === 0) {
    return { runs: [], unfillable: [], deferred: [] };
  }

  const floor = subtractDaysKst(todayKstYyyymmdd, retentionDays);
  const fillable: string[] = [];
  const unfillable: string[] = [];
  // YYYYMMDD 는 사전식 비교가 곧 날짜 순서다.
  for (const m of [...missingDates].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))) {
    if (!FILLABLE_REASONS.has(m.reason)) continue;
    if (m.date >= todayKstYyyymmdd) continue;
    if (m.date < floor) {
      unfillable.push(m.date);
      continue;
    }
    fillable.push(m.date);
  }

  // 총량 상한은 **최신 쪽을 남긴다** — 차트는 우측(최신)부터 보이고, 백엔드의 예산
  // 트림도 같은 방향이다(`pending[-fresh_budget:]`). 방향이 어긋나면 유예분이 서로
  // 다른 쪽을 잘라 아무것도 완결되지 않는다.
  const deferred = fillable.length > maxDates ? fillable.slice(0, fillable.length - maxDates) : [];
  const targets = deferred.length > 0 ? fillable.slice(fillable.length - maxDates) : fillable;

  // 백엔드 예산 안에서 **한 요청이 완결되도록** 자른 청크 크기. 배수가 1 미만으로
  // 내려가지 않게 하한을 둔다(알 수 없는 bucketMs 는 1분으로 수렴 — 조여질지언정
  // 넓어지지 않는 방향, `_fresh_budget_for` 의 같은 규율).
  const perRun = Math.max(1, MAX_DATES_PER_RUN_1MIN * Math.max(1, Math.floor(bucketMs / 60_000)));

  const runs: GapFillRun[] = [];
  let current: string[] = [];
  const flush = () => {
    if (current.length > 0) runs.push(...chunkRun(current, perRun));
    current = [];
  };
  for (const date of targets) {
    if (current.length === 0) {
      current = [date];
      continue;
    }
    if (calendarDaysBetween(current[current.length - 1], date) <= RUN_MERGE_GAP_DAYS) {
      current.push(date);
      continue;
    }
    flush();
    current = [date];
  }
  flush();

  // 최신 run 부터 요청한다 — 사용자가 보고 있을 확률이 높은 쪽이 먼저 채워진다.
  runs.reverse();
  return { runs, unfillable, deferred };
}

/**
 * 한 연속 구간을 예산 크기 청크로 자른다. 입력·출력 모두 오름차순.
 *
 * **뒤(최신)에서부터 자른다.** 앞에서 자르면 나머지 조각이 마지막(=최신)에 놓여
 * 첫 요청이 가장 적게 가져온다 — 사용자가 보고 있는 쪽이 제일 늦게 완성된다.
 */
function chunkRun(dates: readonly string[], perRun: number): GapFillRun[] {
  const out: GapFillRun[] = [];
  for (let end = dates.length; end > 0; end -= perRun) {
    const slice = dates.slice(Math.max(0, end - perRun), end);
    out.push({ from: slice[0], to: slice[slice.length - 1], dates: slice });
  }
  out.reverse();
  return out;
}

/** run 을 react-query 키·진행 상태에 쓸 안정 문자열로. */
export function gapFillRunKey(run: GapFillRun): string {
  return `${run.from}-${run.to}`;
}
