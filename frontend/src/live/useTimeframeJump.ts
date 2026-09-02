/**
 * 기간 점프의 **소비 배선** — 판정과 수식은 `chart/timeframeJump.ts` 가 갖고, 여기서는
 * 그것을 창의 **데이터 창 우단**(기준일)으로 옮긴다.
 *
 * 발행 쪽에는 훅이 없다. 점프는 제스처를 추적하는 것이 아니라 **버튼 한 번**이라
 * 스토어 액션(`requestTimeframeJump`)을 직접 부르면 끝이다.
 *
 * ── 왜 착지 코드가 없는가 — 이 훅은 「어디를 보나」가 아니라 「무엇을 받나」다 ──
 *
 * 종전 구현은 창의 페치 구간이 `[from, **오늘**]` 로 고정된 것을 전제로, 목적지가
 * 그 창에 들어올 때까지 `from` 을 스텝 단위로 걸어 내리고(최대 60스텝) 캔들이 도착할
 * 때마다 그 칸의 마지막 봉을 찾아 뷰포트를 앉혔다. 두 달 전으로 점프하면 **목적지와
 * 오늘 사이 전 구간의 분봉**을 받아야 했다 — 사용자가 보지도 않을 데이터다.
 *
 * 지금은 창의 **우단을 목적지로 옮긴다**(`asOfDate`). 그러면 첫 요청이 곧바로
 * `[목적지−청크, 목적지]` 로 나가 한 왕복에 끝나고, **데이터의 오른쪽 끝이 곧 목적지**가
 * 되므로 착지는 차트의 초기 배치가 그대로 한다 — 뷰포트를 미는 코드가 필요 없다.
 * 그 재배치를 유발하는 것이 `viewSeg` 이고(창의 `viewIdentity` 에 섞이면 차트가
 * remount 된다), 이는 저장뷰 칩 × 가 라이브 복귀를 겸하는 것과 **같은 경로**다.
 *
 * 함께 사라진 것: 백필 목표(`backfillFromDate`) · 착지 재시도 · seq 래치 · 중단
 * (`aborted`)과 ↻. 래치와 중단은 "백필을 기다리는 동안 사용자가 팬하면 뒤늦게
 * 끌려간다" 를 막던 장치인데, 기다림 자체가 한 왕복으로 줄어 그 창이 닫혔다.
 *
 * ── 수명: 이 창이 종목을 바꾸면 풀린다 ──────────────────────────────────
 * 점프는 「그 종목의 그 날」을 여는 명령이라, 창이 그리는 종목이 갈리면 명령의 절반이
 * 사라진다. 그래서 × 와 같은 자리에서 자동으로 풀린다 — 근거와 함정(게이트가 답하는
 * 질문이 다르다 · 렌더 단계 · A→B→A)은 `useMinuteJumpTarget` 안의 그 절에 있다.
 *
 * ── 좌측 팬은 그대로 산다 ────────────────────────────────────────────────
 * 우단만 고정하고 `from` 은 자유다. 그래서 `planPastCandlesDelta` 의
 * `canReusePrevious` 경로(`requestTo = previous.from − 1`)가 종전과 똑같이 왼쪽
 * 청크를 이어붙인다 — 저장뷰 얼림(`frozenRangeFrom`)과 갈리는 지점이 여기다.
 * 저쪽은 시작일까지 고정해 백필을 멈추지만, 점프는 "어디서부터 보나" 를 정하지 않는다.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLiveCursorStore } from './useLiveCursorStore';
import { realMsToYyyymmdd } from './liveDateTime';
import { resolveTimeframeJump } from '../chart/timeframeJump';
import type { LiveTimeframe } from '../state/livePage';
import { useHistoricalRangeActions } from './workspace/windowView';

/**
 * 이 분봉 창에 걸린 점프의 화면 상태 — 칩이 읽는다.
 *
 * 넷이 각각 **사용자가 할 수 있는 일**로 갈린다:
 *  - `seeking` — 기다리면 온다(그 구간을 받는 중).
 *  - `landed` — 도착했다. 칩은 돌아갈 문으로만 남는다.
 *  - `no-data` — 받아 왔는데 그 구간에 봉이 없다. 기다려도 안 온다.
 *  - `out-of-retention` — 이 창의 하한 밖이라 **영영** 안 온다.
 *
 * 마지막 둘을 `seeking` 에 뭉치면 칩이 영원히 "불러오는 중" 을 표시한다 — 침묵보다
 * 나쁜 종류의 거짓말이다. 그리고 그 둘끼리도 갈라야 한다: 하한 밖은 **다른 날짜를
 * 고르라**는 뜻이고, 봉이 없는 것은 그 날 시장이 그랬다는 뜻이라 대안이 다르다.
 */
