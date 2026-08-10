/** 「거래대금 추이」 — 코스피·코스닥 일별 거래대금, 축 분리 2단.
 *
 * 프로토타입 3안(축 분리 / 누적 영역 / 정규화) 중 **축 분리 채택**(2026-08-10 사용자
 * 확정). 판정 근거와 탈락한 두 안의 실측치는 아래에 남긴다 — 브랜치는 보존하지 않는다.
 *
 * **왜 축을 나누나.** 두 시장은 규모가 3~4배 다르다(130일 실측: 코스피 18.8~80.3조 ·
 * 코스닥 4.5~23.2조). 한 축에 겹치면 코스닥이 바닥에 눌려 그 변화가 통째로 안 읽힌다.
 * 대가는 **두 선의 높이를 비교할 수 없다**는 것이고, 그래서 각 단이 절대값과
 * "20일 평균 대비 %" 를 글자로 들고 있다.
 *
 * **탈락 ① 누적 영역**(합계·구성비를 한 번에): 코스닥 비중이 27%인데도 0 기준 +
 * 60일 최대 92.5조 스케일 때문에 띠 두께가 **중앙값 13.9px**(최소 7.6px)로 눌렸다.
 * 합계를 얻는 대신 두 시장 중 하나를 잃는 교환이라 기각.
 * **탈락 ② 정규화**(각자 20일 평균=100%): 규모가 달라도 두 선을 직접 비교할 수 있는
 * 유일한 안이었지만 차트에서 조·억이 사라진다. 그 비교가 답하는 질문("어느 쪽이 더
 * 달아올랐나")은 이 카드가 이미 **숫자로** 답한다 — 채택안 헤더의 `평소 대비 %` 다.
 *
 * ── 이 카드가 지키는 두 가지 정직성 ─────────────────────────────────────────
 *
 * **① 당일 점은 미완성이다.** 확정일은 15:30 까지의 최종값이고 당일 점은 지금까지의
 * 누적이라, 09:30 에 보면 라인이 절벽처럼 떨어진다. 마지막 구간을 점선 + 속빈 마커로
 * 그리고(`LevelLineChart provisional`), **기준 평균에서도 당일을 뺀다** — 안 빼면
 * 미완성 값이 분모에 섞여 "평소보다 적다" 가 자기 실현된다.
 *
 * **② 당일 점은 `/sectors` 로 덮는다.** `/trade-value` 의 TTL 은 10분이라 당일 점이
 * 그만큼 낡는데, 같은 값을 `/sectors` 가 30초 + 0U WS 틱으로 이미 들고 있다. 두 TR 이
 * 같은 축이라는 것은 실측했다(2026-08-10: ka20006 `20260810` 코스피 188,401.96억 =
 * ka20003 종합 행 `trade_value_eok`). **날짜가 같을 때만 덮는다** — 장 마감 후 자정을
 * 넘기면 `/sectors` 가 아직 어제 값을 들고 있을 수 있고, 그걸 오늘 점에 쓰면 조용히
 * 하루 밀린다.
 */
import { useState } from 'react';
import {
  useMarketSectors,
  useMarketTradeValue,
  type TradeValuePoint,
} from '../api/market';
import { todayKstYyyymmdd } from '../live/liveDateTime';
import { LevelLineChart } from './marketBits';
import { CardHeader, EmptyNote, MarketCard, ModeSwitch } from './marketCardBits';
import { MARKET_LABELS, SERIES_COLORS, eokToJoText } from './marketFormat';

const SPANS = [
  ['20', '20일'],
  ['60', '60일'],
  ['120', '120일'],
] as const;
type Span = (typeof SPANS)[number][0];

/** 기준 평균의 창. **화면 기간 토글과 독립이다** — 토글로 같이 움직이면 같은 날의
 *  "평소 대비" 가 보는 창에 따라 달라져서 두 값이 서로를 반증한다. */
const BASELINE_DAYS = 20;

/** 시장 축 색. 방향색(`--price-up/down`)을 쓰지 않는 이유는 `marketBits` 상단 주석과
 *  같다 — 거래대금엔 방향이 없고, 방향색을 쓰면 "빨간 건 많아서인가 올라서인가" 가
 *  모호해진다. */
const MARKET_COLORS: Record<string, string> = {
  KOSPI: SERIES_COLORS.deposit,
  KOSDAQ: SERIES_COLORS.arb,
};

const MARKETS = ['KOSPI', 'KOSDAQ'] as const;

