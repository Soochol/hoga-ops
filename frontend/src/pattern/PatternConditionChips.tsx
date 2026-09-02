import { useRef, useState } from 'react';
import type { PatternMatchRow } from '../api/screener';
import { useDismissablePopover } from '../util/useDismissablePopover';
import {
  PERIODS,
  RESULT_COUNTS,
  SIM_FLOORS,
  passingFloor,
  type PatternConditions,
  type PeriodKey,
} from './patternConditions';

/**
 * 조건 칩 한 줄 — 기간 · 결과 수 · 유사도 · 거래대금 · ETF.
 *
 * ## 왜 접지 않는가
 *
 * ⚙ 뒤에 숨기면 "왜 20개만 나오지" 를 다시 겪는다 — 「나온 자리 전부」가 안 보여
 * "중복이 하나도 없네" 가 됐던 그 일이다(2026-09-02). 칩은 **현재 값을 늘 적어 두고**
 * 세로는 한 줄만 쓴다.
 *
 * ## 팝오버가 개수를 미리 말한다
 *
 * 유사도·결과 수는 **받아 둔 목록을 자르는** 조건이라 서버 없이 셀 수 있다. 그래서
 * 각 항목 오른쪽에 그 값에서 남는 수를 적는다 — 「0.95 이상 · 없음」 을 보면 누르지
 * 않으므로 빈 목록을 만들고 되돌리는 왕복이 사라진다.
 *
 * 기간은 다르다. **후보 모집단**을 바꾸므로 서버를 다시 불러야 하고, 그래서 미리보기가
 * 없다(`patternConditions` 상단 주석).
 */
type Popover = 'period' | 'count' | 'sim' | 'tv' | 'etf' | null;

const TV_STEPS = [0, 10, 50] as const;

export function PatternConditionChips({
  conditions,
  onChange,
  rows,
  p9999,
}: {
  conditions: PatternConditions;
  onChange: (next: PatternConditions) => void;
  /** 서버가 준 목록(하한 적용 **전**) — 미리보기의 모집단. */
  rows: readonly PatternMatchRow[];
  /** 이 검색의 분포 상단. 절대값 하한의 뜻을 메우는 눈금이다. */
  p9999: number | null;
}) {
  const [open, setOpen] = useState<Popover>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  useDismissablePopover(open != null, rootRef, () => setOpen(null));

  const set = (patch: Partial<PatternConditions>) => {
    onChange({ ...conditions, ...patch });
    setOpen(null);
  };
  const toggle = (k: Popover) => setOpen(open === k ? null : k);
  const periodLabel = PERIODS.find((p) => p.key === conditions.period)?.label ?? '전체 기간';
  const passing = passingFloor(rows, conditions.simFloor).length;

  return (
    <div ref={rootRef} className="relative flex flex-wrap gap-1 border-b border-border px-md py-sm">
      <Chip active={conditions.period !== 'all'} onClick={() => toggle('period')}>
        {periodLabel}
      </Chip>
      <Chip active={conditions.count !== 40} onClick={() => toggle('count')}>
        {conditions.count}개
      </Chip>
      <Chip active={conditions.simFloor > 0} onClick={() => toggle('sim')}>
        {conditions.simFloor > 0 ? `유사도 ${conditions.simFloor.toFixed(2)}+` : '유사도 전체'}
      </Chip>
      <Chip active onClick={() => toggle('tv')}>
        {conditions.minTvEok > 0 ? `${conditions.minTvEok}억+` : '거래대금 무관'}
      </Chip>
      <Chip active={conditions.excludeEtf} onClick={() => toggle('etf')}>
        {conditions.excludeEtf ? 'ETF 제외' : 'ETF 포함'}
      </Chip>

      {open === 'period' && (
        <Popover title="그 패턴이 나온 시기 · 다시 검색한다">
          {PERIODS.map((p) => (
            <Item
              key={p.key}
              selected={p.key === conditions.period}
              onClick={() => set({ period: p.key as PeriodKey })}
              label={p.label}
            />
          ))}
        </Popover>
      )}
      {open === 'count' && (
        <Popover title="최대 몇 개까지">
          {RESULT_COUNTS.map((n) => (
            <Item
              key={n}
              selected={n === conditions.count}
              onClick={() => set({ count: n })}
              label={`${n}개까지`}
              hint={`${Math.min(n, passing)}개`}
            />
          ))}
        </Popover>
      )}
      {open === 'sim' && (
        <Popover
          title={`유사도 하한 · 받아 둔 ${rows.length}개 중${p9999 != null ? ` · p99.99 = ${p9999.toFixed(3)}` : ''}`}
        >
          {SIM_FLOORS.map((f) => {
            const n = passingFloor(rows, f).length;
            return (
              <Item
                key={f}
                selected={f === conditions.simFloor}
                onClick={() => set({ simFloor: f })}
                label={f > 0 ? `${f.toFixed(2)} 이상` : '제한 없음'}
                hint={n > 0 ? `${n}개` : '없음'}
                muted={n === 0}
              />
            );
          })}
        </Popover>
      )}
      {open === 'tv' && (
        <Popover title="창 평균 거래대금 · 다시 검색한다">
          {TV_STEPS.map((v) => (
            <Item
              key={v}
              selected={v === conditions.minTvEok}
              onClick={() => set({ minTvEok: v })}
              label={v > 0 ? `${v}억 이상` : '제한 없음'}
            />
          ))}
        </Popover>
      )}
      {open === 'etf' && (
        <Popover title="ETF·ETN · 다시 검색한다">
          {[true, false].map((v) => (
            <Item
              key={String(v)}
              selected={v === conditions.excludeEtf}
              onClick={() => set({ excludeEtf: v })}
              label={v ? '제외' : '포함'}
            />
          ))}
        </Popover>
      )}
    </div>
  );
}

function Chip({
  active, onClick, children,
}: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        'inline-flex items-center gap-1 rounded-full border px-2 py-[2px] text-2xs '
        + (active
          ? 'border-accent bg-tint-selection text-accent'
          : 'border-border text-fg-dim hover:bg-bg-input-hover hover:text-fg')
      }
    >
      {children}
      <span className="text-[9px] opacity-55">▾</span>
    </button>
  );
}

function Popover({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div
      role="listbox"
      className="absolute left-md top-[calc(100%-4px)] z-20 flex min-w-[190px] flex-col rounded border border-border-strong bg-bg-card p-1 shadow-panel"
    >
      <div className="px-2 pb-1 pt-1.5 text-[10px] text-fg-dimmer">{title}</div>
      {children}
    </div>
  );
}

function Item({
  selected, onClick, label, hint, muted,
}: {
  selected: boolean; onClick: () => void; label: string; hint?: string; muted?: boolean;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={onClick}
      className={
        'flex w-full items-baseline justify-between gap-2.5 rounded px-2 py-[5px] text-left text-xs '
        + (selected ? 'bg-tint-selection text-accent' : 'text-fg hover:bg-bg-input-hover')
      }
    >
      <span>{label}</span>
      {hint != null && (
        <span
          className={
            'shrink-0 font-data text-2xs '
            + (selected ? 'text-accent' : muted ? 'text-fg-dimmer' : 'text-fg-dim')
          }
        >
          {hint}
        </span>
      )}
    </button>
  );
}
