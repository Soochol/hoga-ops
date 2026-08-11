/** 「거래대금 추이」 — 코스피·코스닥 일별 거래대금. 통계 타일 2개 + 배경 추이.
 *
 * **컴팩트 판정 2차의 승자**(STAT, 2026-08-10 사용자 확정). 1차에서 축 분리 2단으로
 * 냈던 316px 카드를 **98px 로** 줄인 것이다(−69%, 페이지 1353→1135px).
 *
 * ── 왜 배경인가 ─────────────────────────────────────────────────────────────
 *
 * 이 카드가 답하는 질문은 "**지금 얼마이고 평소보다 많은가 적은가**" 다. 그 답은
 * 전부 숫자이고, 추이는 그 숫자를 뒷받침하는 **질감**이면 충분하다. 그래서 차트를
 * 값 아래 블록으로 쌓지 않고 뒤에 깔아 레이아웃 높이를 0 으로 만들고, 남은 공간을
 * 차트가 아니라 **값이** 가져간다 — 카드가 가장 작은데 숫자는 가장 크다.
 *
 * **컴팩트 3안을 실측으로 비교해 골랐다.** 셋 다 실데이터·같은 자리에서 쟀다:
 *
 *   STAT     98px  차트 종횡비 16:1   ← 채택
 *   ROW     112px           46:1      두 시장이 같은 눈높이에 오지만 선이 직선이 된다
 *   OVERLAY 168px           19:1      가독성은 최고나 47%밖에 못 줄고 읽기 규칙이 는다
 *   (현행)  316px           18:1
 *
 * 반직관적인 결과가 판정을 갈랐다: **가장 작은 안의 차트가 가장 덜 찌그러졌다.**
 * 타일을 가로로 반씩 나누면 폭도 같이 줄어(1656→822px) 높이가 52px 여도 종횡비가
 * 현행보다 낫다. 반대로 ROW 는 전폭 1457px × 32px 라 46:1 이고, 130일 스윙이 4~5배인
 * 계열에서도 평상시 ±10% 진동이 1~2px 로 사라졌다.
 *
 * 대가는 분명하다: **배경은 읽는 그림이 아니다.** 축도 날짜도 없고, 두 타일의 세로
 * 스케일이 각자 min/max 라 타일 간 높이 비교는 무의미하다. 그 비교가 필요해지면
 * 이 안이 아니라 OVERLAY(정규화)로 가야 한다.
 *
 * ── 축 전략과 무관하게 남는 두 가지 정직성 ──────────────────────────────────
 *
 * **① 당일 점은 미완성이다.** 확정일은 15:30 까지의 최종값이고 당일 점은 지금까지의
 * 누적이라, 09:30 에 보면 절벽처럼 떨어진다. 배경으로 밀려나도 마지막 구간은 점선이고
 * (`TrendBackdrop`), **기준 평균에서도 당일을 뺀다** — 안 빼면 미완성 값이 분모에
 * 섞여 "평소보다 적다" 가 자기 실현된다.
 *
 * **② 당일 점은 `/sectors` 로 덮되 날짜가 같을 때만.** `/trade-value` TTL 이 10분이라
 * 당일 점이 그만큼 낡는데, 같은 값을 `/sectors` 가 30초 + 0U WS 틱으로 이미 들고 있다.
 * 두 TR 이 같은 축이라는 것은 실측했다(2026-08-10: ka20006 `20260810` 코스피
 * 188,401.96억 = ka20003 종합 행 `trade_value_eok`). **날짜가 같을 때만** 덮는 이유는
 * 장 마감 후 자정을 넘기면 `/sectors` 가 아직 어제 값을 들고 있을 수 있어서다 —
 * 그걸 오늘 점에 쓰면 조용히 하루가 밀린다.
 */
import { useState } from 'react';
import {
  useMarketSectors,
  useMarketTradeValue,
  type TradeValuePoint,
} from '../api/market';
import { todayKstYyyymmdd } from '../live/liveDateTime';
import { TrendBackdrop } from './marketBits';
import { CardHeader, EmptyNote, MarketCard, ModeSwitch } from './marketCardBits';
import { MARKET_LABELS, SERIES_COLORS, eokToJoText } from './marketFormat';
import { priceDirClass } from '../ui/priceDir';

