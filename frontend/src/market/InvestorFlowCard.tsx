/** 투자자 수급 카드 — 주식 2 + 파생 7 을 **한 선택기**로 갈아 끼운다.
 *
 * 프로토타입 판정 A+T2(2026-08-07). 두 대안을 실데이터 밀도에서 나란히 보고 고른 것이다:
 * B(7상품 동시 보드)는 상품 간 관계를 보여 주지만 카드 하나를 통째로 먹었고,
 * C(주체 × 상품 매트릭스)는 시계열을 잃었다. A 는 카드 수를 안 늘리는 대신 한 번에
 * 상품 하나만 본다 — "한 번에 궁금한 상품은 하나" 라는 전제다.
 *
 * 선택기는 T2(단일 세그먼트 + 군 구분선)다. 계층으로 접는 T1 도 후보였지만 클릭이
 * 2번이 된다. **군 구분선은 트랙 안쪽 1px** 이다 — 밖에 두면 세그먼트가 세 덩어리로
 * 쪼개져 "그룹이 셋" 이 아니라 "컨트롤이 셋" 으로 읽힌다.
 *
 * ## 주식과 파생은 같은 카드지만 같은 데이터가 아니다
 *
 * | | 벤더 | 수집 창 | 일별 확정 | 축 |
 * |---|---|---|---|---|
 * | 주식 | 키움 ka10051 | **09:00–16:30** | 있음(`base_dt` 소급) | 억원 고정 |
 * | 파생 | KIS FHPTJ04030000 | **09:00–15:45** | **없음** | 억원 **또는 계약** |
 *
 * 주식 창이 정규장(15:30)보다 넓은 것은 오타가 아니다 — 종가 단일가(15:20–15:30)는
 * 체결이 15:30 에 일괄로 나는데, 정규장에서 닫으면 그 체결분이 통째로 빠진다(실측
 * 2026-08-10: 코스피 기관 장중 마지막 +6,619억 → 확정 +3,635억). **두 창 다 응답에서
 * 받는다**(`session_end_sec`) — 여기 숫자를 다시 적으면 조용히 갈린다.
 *
 * 그래서 파생을 고르면 「일별」 토글이 사라진다. 있지도 않은 경로를 버튼으로 만들어
 * 두면 눌러 보고 나서야 빈 화면을 만나게 된다.
 *
 * 축이 갈리는 이유는 벤더가 파생 대금 단위를 말해 주지 않기 때문이다. 백엔드가 값에서
 * 역산하는데(2중 검산) 장 초반처럼 판정이 안 서면 억원이 통째로 null 로 온다. 그때
 * **계약 축으로 그리고 그 사실을 헤더가 말한다** — 억지로 환산하면 그게 #1117 이다.
 */
import { useState } from 'react';
import {
  useMarketDerivFlow,
  useMarketInvestorFlow,
  type DerivFlowProduct,
  type InvestorFlowPoint,
} from '../api/market';
import {
  ComboNetChart,
  LegendItem,
  SessionAxisLabels,
  SessionLinesChart,
} from './marketBits';
import { CardHeader, EmptyNote, MarketCard, ModeSwitch } from './marketCardBits';
import { SERIES_COLORS } from './marketFormat';

const MARKET_LABELS: Record<string, string> = { KOSPI: '코스피', KOSDAQ: '코스닥' };

/** epoch ms → KST 자정 기준 초. 세션축 x 위치 계산용. */
function kstSecOfDay(tMs: number): number {
  const kst = new Date(tMs + 9 * 3600_000);
  return kst.getUTCHours() * 3600 + kst.getUTCMinutes() * 60 + kst.getUTCSeconds();
}

/** 선택 하나 = 주식 시장 키(응답의 `markets` 키) 또는 파생 상품 키(`fid_input_iscd_2`). */
type Selection = string;

const STOCK_KEYS = ['KOSPI', 'KOSDAQ'] as const;

/**
 * 선택기 군 — `fid_input_iscd` 축 그대로다. 벤더가 이미 그어 둔 선이라 "왜 이렇게
 * 묶였나" 를 따로 설명할 필요가 없다.
 *
 * **상품 키만 여기 두고 라벨은 응답에서 받는다**(`products[key].label`). 백엔드
 * 상품표가 SSOT 이고, 여기 라벨을 복제하면 상품이 늘거나 이름이 바뀔 때 조용히 갈린다.
 * 응답이 아직 없을 때만 폴백 라벨을 쓴다 — 골격은 표본이 없어도 오지만 로딩 첫 프레임엔
 * 비어 있다.
 */
