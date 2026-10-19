import type { BreakoutParams, DepthPeakParams, DepthPeakPeriodParams, DepthRenewalParams, PeriodParams } from '../api/screener';
import { CandleSettings } from './CandleSettings';
import { RENEWAL_MIN_HHMM, RENEWAL_MAX_HHMM, hhmmToTimeValue, timeValueToHhmm } from './paramFormsHelpers';


export function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="text-2xs font-semibold uppercase text-fg-dim">{children}</div>;
}

export function Num({ value, onChange, label, ariaLabel, w = 'w-20', min, max }: {
  value: number | undefined; onChange: (n: number | undefined) => void;
  /** 눈에 보이는 라벨. 문장형 폼에서는 생략하고 ariaLabel 만 준다. */
  label?: string;
  /** 접근 가능한 이름 — 생략 시 label. 둘 다 없으면 이름 없는 입력이 되므로 피한다. */
  ariaLabel?: string;
  w?: string; min?: number; max?: number;
}) {
  // 타이핑 중에는 자유롭게 두고(중간값 간섭 금지), blur 에서만 범위로 클램프한다.
  // NaN('e' 등)은 undefined 로 흘려 폼별 기본값 복원 경로를 태운다 — 서버 422 방지.
  // ⚠ `min`/`max` 는 장식이 아니라 **백엔드 Field 제약의 손 미러**다. 어긋나면 타입은
  // 통과하고 서버만 422 로 스캔을 통째로 거절한다(숫자 제약은 wire contract 가 보는
  // 축이 아니다 — 이름과 enum 값만 대조한다). 폼별 클램프 테스트가 그 미러를 지킨다.
  const commit = (raw: string) => {
    if (raw === '') { onChange(undefined); return; }
    const n = Number(raw);
    onChange(Number.isFinite(n) ? n : undefined);
  };
  const clampOnBlur = (raw: string) => {
    if (raw === '') return;
    const n = Number(raw);
    if (!Number.isFinite(n)) return;
    const c = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n));
    if (c !== n) onChange(c);
  };
  return (
    <label className="inline-flex items-center gap-1.5">
      {label && <span className="text-2xs text-fg-dim">{label}</span>}
      <input type="number" inputMode="numeric" aria-label={ariaLabel ?? label} min={min} max={max}
        value={value ?? ''} onChange={(e) => commit(e.target.value)}
        onBlur={(e) => clampOnBlur(e.target.value)}
        className={`${w} bg-bg-input border border-border rounded-md px-2 py-1 font-data text-sm tabular-nums text-fg`} />
    </label>
  );
}

export { Select } from './Select';


/** (lookback N, period M) 돌파 폼 — new_high / new_high_vol 공용. 문장형:
 *  "최근 [N]일 내 [M]일 신고" — 신고가/신고거래량 어느 쪽인지는 조건 행 라벨이 말한다. */
export function BreakoutForm({ params, onChange }: { params: BreakoutParams; onChange: (p: BreakoutParams) => void }) {
  return <CandleSettings params={params} onChange={patch => onChange({ ...params, ...patch })}>
    <div className="flex items-center gap-2 flex-wrap text-sm text-fg-dim">
      최근 <Num ariaLabel="최근 기간(봉)" w="w-16" min={1} max={1000}
        value={params.lookback} onChange={n => onChange({ ...params, lookback: n ?? 1 })} />봉 내
      <Num ariaLabel="신고 기준 기간(봉)" w="w-16" min={1} max={1000}
        value={params.period} onChange={n => onChange({ ...params, period: n ?? 1 })} />봉 신고
    </div>
  </CandleSettings>;
}

/** Latest selected candle; the comparison window includes the candidate. */
export function PeriodForm({ params, onChange }: { params: PeriodParams; onChange: (p: PeriodParams) => void }) {
  return <CandleSettings params={params} onChange={patch => onChange({ ...params, ...patch })}>
    <div className="flex items-center gap-2 text-sm text-fg-dim">
      최신 봉 · <Num ariaLabel="신고 기준 기간(봉)" min={1} max={1000}
        value={params.period} onChange={n => onChange({ ...params, period: n ?? 1 })} />봉 신고
    </div>
  </CandleSettings>;
}


