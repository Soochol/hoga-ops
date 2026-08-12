/** 시장 종합 페이지의 그리기 조각 (#1102).
 *
 * 프로토타입(`market/prototype/protoBits.tsx`)에서 살아남은 것들이다 — 목업 타입을
 * 실 와이어 타입으로 갈고, 값이 `null` 일 수 있다는 사실(부분 실패·미수집)을
 * 시그니처에 반영했다.
 *
 * **계열 색은 MA 팔레트를 쓴다.** 방향색(`--price-up`/`--price-down`)은 등락 전용이라
 * 다계열 라인에 쓰면 "외국인이 빨간 건 순매수라서인가 상승이라서인가" 가 모호해진다.
 */
import { priceDirClass } from '../ui/priceDir';
import { fmtPct, fmtSigned } from './marketFormat';

export function PctText({ pct, className = '' }: { pct: number | null; className?: string }) {
  if (pct === null) return <span className={`font-data text-fg-dim ${className}`}>—</span>;
  return (
    <span className={`font-data tabular-nums ${priceDirClass(pct)} ${className}`}>{fmtPct(pct)}</span>
  );
}

/** 상승/보합/하락 비율 막대. 값이 없으면 렌더하지 않는다 — **지수 상품은 부재가 정상**이다(#1100). */
export function AdvanceDeclineBar({
  rising,
  falling,
  flat,
  height = 4,
}: {
  rising: number | null;
  falling: number | null;
  flat: number | null;
  height?: number;
}) {
  if (rising === null || falling === null) return null;
  const f = flat ?? 0;
  const total = rising + falling + f || 1;
  return (
    <div className="flex w-full overflow-hidden rounded-sm" style={{ height }} aria-hidden="true">
      <div style={{ width: `${(rising / total) * 100}%`, background: 'var(--price-up)' }} />
      <div style={{ width: `${(f / total) * 100}%`, background: 'var(--border-strong)' }} />
      <div style={{ width: `${(falling / total) * 100}%`, background: 'var(--price-down)' }} />
    </div>
  );
}

type Series = { color: string; values: (number | null)[] };

function finite(values: (number | null)[]): number[] {
  return values.filter((v): v is number => v !== null && Number.isFinite(v));
}

/** 다계열 누적 라인 — delta 배열을 누적해 그린다. 0 기준선 공유. */
export function CumLinesChart({
  series,
  width = 300,
  height = 96,
}: {
  series: Series[];
  width?: number;
  height?: number;
}) {
  const cums = series.map(({ values }) => {
    let acc = 0;
    return values.map((v) => (acc += v ?? 0));
  });
  const all = [...cums.flat(), 0];
  if (all.length < 2) return null;
  const min = Math.min(...all);
  const span = Math.max(...all) - min || 1;
  const n = cums[0]?.length ?? 0;
  if (n < 2) return null;
  const px = (i: number) => (i / (n - 1)) * (width - 4) + 2;
  const py = (v: number) => height - 3 - ((v - min) / span) * (height - 6);
  const path = (s: number[]) =>
    s.map((v, i) => `${i === 0 ? 'M' : 'L'}${px(i).toFixed(1)},${py(v).toFixed(1)}`).join(' ');
  return (
    <svg
      width="100%"
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
      className="block"
    >
      <line x1="2" x2={width - 2} y1={py(0)} y2={py(0)} stroke="var(--border-strong)" strokeDasharray="2 3" />
      {cums.map((s, i) => (
        <path key={i} d={path(s)} fill="none" stroke={series[i].color} strokeWidth="1.5" strokeLinejoin="round" />
      ))}
    </svg>
  );
}