const GROUPS: { key: string; keys: readonly string[]; fallback: Record<string, string> }[] = [
  { key: 'stock', keys: STOCK_KEYS, fallback: MARKET_LABELS },
  {
    key: 'K2I',
    keys: ['F001', 'OC01', 'OP01'],
    fallback: { F001: '선물', OC01: '콜옵션', OP01: '풋옵션' },
  },
  {
    key: 'MKI',
    keys: ['F004', 'OC02', 'OP02'],
    // **군 라벨이 없는 평평한 선택기라 접두를 뗄 수 없다.** T1(2단)에서는 1단이 이미
    // "미니" 라고 말하니 뗄 수 있었지만, 여기서 떼면 K2I 와 MKI 가 둘 다
    // "선물 콜옵션 풋옵션" 이 되어 구분이 사라진다(프로토타입에서 실제로 그렇게 났다).
    fallback: { F004: '미니선물', OC02: '미니콜옵션', OP02: '미니풋옵션' },
  },
  { key: '999', keys: ['S001'], fallback: { S001: '주식선물' } },
];

const SEG_BASE = 'whitespace-nowrap px-2 py-[2px] font-data text-2xs tabular-nums';
const SEG_ON = 'bg-tint-selection text-accent';
const SEG_OFF = 'text-fg-dim hover:bg-bg-input-hover';

function isStock(sel: Selection): boolean {
  return (STOCK_KEYS as readonly string[]).includes(sel);
}

function FlowPicker({
  value,
  onChange,
  products,
}: {
  value: Selection;
  onChange: (v: Selection) => void;
  products: Record<string, DerivFlowProduct>;
}) {
  return (
    <div
      role="group"
      aria-label="수급 대상"
      className="inline-flex overflow-hidden rounded-lg bg-bg-subtle"
    >
      {GROUPS.flatMap((g, gi) => [
        ...(gi > 0
          ? [<span key={`d${gi}`} className="my-[3px] w-px shrink-0 bg-border" aria-hidden="true" />]
          : []),
        ...g.keys.map((key) => {
          const on = key === value;
          return (
            <button
              key={key}
              type="button"
              aria-pressed={on}
              onClick={() => onChange(key)}
              className={`${SEG_BASE} ${on ? SEG_ON : SEG_OFF}`}
            >
              {products[key]?.label ?? g.fallback[key] ?? key}
            </button>
          );
        }),
      ])}
    </div>
  );
}