export type MinuteJumpState = {
  /**
   * 칩이 말할 KST 날짜(YYYYMMDD).
   *
   * `landed` 면 **실제로 그려진 마지막 봉의 날짜**이고, 그 전에는 목적지 칸의 상한이다.
   * 둘을 구별하는 이유(#1506): 상한은 **칸의 달력상 끝**이라 비거래일일 수 있다(주봉
   * 칸이면 일요일). 착지한 뒤에도 그 날짜를 계속 말하면 **차트가 보여주지 않는 날을
   * 이름 붙이는 칩**이 된다 — 실측 2026-08-23: 주봉 상한 08-23(일)인데 착지는 08-21.
   */
  date: string;
  status: 'seeking' | 'landed' | 'no-data' | 'out-of-retention';
  /**
   * `out-of-retention` 일 때 **이 창이 불러올 수 있는 가장 이른 날**(YYYYMMDD).
   *
   * 상수로 적던 「보유 기간(13개월)」을 대신한다. 그 문구는 모드에 따라 틀렸다 —
   * 벤더 벽은 두 겹(span 캡 · 실보유)이고 디스크 모드는 캡처가 있는 만큼이다.
   * 값을 상태가 나르면 세 모드에서 모두 맞는다.
   */
  floorDate?: string;
};

/**
 * 칩에 그릴 상태 — **데이터 훅 뒤에서** 부른다(하한·로딩을 알아야 한다).
 *
 * 순수 함수인 이유: 이 판정의 입력 넷이 서로 다른 훅에서 나와(점프 슬롯 · 번들의
 * 하한 · 쿼리의 로딩 · 캔들 배열) 한 훅 안에 모을 수 없다. 판정만 떼면 소비처가
 * 어디서 부르든 같은 답을 낸다.
 */
export function minuteJumpChipState(args: {
  /** 이 창에 걸린 점프의 목적지 날짜. `null` = 점프 없음. */
  date: string | null;
  /** 이 창이 불러올 수 있는 가장 이른 날. `null` = 모름 — **막지 않는다**. */
  floorDate: string | null;
  /** 과거 캔들을 불러오는 중인가. */
  isLoading: boolean;
  /**
   * 이 창이 그리고 있는 **마지막 봉의 KST 날짜**. `null` = 봉이 없다.
   *
   * 「봉이 있는가」와 「착지 날짜」를 **한 값으로** 받는다. 둘을 따로 받으면 어긋날 수
   * 있고, 어긋나는 쪽이 곧 #1506 이다 — 칩이 차트에 없는 날짜를 말하는 상태.
   */
  lastCandleDate: string | null;
}): MinuteJumpState | null {
  const { date, floorDate, isLoading, lastCandleDate } = args;
  if (date === null) return null;
  // 하한이 `null`(디스크 모드·미측정)이면 막지 않는다 — 모르는 것을 못 간다고
  // 말하지 않는다.
  if (floorDate !== null && date < floorDate) {
    return { date, status: 'out-of-retention', floorDate };
  }
  if (isLoading) return { date, status: 'seeking' };
  if (lastCandleDate === null) return { date, status: 'no-data' };
  // ⚠ **착지하면 목적지가 아니라 앉은 봉의 날짜를 말한다**(#1506) — 타입 도크스트링의
  // 그 이유다. 우단이 목적지가 됐어도 그 날이 거래일이 아니면 마지막 봉은 그 앞이다.
  return { date: lastCandleDate, status: 'landed' };
}