/** (비교기간 N, 과거 peak 대비 X%) 폼 — ask/bid_depth_new_high(총잔량 신고) 공용. */
export function DepthPeakForm({ params, onChange }: { params: DepthPeakParams; onChange: (p: DepthPeakParams) => void }) {
  return <div className="flex flex-col gap-2">
    <div className="flex items-center gap-2 flex-wrap">
      <Num label="비교 기간" ariaLabel="비교 기간(일)" min={1} max={1000}
        value={params.lookback} onChange={(n) => onChange({ ...params, lookback: n ?? 1 })} />
      <span className="text-sm text-fg-dim">일</span>
      <Num label="과거 peak 대비" min={1}
        value={params.threshold_pct} onChange={(n) => onChange({ ...params, threshold_pct: n ?? 100 })} />
      <span className="text-sm text-fg-dim">% 이상</span>
    </div>
    <div className="text-2xs text-fg-dim">관심·히트맵 종목 중 데이터 보유 종목 대상</div>
  </div>;
}


/** (기간 N, 비교 창 M, 과거 peak 대비 X%) 폼 — ask/bid_depth_new_high_period 공용.
 *  문장형은 BreakoutForm("최근 [N]일 내 [M]일 신고")을 따른다 — 같은 (N, M) 규약이라
 *  같은 어순으로 읽혀야 한다. 어느 side 인지는 조건 행 라벨이 말한다(DepthPeakForm 규칙). */
export function DepthPeakPeriodForm({ params, onChange }: { params: DepthPeakPeriodParams; onChange: (p: DepthPeakPeriodParams) => void }) {
  return <div className="flex flex-col gap-2">
    <div className="flex items-center gap-2 flex-wrap">
      <span className="text-sm text-fg-dim">최근</span>
      <Num ariaLabel="최근 기간(일)" w="w-16" min={1} max={1000}
        value={params.lookback} onChange={(n) => onChange({ ...params, lookback: n ?? 1 })} />
      <span className="text-sm text-fg-dim">일 내</span>
      <Num ariaLabel="비교 기간(일)" w="w-16" min={1} max={1000}
        value={params.period} onChange={(n) => onChange({ ...params, period: n ?? 1 })} />
      <span className="text-sm text-fg-dim">일 peak 대비</span>
      <Num ariaLabel="과거 peak 대비(%)" min={1}
        value={params.threshold_pct} onChange={(n) => onChange({ ...params, threshold_pct: n ?? 100 })} />
      <span className="text-sm text-fg-dim">% 이상</span>
    </div>
    <div className="text-2xs text-fg-dim">
      관심·히트맵 종목 중 데이터 보유 종목 대상 · 최근 N일 중 하루라도 닿으면 통과
      · 비교 창은 그 날을 제외한 직전 M거래일
    </div>
  </div>;
}


/** (기준시각, 이전 최대 대비 X%) 폼 — ask/bid_depth_renewal 공용. 당일 전용.
 *  문구는 side 중립이다(DepthPeakForm 과 같은 규칙) — 어느 쪽인지는 조건 행 라벨이
 *  말한다. ParamForm 은 params/onChange 만 받으므로 side 를 알 방법도 없다. */
export function DepthRenewalForm({ params, onChange }: { params: DepthRenewalParams; onChange: (p: DepthRenewalParams) => void }) {
  // 범위 밖·미완성 입력(사용자가 시를 지우는 중 등)은 마지막 유효값을 유지한다 —
  // 여기서 0 이나 NaN 을 흘리면 서버가 422 로 스캔을 통째로 거절한다.
  const onTime = (v: string) => {
    const hhmm = timeValueToHhmm(v);
    if (hhmm != null) onChange({ ...params, start_hhmm: hhmm });
  };
  return <div className="flex flex-col gap-2">
    <div className="flex items-center gap-2 flex-wrap">
      <label className="inline-flex items-center gap-1.5">
        <span className="text-2xs text-fg-dim">기준 시각</span>
        <input type="time" aria-label="기준 시각" step={60}
          min={hhmmToTimeValue(RENEWAL_MIN_HHMM)} max={hhmmToTimeValue(RENEWAL_MAX_HHMM)}
          value={hhmmToTimeValue(params.start_hhmm)} onChange={(e) => onTime(e.target.value)}
          className="w-28 bg-bg-input border border-border rounded-md px-2 py-1 font-data text-sm tabular-nums text-fg" />
      </label>
      <span className="text-sm text-fg-dim">이후 총잔량이</span>
      <Num label="이전 최대 대비" min={1} value={params.threshold_pct}
        onChange={(n) => onChange({ ...params, threshold_pct: n ?? 100 })} />
      <span className="text-sm text-fg-dim">% 이상</span>
    </div>
    <div className="text-2xs text-fg-dim">
      관심·히트맵 종목 대상 · 당일 기준(장중 조회에서만 동작) · 하루 중 한 번이라도 닿으면 계속 표시
      · 100%는 동률 포함(더 큰 것만 보려면 101 이상)
    </div>
  </div>;
}