export function InvestorCard() {
  const [sel, setSel] = useState<Selection>('KOSPI');
  const [mode, setMode] = useState<'intraday' | 'daily'>('intraday');
  const stock = useMarketInvestorFlow();
  const deriv = useMarketDerivFlow();

  const stockSel = isStock(sel);
  // 일별은 주식 전용이다 — 파생을 고른 채 남아 있던 'daily' 가 파생 화면을 빈 칸으로
  // 만들지 않도록 렌더 시점에 접는다(상태를 되돌리면 주식으로 돌아왔을 때 선택이 리셋된다).
  const showDaily = stockSel && mode === 'daily';

  const products = deriv.data?.products ?? {};
  const product = stockSel ? undefined : products[sel];
  const units = deriv.data?.units;
  const derivEok = deriv.data?.unit === 'amt_eok';

  const hint = (() => {
    if (stockSel) {
      // 선택된 시장의 커버리지 — 두 시장을 합치면 분자가 2배가 된다(#1247 후속).
      const cov = stock.data?.coverage?.[sel];
      // 확정본이 나오면 시계열 끝에 확정점이 붙으므로(백엔드) 「잠정」 은 그때부터
      // 거짓말이 된다. 상태를 응답에서 받아 말한다 — `confirmed` 는 확정 파일의
      // 존재로 파생된 값이라 저장된 플래그가 아니다(#1115).
      const status = stock.data?.confirmed ? '확정' : '잠정';
      return mode === 'intraday'
        ? `당일 누적 · 억원 · ${status}${cov ? ` · 표본 ${cov.sample_count}/${cov.expected_count ?? '—'}` : ''}`
        : '일별 확정 · 억원';
    }
    const cov = product?.coverage;
    const axis = derivEok ? '억원' : '계약';
    const sample = cov ? ` · 표본 ${cov.sample_count}/${cov.expected_count ?? '—'}` : '';
    // 단위 미확정은 **숨기지 않는다** — 억원 축이 왜 비었는지 화면이 말해야 한다.
    return `당일 누적 · ${axis} · 잠정${derivEok ? '' : ' · 단위 미확정'}${sample}`;
  })();

  return (
    <MarketCard className="flex flex-col gap-sm p-md">
      <CardHeader
        title="투자자 수급"
        hint={hint}
        right={
          stockSel ? (
            <ModeSwitch
              value={mode}
              onChange={setMode}
              options={[
                ['intraday', '당일'],
                ['daily', '일별'],
              ] as const}
              label="수급 표시 구간"
            />
          ) : (
            <span className="font-data text-2xs text-fg-dimmer" title={units?.reason}>
              {product ? `${product.iscd}/${sel}` : sel}
            </span>
          )
        }
      />
      <FlowPicker value={sel} onChange={setSel} products={products} />
      {stockSel ? (
        showDaily ? (
          <StockDaily data={stock.data} market={sel} />
        ) : (
          <StockIntraday data={stock.data} market={sel} loading={stock.isLoading} />
        )
      ) : (
        <DerivIntraday
          product={product}
          eok={derivEok}
          reason={units?.reason}
          loading={deriv.isLoading}
          sessionStartSec={deriv.data?.session_start_sec}
          sessionEndSec={deriv.data?.session_end_sec}
        />
      )}
    </MarketCard>
  );
}

/** 3주체 범례 + 전폭 세션 차트 — 주식·파생이 공유하는 몸통. */
function FlowBody({
  series,
  last,
  sessionStartSec,
  sessionEndSec,
}: {
  series: { color: string; label: string; values: (number | null)[]; secs: number[] }[];
  last: (s: { values: (number | null)[] }) => number | null;
  sessionStartSec?: number;
  sessionEndSec?: number;
}) {
  return (
    <div className="flex flex-col gap-2xs">
      <div className="flex flex-wrap items-baseline justify-end gap-x-sm">
        <span className="flex items-center gap-md font-data text-2xs tabular-nums">
          {series.map((s) => (
            <LegendItem key={s.label} color={s.color} label={s.label} value={last(s)} />
          ))}
        </span>
      </div>
      {/* 벤더 누적을 그대로, x 는 세션 시간 비례 — 표본 4개가 전폭으로 늘어나
          "하루치 흐름" 처럼 읽히던 왜곡을 막는다. 부분 커버리지는 부분 선이다. */}
      <SessionLinesChart
        series={series.map((s) => ({
          color: s.color,
          points: s.secs.map((sec, i) => ({ sec, v: s.values[i] })),
        }))}
        sessionStartSec={sessionStartSec}
        sessionEndSec={sessionEndSec}
        height={128}
      />
      <SessionAxisLabels startSec={sessionStartSec} endSec={sessionEndSec} />
    </div>
  );
}

function StockIntraday({
  data,
  market,
  loading,
}: {
  data: ReturnType<typeof useMarketInvestorFlow>['data'];
  market: string;
  loading: boolean;
}) {
  if (loading) return null;
  const points: InvestorFlowPoint[] = data?.markets?.[market] ?? [];
  if (points.length === 0) {
    // 수집기가 아직 표본을 안 남겼거나 장 시작 전이다 — "실패" 가 아니다.
    return <EmptyNote>오늘 표본이 아직 없습니다. 장중 수집이 시작되면 채워집니다.</EmptyNote>;
  }
  const secs = points.map((p) => kstSecOfDay(p.t_ms));
  // 세션 창을 **양끝 다 서버에서 받는다**. 끝을 정규장(15:30)으로 두면 마감 후 표본이
  // x축 끝에 클램프돼 뭉개지고(`SessionLinesChart` 의 px 계산) — 종가 단일가 체결분이
  // 붙는 바로 그 표본이라 하필 가장 중요한 점이 사라진다. 시작도 같은 성질이다:
  // 게이트가 정규장 밖으로 열리면 그 앞 표본이 전부 왼쪽 끝에 겹쳐 쌓인다.
  return (
    <FlowBody
      series={[
        { color: SERIES_COLORS.individual, label: '개인', values: points.map((p) => p.individual), secs },
        { color: SERIES_COLORS.foreign, label: '외국인', values: points.map((p) => p.foreign), secs },
        { color: SERIES_COLORS.institution, label: '기관', values: points.map((p) => p.institution), secs },
      ]}
      last={(s) => s.values[s.values.length - 1] ?? null}
      sessionStartSec={data?.session_start_sec}
      sessionEndSec={data?.session_end_sec}
    />
  );
}