export type MinuteJumpTarget = {
  /**
   * 이 창의 **데이터 창 우단**(YYYYMMDD). `null` = 평소의 라이브 창.
   *
   * `useLiveChartData` 의 `asOfDate` 로 그대로 넘어가 그 훅의 "오늘" 이 된다.
   * 목적지가 **오늘 이후**면 `null` 이다 — 그때는 라이브 창이 이미 그 자리이고,
   * 기준일을 세우면 SSE 만 끊겨 실시간이 죽는다.
   */
  asOfDate: string | null;
  /** 칩이 말할 목적지(오늘로 클램프). 점프 없으면 `null`. */
  date: string | null;
  /**
   * 창의 `viewIdentity` 에 섞을 조각. 값이 갈리면 차트가 remount 되고 초기 배치가
   * 다시 적용된다 — **착지가 일어나는 자리**다.
   *
   * `seq` 를 섞는 이유: 같은 목적지로 다시 눌러도 다시 착지해야 한다(종전 ↻ 의
   * 역할). 목적지만 섞으면 두 번째 누름이 값 동일로 묻힌다.
   */
  viewSeg: string | null;
  /** 칩의 × — 이 창만 점프에서 풀고 라이브로 돌아간다. */
  clear: () => void;
};

/**
 * 이 창에 걸린 점프 → 기준일. **데이터 훅보다 위에서** 부른다.
 *
 * 순환을 피하려고 칩 상태와 갈라져 있다: 기준일은 데이터 훅의 **입력**이고 칩 상태는
 * 그 **출력**(하한·로딩)을 읽는다. 한 훅에 두면 자기 출력을 자기 입력으로 먹는다.
 */