const SPANS = [
  ['20', '20일'],
  ['60', '60일'],
  ['120', '120일'],
] as const;
type Span = (typeof SPANS)[number][0];

/** 시장 축 색. 방향색(`--price-up/down`)을 쓰지 않는 이유는 `marketBits` 상단 주석과
 *  같다 — 거래대금엔 방향이 없고, 방향색을 쓰면 "빨간 건 많아서인가 올라서인가" 가
 *  모호해진다. 방향색은 **평소 대비 퍼센트**만 진다. */
const MARKET_COLORS: Record<string, string> = {
  KOSPI: SERIES_COLORS.deposit,
  KOSDAQ: SERIES_COLORS.arb,
};

const MARKETS = ['KOSPI', 'KOSDAQ'] as const;

/** 당일을 **뺀** 최근 n일 평균. 표본이 없으면 `null`(0 이 아니다 — 모른다).
 *
 * **`n` 은 화면 기간 토글과 같은 값이다**(2026-08-11 사용자 지시로 전환. 그전까지는
 * 20일 고정이었다). 고정의 논거는 "토글이 기준을 움직이면 같은 날의 '평소 대비' 가
 * 보는 창에 따라 달라진다" 였는데, 그건 **라벨이 20일에 못박혀 있을 때만** 모순이다.
 * 라벨이 창을 따라가면 세 토글은 서로를 반증하는 세 답이 아니라 **세 개의 다른
 * 질문**이다 — "최근 한 달 대비 오늘" 과 "최근 반년 대비 오늘" 은 둘 다 참이고 둘 다
 * 쓸모가 있다.
 *
 * ⚠ 따라서 **퍼센트와 헤더 힌트는 한 몸이다.** 둘 중 하나만 창을 따라가는 순간
 * 위가 경고한 자기모순으로 정확히 되돌아간다. */
function baselineEok(points: TradeValuePoint[], n: number): number | null {
  const past = points.slice(0, -1).slice(-n);
  if (past.length === 0) return null;
  return past.reduce((acc, p) => acc + p.value_eok, 0) / past.length;
}

function mmdd(date: string): string {
  return `${Number(date.slice(4, 6))}/${Number(date.slice(6, 8))}`;
}

function Tile({
  label,
  color,
  points,
  base,
}: {
  label: string;
  color: string;
  /** **화면 창**으로 자른 배열 — 배경 추이가 그리는 범위다. */
  points: TradeValuePoint[];
  /** 기준 평균. **화면 창과 같은 길이**로, 당일만 빼고 부모가 계산해 넘긴다. */
  base: number | null;
}) {
  const last = points[points.length - 1].value_eok;
  const vsBase = base ? ((last - base) / base) * 100 : null;
  return (
    // 높이를 px 로 박지 않는다 — 내용(두 줄)이 정하게 두면 밀도 다이얼(root
    // font-size)을 그대로 따라간다. 배경은 `absolute inset-0` 이라 높이에 기여하지
    // 않으므로 이 타일의 높이는 정의상 글자 높이다.
    <div className="relative overflow-hidden rounded-md px-sm py-2xs">
      <TrendBackdrop values={points.map((p) => p.value_eok)} color={color} />
      <div className="relative flex flex-col">
        <span className="flex flex-wrap items-baseline gap-x-2xs">
          <span
            aria-hidden="true"
            className="inline-block h-[2px] w-[10px] self-center"
            style={{ background: color }}
          />
          <span className="text-xs text-fg-dim">{label}</span>
          <span className="font-data text-xl font-semibold text-fg tabular-nums">
            {eokToJoText(last)}
          </span>
          <span className={`font-data text-sm tabular-nums ${priceDirClass(vsBase ?? 0)}`}>
            {vsBase == null ? '—' : `${vsBase > 0 ? '+' : ''}${vsBase.toFixed(0)}%`}
          </span>
        </span>
        {/* 배경에서 값을 읽을 수 없으므로 기준을 **글자로** 준다 — 이게 없으면
            퍼센트가 무엇 대비인지 카드 안에 근거가 없다. */}
        <span className="font-data text-2xs text-fg-dim tabular-nums">
          평소 {eokToJoText(base)}
        </span>
      </div>
    </div>
  );
}