function StockDaily({
  data,
  market,
}: {
  data: ReturnType<typeof useMarketInvestorFlow>['data'];
  market: string;
}) {
  const daily = data?.daily ?? [];
  if (daily.length === 0) {
    // 장중 표본과 달리 확정본은 뒤늦게도 채워진다(base_dt 랜덤 액세스) — "쌓이는 중" 이다.
    return <EmptyNote>확정 이력이 아직 없습니다. 장 마감 뒤 일일 배치가 하루씩 채웁니다.</EmptyNote>;
  }
  const foreign = daily.map((d) => d.markets[market]?.foreign ?? null);
  const inst = daily.map((d) => d.markets[market]?.institution ?? null);
  return (
    <div className="flex flex-col gap-2xs">
      <div className="flex flex-wrap items-baseline justify-end gap-x-sm">
        <span className="flex items-center gap-md font-data text-2xs tabular-nums">
          <LegendItem color={SERIES_COLORS.foreign} label="외국인" />
          <LegendItem color={SERIES_COLORS.institution} label="기관" />
        </span>
      </div>
      <ComboNetChart
        a={{ color: SERIES_COLORS.foreign, values: foreign }}
        b={{ color: SERIES_COLORS.institution, values: inst }}
      />
      <div className="flex justify-between font-data text-2xs text-fg-dim tabular-nums">
        <span>{daily[0]?.date.slice(4, 6)}/{daily[0]?.date.slice(6)}</span>
        <span>
          {daily[daily.length - 1]?.date.slice(4, 6)}/{daily[daily.length - 1]?.date.slice(6)}
        </span>
      </div>
    </div>
  );
}

function DerivIntraday({
  product,
  eok,
  reason,
  loading,
  sessionStartSec,
  sessionEndSec,
}: {
  product: DerivFlowProduct | undefined;
  eok: boolean;
  reason: string | undefined;
  loading: boolean;
  sessionStartSec: number | undefined;
  sessionEndSec: number | undefined;
}) {
  if (loading) return null;
  const points = product?.points ?? [];
  if (points.length === 0) {
    // KIS 키가 없으면 여기가 정상 상태다(ADR-0134) — 파생 투자자 수급은 KIS 만 준다.
    return (
      <EmptyNote>
        오늘 표본이 아직 없습니다. 장중 수집이 시작되면 채워집니다.
      </EmptyNote>
    );
  }
  const secs = points.map((p) => kstSecOfDay(p.t_ms));
  // 단위가 확정돼야 억원 축을 쓴다. 아니면 계약 축 — 값이 없는 게 아니라 **환산을
  // 못 하는 것**이므로 화면이 비면 안 된다.
  const pick = (p: (typeof points)[number], actor: 'individual' | 'foreign' | 'institution') =>
    eok ? p[actor] : p[`${actor}_qty` as const];
  return (
    <>
      <FlowBody
        series={[
          {
            color: SERIES_COLORS.individual,
            label: '개인',
            values: points.map((p) => pick(p, 'individual')),
            secs,
          },
          {
            color: SERIES_COLORS.foreign,
            label: '외국인',
            values: points.map((p) => pick(p, 'foreign')),
            secs,
          },
          {
            color: SERIES_COLORS.institution,
            label: '기관',
            values: points.map((p) => pick(p, 'institution')),
            secs,
          },
        ]}
        last={(s) => s.values[s.values.length - 1] ?? null}
        sessionStartSec={sessionStartSec}
        sessionEndSec={sessionEndSec}
      />
      {!eok && reason && (
        <p className="font-data text-2xs text-fg-dimmer">단위 미확정 — {reason}</p>
      )}
    </>
  );
}