/** 당일을 **뺀** 최근 N일 평균. 표본이 없으면 `null`(0 이 아니다 — 모른다). */
function baselineEok(points: TradeValuePoint[], n: number): number | null {
  const past = points.slice(0, -1).slice(-n);
  if (past.length === 0) return null;
  return past.reduce((acc, p) => acc + p.value_eok, 0) / past.length;
}

function mmdd(date: string): string {
  return `${Number(date.slice(4, 6))}/${Number(date.slice(6, 8))}`;
}

function Pane({ label, color, points }: { label: string; color: string; points: TradeValuePoint[] }) {
  const last = points[points.length - 1];
  const base = baselineEok(points, BASELINE_DAYS);
  const vsBase = base ? ((last.value_eok - base) / base) * 100 : null;
  return (
    <div className="flex flex-col gap-2xs">
      <div className="flex flex-wrap items-baseline gap-x-xs gap-y-2xs">
        <span
          aria-hidden="true"
          className="inline-block h-[2px] w-[10px] self-center"
          style={{ background: color }}
        />
        <span className="text-xs font-semibold text-fg-dim">{label}</span>
        <span className="font-data text-base font-semibold text-fg tabular-nums">
          {eokToJoText(last.value_eok)}
        </span>
        {vsBase != null && (
          <span className="font-data text-2xs text-fg-dim tabular-nums">
            {BASELINE_DAYS}일 평균 {eokToJoText(base)} 대비 {vsBase > 0 ? '+' : ''}
            {vsBase.toFixed(0)}%
          </span>
        )}
      </div>
      <LevelLineChart values={points.map((p) => p.value_eok)} color={color} baseline={base} />
      <div className="flex justify-between font-data text-2xs text-fg-dim tabular-nums">
        <span>{mmdd(points[0].date)}</span>
        <span>{mmdd(last.date)}</span>
      </div>
    </div>
  );
}

export function TradeValueCard() {
  const [span, setSpan] = useState<Span>('60');
  // 창을 바꿔도 **같은 쿼리 키가 아니다** — 백엔드가 최대 창을 캐시하므로 벤더 콜은
  // 늘지 않고, 프론트 캐시만 창별로 갈린다(각 창이 자기 길이를 받는다).
  const tv = useMarketTradeValue(Number(span));
  const sectors = useMarketSectors();

  const today = todayKstYyyymmdd();
  const live: Record<string, number | null> = {
    KOSPI: sectors.data?.markets['0']?.index?.trade_value_eok ?? null,
    KOSDAQ: sectors.data?.markets['1']?.index?.trade_value_eok ?? null,
  };

  const panes = MARKETS.map((name) => {
    const raw = tv.data?.markets[name];
    if (!raw || raw.length < 2) return { name, points: null };
    // 당일 점 덮어쓰기 — 날짜가 오늘일 때만(파일 상단 ②).
    const fresh = live[name];
    const lastIdx = raw.length - 1;
    const points =
      fresh != null && raw[lastIdx].date === today
        ? [...raw.slice(0, lastIdx), { ...raw[lastIdx], value_eok: fresh }]
        : raw;
    return { name, points };
  });

  const anyData = panes.some((p) => p.points !== null);

  return (
    <MarketCard className="flex flex-col gap-sm p-md">
      <CardHeader
        title="거래대금 추이"
        hint="일별 · 마지막 점은 당일(진행 중)"
        right={<ModeSwitch value={span} onChange={setSpan} options={SPANS} label="거래대금 기간" />}
      />
      {!anyData ? (
        // 로딩과 실패를 같은 문구로 덮지 않는다 — 이 페이지의 규율(#1102 파일 주석).
        <EmptyNote>
          {tv.isLoading ? '거래대금 이력을 불러오는 중입니다.' : '거래대금 이력을 받지 못했습니다.'}
        </EmptyNote>
      ) : (
        panes.map(({ name, points }) =>
          points ? (
            <Pane key={name} label={MARKET_LABELS[name]} color={MARKET_COLORS[name]} points={points} />
          ) : (
            // 한 시장만 실패하면 **그 시장만** 말한다. 두 단을 함께 지우면 살아 있는
            // 쪽까지 사라져 원인이 흐려진다(백엔드가 실패한 시장의 키를 뺀다).
            <EmptyNote key={name}>{MARKET_LABELS[name]} 거래대금 이력을 받지 못했습니다.</EmptyNote>
          ),
        )
      )}
    </MarketCard>
  );
}