export function useMinuteJumpTarget(params: {
  /** 기능 게이트 + 이 봉이 점프를 받는가. 꺼져 있으면 구독도 하지 않는다. */
  enabled: boolean;
  myWindowId: string | null;
  myTimeframe: LiveTimeframe;
  myGroup: number | null;
  myCode: string | null;
  allowCrossSymbol: boolean;
  /**
   * 이 창이 지금 그리는 종목의 **정체성 키**(예: `stock:005930` · `index:KOSPI`).
   * 값이 갈리면 이 창의 점프를 푼다 — 아래 「종목이 갈리면」 절.
   *
   * `myCode` 와 **따로 받는다**. 두 값이 답하는 질문이 다르기 때문이다(그 절 참조)
   * 이고, 모양도 다르다 — `myCode` 는 지수 창에서 `null` 이라
   * (`WindowViewValue.code` 의 계약) 그것으로 재면 KOSPI→KOSDAQ 교체가 이 축에
   * 아예 안 보인다. `kind` 를 접두로 붙이는 것은 `'005930'` 인 지수와 주식이
   * 생기더라도 두 창이 섞이지 않게 하기 위해서다.
   *
   * **`null` 도 값이다** — 여기로 갈리면 점프가 풀린다. 이 값은
   * `windowSymbolOf`(`win.pinned ?? groupSymbols[win.group] ?? null`)의 순수 파생이라
   * 일시적 `null` 이 끼는 경로가 없고, 실제로 `null` 이 되는 둘(핀 해제 + 그룹 종목
   * 없음 · 미배정 그룹으로 이동)은 스토어가 이미 fresh-view 로 다루는 **진짜 변경**이다.
   * 그래서 `null` 을 예외로 빼면 오히려 그 둘에서만 점프가 살아남는다.
   */
  mySymbolKey: string | null;
  /**
   * 실제 오늘(KST). 목적지 상한을 여기로 클램프한다 — 주·월 칸의 상한은 **달력상의
   * 칸 끝**이라 미래일 수 있고(8월 칸 → 08-31), 미래를 우단으로 보내면 백엔드가
   * 422(`DATE_IN_FUTURE`)를 낸다.
   */
  todayKst: string;
}): MinuteJumpTarget {
  const {
    enabled, myWindowId, myTimeframe, myGroup, myCode, allowCrossSymbol, mySymbolKey, todayKst,
  } = params;
  const jumpRequest = useLiveCursorStore((s) => s.jumpRequest);
  const historicalRange = useHistoricalRangeActions();

  // 이 창이 추종을 시작한 시점의 명령 번호. 이보다 큰 것만 본다 — 슬롯에 남아 있던
  // 옛 명령을 새로 연 창이 적용하면 그 창의 초기 뷰 배치와 싸운다(기간 동기화의
  // baseline 과 같은 규율).
  const baselineSeqRef = useRef<number | null>(null);
  if (baselineSeqRef.current === null) {
    baselineSeqRef.current = useLiveCursorStore.getState().jumpRequest?.seq ?? 0;
  }

  // 사용자가 × 로 푼 명령. 슬롯을 지우지 않는 이유: 슬롯은 그룹 공용이라 지우면
  // **다른 분봉 창의 칩까지** 사라진다. 해제는 창의 로컬 사실이다.
  // (해제는 문이 둘이다 — 종목 변경으로 푸는 쪽은 아래 `symbolDismissedSeqRef`.)
  const [dismissedSeq, setDismissedSeq] = useState<number | null>(null);

  // 이 창이 **따를 자격이 있는** 명령. 종목 축은 아직 보지 않는다 — 그 판정은
  // 자격이 아니라 유효기간이라 아래에서 따로 한다.
  const candidate = useMemo(() => {
    if (!enabled) return null;
    const resolved = resolveTimeframeJump({
      publication: jumpRequest, myWindowId, myTimeframe, myGroup, myCode, allowCrossSymbol,
    });
    if (!resolved) return null;
    if (resolved.seq <= (baselineSeqRef.current ?? 0)) return null;
    if (resolved.seq === dismissedSeq) return null;
    return resolved;
  }, [
    enabled, jumpRequest, myWindowId, myTimeframe, myGroup, myCode, allowCrossSymbol, dismissedSeq,
  ]);

  // ── 종목이 갈리면 이 창의 점프를 푼다 ──────────────────────────────────────
  //
  // 위 게이트(`resolveTimeframeJump`)의 종목 조건은 **다른 질문에 답한다** — 「발행자와
  // 내 종목이 같은가」(수신 **자격**)이지 「받은 뒤 내가 바뀌었는가」(**유효기간**)가
  // 아니다. 흔한 경우에 두 답이 우연히 같아서 오래 구별되지 않았는데, 그 게이트는
  // `cursorSyncCrossSymbol`(⚙️ 차트, **공장 켬**)이 통째로 끈다. 그래서 기본 설정에서는
  // 종목을 바꿔도 기준일이 그대로 남았다 — 새 종목의 분봉 창이 옛 날짜에 고정된 채 뜨고,
  // `asOfDate` 가 서 있으면 `useLiveChartData` 가 라이브 구독을 `useLiveSeries('')` 로
  // 끊으므로 **실시간이 조용히 죽는다**. 칩이 남는 것은 그 상태의 표시일 뿐이다.
  //
  // 워크스페이스의 「종목 교체 = fresh-view」 리셋(`setGroupSymbol`)이 이걸 못 잡는 이유는
  // 그것이 `ChartWindowRuntime` 만 비우기 때문이다 — 점프는 전역 커서 슬롯과 이 훅의
  // 로컬 상태에 살아서 그 컨테이너 **밖**이다. 그 계약을 이 훅 쪽으로 가져온다.
  //
  // ⚠ **렌더 단계에서 판정한다.** effect 로 미루면 `asOfDate` 가 한 커밋 늦게 내려가
  // 새 종목이 옛 기준일로 한 번 페치했다 버린다(요청 낭비 + 화면 깜빡임) — 이 훅이
  // `useLiveChartData` **위에서** 불리는 것과 정확히 같은 이유다. `baselineSeqRef` 가
  // 이미 쓰는 idiom 이고, 종목 변경은 그 자체가 재렌더라 상태로 승격할 필요도 없다.
  //
  // ⚠ **비교가 아니라 «해제»다.** 앵커와 지금 종목을 매 렌더 비교만 하면 A→B→**A** 로
  // 돌아왔을 때 값이 다시 같아져 칩이 되살아난다. 갈린 순간 그 seq 를 푼 것으로 못
  // 박는다 — × 와 같은 성질(창의 로컬 사실)이라 **슬롯은 건드리지 않는다**.

  /** 지금 따르는 명령과 **그것을 받았을 때의 종목**. 이 짝이 곧 유효기간의 기준선이다. */
  const jumpAnchorRef = useRef<{ seq: number; symbolKey: string | null } | null>(null);
  /** 종목이 갈려 푼 명령. `dismissedSeq`(×)와 층은 같고 트리거만 다르다. */
  const symbolDismissedSeqRef = useRef<number | null>(null);

  if (candidate === null) {
    jumpAnchorRef.current = null;
  } else if (candidate.seq !== symbolDismissedSeqRef.current) {
    const anchor = jumpAnchorRef.current;
    if (anchor === null || anchor.seq !== candidate.seq) {
      jumpAnchorRef.current = { seq: candidate.seq, symbolKey: mySymbolKey };
    } else if (anchor.symbolKey !== mySymbolKey) {
      symbolDismissedSeqRef.current = candidate.seq;
      jumpAnchorRef.current = null;
    }
  }

  const live = candidate !== null && candidate.seq !== symbolDismissedSeqRef.current
    ? candidate
    : null;

  // 칸의 **포함 상한**을 오늘로 클램프한 것이 목적지다. 칸 시작(`fromMs`)은 쓰지
  // 않는다 — 종전엔 그것이 백필 목표였지만, 이제 창이 우단에서 왼쪽으로 자라므로
  // 시작일을 지정할 이유가 없다(지정하면 좌측 팬을 얼리는 저장뷰가 된다).
  const date = live === null
    ? null
    : (() => {
      const upper = realMsToYyyymmdd(live.toMs);
      return upper > todayKst ? todayKst : upper;
    })();
  // 목적지가 오늘이면 데이터 레버를 세우지 않는다 — 라이브 창이 이미 그 구간이고,
  // 세우면 SSE 구독만 끊겨 실시간이 조용히 죽는다. 착지는 `viewSeg` 가 여전히
  // 하므로(remount → 초기 배치 = 라이브 엣지) 「오늘로 되돌리는 점프」도 동작한다.
  const asOfDate = date !== null && date < todayKst ? date : null;
  const viewSeg = live === null || date === null ? null : `jd=${date}#${live.seq}`;

  // 창의 백필 시작일을 리셋한다 — 기준일이 서고 풀릴 때마다.
  //
  // ⚠ **이것이 없으면 두 방향으로 어긋난다.** ① 좌팬으로 깊어진 시작일이 남으면 ×
  // 로 라이브에 돌아왔을 때 그 깊이를 그대로 다시 요청한다. ② 점프로 들어갈 때는
  // 시작일이 기준일보다 **나중**일 수 있어(팬한 적 없는 창은 오늘−5거래일쯤)
  // `from > to` 가 된다. ②는 `useLiveBundle` 의 seed 계산이 원리적으로도 막지만
  // (기준일보다 나중인 시작일은 무시), 스토어에 죽은 값을 남기지 않는 것이 이쪽이다.
  //
  // ⚠ **마운트에서는 부르지 않는다.** deps 만으로 걸면 첫 커밋에서도 발화해 창이
  // 복원한 시작일(워크스페이스 persist)을 지운다 — 점프와 무관한 창까지 매번
  // 초기 폭으로 되돌아간다. 그래서 "값이 실제로 갈렸는가" 를 ref 로 따로 센다.
  const prevAsOfRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const prev = prevAsOfRef.current;
    prevAsOfRef.current = asOfDate;
    if (prev === undefined || prev === asOfDate) return;
    historicalRange.reset();
  }, [asOfDate, historicalRange]);

  const clear = useCallback(() => {
    if (live === null) return;
    setDismissedSeq(live.seq);
  }, [live]);

  return { asOfDate, date, viewSeg, clear };
}