export function TradeValueCard() {
  const [span, setSpan] = useState<Span>('20');
  const days = Number(span);
  // **기준 표본은 화면 창보다 하루 더 필요하다.** `days=span` 으로 받으면 20일 창에서
  // 당일을 뺀 뒤 19개만 남아, 라벨은 "20일 평균" 인데 값은 19일 평균이 된다(#1268 이
  // 실측으로 잡은 off-by-one: 32.68조 vs 32.63조). 기준 창이 토글을 따라가게 바뀐
  // 뒤에도 이 **+1 은 그대로 남는다** — 표본 수를 라벨과 맞추는 것이 그 목적이라
  // 라벨이 움직이든 말든 필요하다.
  //
  // 그래서 하나 더 받고 **표시만 창으로 자른다.** 벤더 콜은 안 는다 — 백엔드가
  // 최대 창(250일)을 캐시하고 라우트가 자르므로 `days` 는 응답 길이만 정한다.
  const tv = useMarketTradeValue(days + 1);
  const sectors = useMarketSectors();

  const today = todayKstYyyymmdd();
  const live: Record<string, number | null> = {
    KOSPI: sectors.data?.markets['0']?.index?.trade_value_eok ?? null,
    KOSDAQ: sectors.data?.markets['1']?.index?.trade_value_eok ?? null,
  };

  const tiles = MARKETS.map((name) => {
    const raw = tv.data?.markets[name];
    if (!raw || raw.length < 2) return { name, points: null, base: null };
    const fresh = live[name];
    const lastIdx = raw.length - 1;
    const full =
      fresh != null && raw[lastIdx].date === today
        ? [...raw.slice(0, lastIdx), { ...raw[lastIdx], value_eok: fresh }]
        : raw;
    // 기준과 표시가 **같은 창**이다 — 표시는 당일을 포함한 span 개, 기준은 당일을
    // 뺀 span 개(그래서 기준 표본이 표시 구간보다 하루 더 앞에서 시작한다).
    return { name, points: full.slice(-days), base: baselineEok(full, days) };
  });

  // 날짜 범위는 **헤더에 한 번만** 적는다 — 두 타일이 같은 창을 보므로 타일마다
  // 적으면 같은 글자가 두 번 나온다(프로토타입 1차에서 드러났다).
  const shown = tiles.find((t) => t.points)?.points;
  const range = shown ? `${mmdd(shown[0].date)}–${mmdd(shown[shown.length - 1].date)}` : '일별';
  // 퍼센트의 분모가 토글을 따라가므로 **이 문구도 같이 따라간다**(`baselineEok`
  // docstring 의 ⚠). 한쪽만 움직이면 라벨이 값을 반증한다.
  const hint = `${range} · ${span}일 평균 대비 · 끝점은 당일`;

  return (
    <MarketCard className="flex flex-col gap-2xs p-md">
      <CardHeader
        title="거래대금 추이"
        hint={hint}
        right={<ModeSwitch value={span} onChange={setSpan} options={SPANS} label="거래대금 기간" />}
      />
      {shown === undefined ? (
        // 로딩과 실패를 같은 문구로 덮지 않는다 — 이 페이지의 규율(#1102 파일 주석).
        <EmptyNote>
          {tv.isLoading ? '거래대금 이력을 불러오는 중입니다.' : '거래대금 이력을 받지 못했습니다.'}
        </EmptyNote>
      ) : (
        <div className="grid grid-cols-2 gap-md">
          {tiles.map(({ name, points, base }) =>
            points ? (
              <Tile
                key={name}
                label={MARKET_LABELS[name]}
                color={MARKET_COLORS[name]}
                points={points}
                base={base}
              />
            ) : (
              // 한 시장만 실패하면 **그 칸만** 말한다 — 칸을 비우면 남은 타일이 폭을
              // 두 배로 먹어 레이아웃이 바뀌고, 원인도 흐려진다(백엔드가 실패한
              // 시장의 키를 뺀다).
              <EmptyNote key={name}>{MARKET_LABELS[name]} 이력을 받지 못했습니다.</EmptyNote>
            ),
          )}
        </div>
      )}
    </MarketCard>
  );
}