/** 일별 막대(강도) + 누적 라인(방향) 콤보. 같은 계열은 같은 색, 막대는 반투명. */
export function ComboNetChart({
  a,
  b,
  height = 96,
}: {
  a: Series;
  b: Series;
  height?: number;
}) {
  const n = a.values.length;
  if (n < 1) return null;
  const width = 300;
  const maxAbs = Math.max(...finite(a.values).map(Math.abs), ...finite(b.values).map(Math.abs), 1);
  const mid = height / 2;
  const slot = width / n;
  const bw = Math.max((slot - 2) / 2, 1.5);
  const cum = (values: (number | null)[]) => {
    let acc = 0;
    return values.map((v) => (acc += v ?? 0));
  };
  const aCum = cum(a.values);
  const bCum = cum(b.values);
  const all = [...aCum, ...bCum, 0];
  const cMin = Math.min(...all);
  const cSpan = Math.max(...all) - cMin || 1;
  const px = (i: number) => i * slot + slot / 2;
  const py = (v: number) => height - 3 - ((v - cMin) / cSpan) * (height - 6);
  const path = (s: number[]) =>
    s.map((v, i) => `${i === 0 ? 'M' : 'L'}${px(i).toFixed(1)},${py(v).toFixed(1)}`).join(' ');
  const bar = (v: number | null, x: number, color: string, key: string) => {
    if (v === null) return null;
    const bh = (Math.abs(v) / maxAbs) * (mid - 3);
    return (
      <rect
        key={key}
        x={x}
        y={v >= 0 ? mid - bh : mid}
        width={bw}
        height={Math.max(bh, 0.75)}
        fill={color}
        opacity="0.45"
      />
    );
  };
  return (
    <svg
      width="100%"
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
      className="block"
    >
      <line x1="0" x2={width} y1={mid} y2={mid} stroke="var(--border-strong)" />
      {a.values.map((v, i) => bar(v, i * slot + 1, a.color, `a${i}`))}
      {b.values.map((v, i) => bar(v, i * slot + 1 + bw + 0.5, b.color, `b${i}`))}
      <path d={path(aCum)} fill="none" stroke={a.color} strokeWidth="1.5" strokeLinejoin="round" />
      <path d={path(bCum)} fill="none" stroke={b.color} strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

/** 세션 시간 비례 라인 차트 — 장중 누적 시계열 전용.
 *
 * **x 가 표본 인덱스가 아니라 세션 시각(09:00–15:30)에 비례한다.** 인덱스 비례로
 * 그리면 표본 4개가 전폭으로 늘어나 "하루치 흐름" 처럼 읽힌다(실화면에서 14:28~14:29
 * 구간이 전폭을 채웠다, 2026-08-05). 시간 비례면 부분 커버리지가 **부분 선**으로
 * 보이고, 재시작 공백도 선의 빈 구간으로 정직하게 드러난다 — 커버리지 철학(#1105)의
 * 시각화 판이다.
 *
 * 값은 **이미 누적**이라고 가정하고 그대로 그린다(ka90005·수집 표본 모두 벤더 누적).
 * `vector-effect: non-scaling-stroke` 로 초광폭 스트레치에서 선 굵기를 지킨다. */
/* ⚠ 창을 **서버가 주는 표면은 두 값을 반드시 넘긴다**(`session_start_sec` ·
   `session_end_sec`). 기본값은 그 필드가 없는 표면(프로그램 매매 — 정규장 고정)만을
   위한 것이고, 넘기지 않으면 `px()` 의 클램프가 창 밖 표본을 양 끝에 겹쳐 쌓는다. */
export function SessionLinesChart({
  series,
  sessionStartSec = 9 * 3600,
  sessionEndSec = 15.5 * 3600,
  height = 96,
}: {
  series: { color: string; points: { sec: number; v: number | null }[] }[];
  sessionStartSec?: number;
  sessionEndSec?: number;
  height?: number;
}) {
  const width = 300;
  const span = sessionEndSec - sessionStartSec || 1;
  const finiteVals = series.flatMap((s) => s.points.map((p) => p.v)).filter(
    (v): v is number => v !== null && Number.isFinite(v),
  );
  if (finiteVals.length < 2) return null;
  const min = Math.min(...finiteVals, 0);
  const max = Math.max(...finiteVals, 0);
  const vspan = max - min || 1;
  const px = (sec: number) =>
    1 + ((Math.min(Math.max(sec, sessionStartSec), sessionEndSec) - sessionStartSec) / span) * (width - 2);
  const py = (v: number) => height - 3 - ((v - min) / vspan) * (height - 6);
  const path = (pts: { sec: number; v: number | null }[]) => {
    let d = '';
    for (const p of pts) {
      if (p.v === null) continue;
      d += `${d ? 'L' : 'M'}${px(p.sec).toFixed(1)},${py(p.v).toFixed(1)} `;
    }
    return d.trim();
  };
  return (
    <svg
      width="100%"
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
      className="block"
    >
      <line x1="1" x2={width - 1} y1={py(0)} y2={py(0)} stroke="var(--border-strong)" strokeDasharray="2 3" />
      {series.map((s, i) => (
        <path
          key={i}
          d={path(s.points)}
          fill="none"
          stroke={s.color}
          strokeWidth="1.5"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </svg>
  );
}

/** 자정 기준 초 → `HH:MM`. **축 라벨을 하드코딩하지 않기 위한 것**이다 — 선은 서버가
 *  준 세션 창까지 그려지는데 눈금만 다른 시각을 말하면 조용한 거짓말이 된다.
 *  같은 값에서 파생시키면 어긋날 수가 없다. */
export function secOfDayLabel(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** 세션축의 시간 라벨 — 표본 범위가 아니라 **세션**을 말한다.
 *
 * **`SessionLinesChart` 와 같은 초를 받는다.** 문자열 라벨을 따로 받던 이전 판은
 * 선과 눈금이 서로 다른 창을 말할 수 있었고, 실제로 그랬다: 세 라벨 중 시작(`09:00`)과
 * 중간(`12:00`)이 리터럴이라 끝만 넘겨받아 봐야 나머지 둘은 못 따라왔다. 파생
 * (09:00–15:45)에서 중간 라벨은 이미 어긋나 있었다 — 실제 중점은 12:22 다.
 *
 * 중간 라벨을 계산하는 이유는 `justify-between` 이 그것을 **시각적 정중앙**에 놓기
 * 때문이다. 정중앙에 놓인 눈금이 중점이 아닌 시각을 말하면 그 자체가 거짓말이다. */
export function SessionAxisLabels({
  startSec = 9 * 3600,
  endSec = 15.5 * 3600,
}: { startSec?: number; endSec?: number } = {}) {
  return (
    <div className="flex justify-between font-data text-2xs text-fg-dim tabular-nums">
      <span>{secOfDayLabel(startSec)}</span>
      <span>{secOfDayLabel((startSec + endSec) / 2)}</span>
      <span>{secOfDayLabel(endSec)}</span>
    </div>
  );
}

/** 값 없이 색 견본 + 라벨만. 합계는 호출부가 계산해 넘긴다. */
export function LegendItem({
  color,
  label,
  value,
}: {
  color: string;
  label: string;
  value?: number | null;
}) {
  return (
    <span className="flex items-center gap-2xs">
      <span className="inline-block h-[2px] w-[10px]" style={{ background: color }} />
      <span className="text-fg-dim">{label}</span>
      {value !== undefined && (
        <span className={value === null ? 'text-fg-dim' : priceDirClass(value)}>{fmtSigned(value)}</span>
      )}
    </span>
  );
}

/** 초소형 라인 스파크라인 — 당일 장중 흐름.
 *
 * **색 = 마지막 값 vs `baseline`(당일 시가).** 히트맵 `CandleGlyph` 와 같은 규칙이다
 * (DESIGN.md "Price-direction candle glyph": 색은 **종가 vs 시가** strict). 카드의 큰
 * 숫자는 *전일 대비* 라 시간창이 달라 **선과 숫자의 색이 갈릴 수 있는데, 그것이 의도**다
 * — 갭 상승 후 밀린 날은 "전일보단 위, 오늘은 아래" 가 사실이고 두 색이 그걸 말한다.
 * `baseline` 이 없으면 첫 점을 쓴다.
 *
 * 값이 2개 미만이면 그리지 않는다(한 점짜리 선은 거짓 정보다). */
export function Sparkline({
  points,
  baseline,
  width = 110,
  height = 40,
}: {
  points: number[];
  baseline?: number;
  width?: number;
  height?: number;
}) {
  if (points.length < 2) return null;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const px = (i: number) => (i / (points.length - 1)) * (width - 2) + 1;
  const py = (v: number) => height - 2 - ((v - min) / span) * (height - 4);
  const d = points
    .map((v, i) => `${i === 0 ? 'M' : 'L'}${px(i).toFixed(1)},${py(v).toFixed(1)}`)
    .join(' ');
  const dir = points[points.length - 1] - (baseline ?? points[0]);
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <path
        d={d}
        fill="none"
        stroke={dir >= 0 ? 'var(--price-up)' : 'var(--price-down)'}
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** 통계 타일 **배경**에 까는 추이 면적 — 축도 눈금도 없다.
 *
 * `Sparkline`(당일 장중, 방향색)과 문법이 다르다. 저쪽은 카드 옆에 **나란히** 놓이는
 * 독립 그래픽이고 이쪽은 글자 **뒤에** 깔린다. 그래서 셋을 지킨다:
 *
 * **① 축·마커를 그리지 않는다.** 읽는 그림이 아니라 숫자를 뒷받침하는 질감이다.
 *     읽게 만들려면 축이 필요하고, 축을 넣는 순간 글자 뒤에 둘 수 없다.
 * **② 채도를 낮게 묶는다**(`fill` 0.14 · `stroke` 0.55). 글자가 위에 올라가므로
 *     올리면 `--fg` 대비가 무너진다(DESIGN.md 텍스트 대비). 호출부가 못 올리도록
 *     상수로 박아 둔다.
 * **③ 마지막 구간만 점선이다.** 당일 값은 확정일과 달리 *지금까지의 누적*이라
 *     장중엔 절벽처럼 떨어져 보인다 — 배경으로 밀려나도 그 사실은 남겨야 한다.
 *
 * 부모가 `relative`, 이쪽이 `absolute inset-0` 이라 **레이아웃 높이를 0 으로** 쓴다.
 * viewBox 는 좌표계일 뿐이고 실제 크기는 부모가 정한다(`preserveAspectRatio="none"`).
 */
export function TrendBackdrop({ values, color }: { values: number[]; color: string }) {
  if (values.length < 2) return null;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || 1;
  const W = 400;
  const H = 52;
  const px = (i: number) => (i / (values.length - 1)) * W;
  const py = (v: number) => H - 4 - ((v - lo) / span) * (H - 10);
  const pts = values.map((v, i) => `${i === 0 ? 'M' : 'L'}${px(i).toFixed(1)},${py(v).toFixed(1)}`);
  const cut = values.length - 1;
  return (
    <svg
      className="pointer-events-none absolute inset-0 h-full w-full"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <path d={`${pts.join(' ')} L${W},${H} L0,${H} Z`} fill={color} opacity={0.14} />
      <path
        d={pts.slice(0, cut).join(' ')}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        opacity={0.55}
        vectorEffect="non-scaling-stroke"
      />
      <path
        d={`M${px(cut - 1).toFixed(1)},${py(values[cut - 1]).toFixed(1)} L${px(cut).toFixed(1)},${py(values[cut]).toFixed(1)}`}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeDasharray="3 3"
        opacity={0.55}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
