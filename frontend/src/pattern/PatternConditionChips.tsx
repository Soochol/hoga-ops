import { useRef, useState } from 'react';
import type { PatternExclusion, PatternMatchRow } from '../api/screener';
import { useDismissablePopover } from '../util/useDismissablePopover';
import {
  DEFAULT_CONDITIONS,
  FLEX_STEPS,
  MA_PRESETS,
  exclusionKey,
  PERIODS,
  RESULT_COUNTS,
  SIM_FLOORS,
  TIMEFRAMES,
  maLabel,
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
type Popover =
  | 'timeframe' | 'period' | 'count' | 'sim' | 'tv' | 'etf' | 'flex' | 'ma' | 'hidden' | null;

const TV_STEPS = [0, 10, 50] as const;

export function PatternConditionChips({
  conditions,
  onChange,
  rows,
  p9999,
  excluded,
  onRestore,
  onRestoreAll,
}: {
  conditions: PatternConditions;
  onChange: (next: PatternConditions) => void;
  /** 서버가 준 목록(하한 적용 **전**) — 미리보기의 모집단. */
  rows: readonly PatternMatchRow[];
  /** 이 검색의 분포 상단. 절대값 하한의 뜻을 메우는 눈금이다. */
  p9999: number | null;
  /** 이 검색에서 뺀 자리들. **조건이 아니다** — 위 칩 주석 참조. */
  excluded: readonly PatternExclusion[];
  onRestore: (e: PatternExclusion) => void;
  onRestoreAll: () => void;
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
      {/* 봉 단위가 **맨 앞**이다 — 다른 조건들이 「그 코퍼스 안에서」 걸리므로 읽는
          순서도 그래야 한다. 공장값(일봉)이어도 늘 활성으로 그린다: 이 값을 모르면
          「5·20 이평」이 5일인지 5주인지 화면 어디에서도 알 수 없다. */}
      <Chip active onClick={() => toggle('timeframe')}>
        {TIMEFRAMES.find((f) => f.key === conditions.timeframe)?.label ?? '일봉'}
      </Chip>
      <Chip active={conditions.period !== 'all'} onClick={() => toggle('period')}>
        {periodLabel}
      </Chip>
      {/* 「기본과 다른가」를 뜻하는 칩이라 상수를 베끼지 않는다 — 공장값이 바뀌면
          여기도 함께 움직여야 한다(2026-09-02 에 40 → 100 이 됐다). */}
      <Chip active={conditions.count !== DEFAULT_CONDITIONS.count} onClick={() => toggle('count')}>
        {conditions.count}개
      </Chip>
      <Chip active={conditions.simFloor > 0} onClick={() => toggle('sim')}>
        {conditions.simFloor > 0 ? `유사도 ${conditions.simFloor.toFixed(2)}+` : '유사도 전체'}
      </Chip>
      <Chip active={conditions.flexBars > 0} onClick={() => toggle('flex')}>
        {conditions.flexBars > 0 ? `길이 ±${conditions.flexBars}봉` : '길이 고정'}
      </Chip>
      <Chip active={conditions.maPreset !== 'off'} onClick={() => toggle('ma')}>
        {maLabel(conditions.maPreset, conditions.timeframe)}
      </Chip>
      <Chip active onClick={() => toggle('tv')}>
        {conditions.minTvEok > 0 ? `${conditions.minTvEok}억+` : '거래대금 무관'}
      </Chip>
      <Chip active={conditions.excludeEtf} onClick={() => toggle('etf')}>
        {conditions.excludeEtf ? 'ETF 제외' : 'ETF 포함'}
      </Chip>
      {/* 제외는 **조건이 아니다**(질문이 아니라 답의 편집이다). 그래도 같은 줄에 사는
          이유는 「지금 목록에 무엇이 걸려 있나」를 한 곳에서 읽게 하려는 것이고,
          `conditions` 에 넣지 않았으므로 조건 저장·복원 경로와는 섞이지 않는다. */}
      {excluded.length > 0 && (
        <Chip active onClick={() => toggle('hidden')}>
          숨김 {excluded.length}
        </Chip>
      )}

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
      {open === 'flex' && (
        <Popover title="같은 모양이 더 길게·짧게 전개된 것도 · 다시 검색한다">
          {FLEX_STEPS.map((f) => (
            <Item
              key={f}
              selected={f === conditions.flexBars}
              onClick={() => set({ flexBars: f })}
              label={f === 0 ? '길이 고정' : `±${f}봉까지`}
              hint={f === 0 ? undefined : `${2 * f + 1}배 계산`}
            />
          ))}
        </Popover>
      )}
      {open === 'timeframe' && (
        <Popover title="봉 단위 · 다시 검색한다">
          {TIMEFRAMES.map((f) => (
            <Item
              key={f.key}
              selected={f.key === conditions.timeframe}
              // ⚠ 공장 조건을 함께 갈아 끼우지 **않는다** — 사용자가 고른 기간이
              //   조용히 사라진다. 시드 경로만 timeframe 별 공장값을 쓴다.
              onClick={() => set({ timeframe: f.key })}
              label={f.label}
              hint={f.note}
            />
          ))}
        </Popover>
      )}
      {open === 'ma' && (
        <Popover title="이평선도 맞출지 · 다시 검색한다">
          {MA_PRESETS.map((m) => (
            <Item
              key={m.key}
              selected={m.key === conditions.maPreset}
              onClick={() => set({ maPreset: m.key })}
              label={maLabel(m.key, conditions.timeframe)}
              // 프리셋마다 **찾는 것이 달라진다** — 판별력의 차이가 아니라서 이름과 한 줄
              // 설명이 그 사실을 져야 한다(실측: 5·20 대비 20·60 은 상위 20 중 3개만 겹친다).
              hint={m.note}
            />
          ))}
        </Popover>
      )}
      {open === 'hidden' && (
        <Popover title="이 검색에서 뺀 자리 · 눌러서 되돌린다">
          {excluded.map((e) => (
            <Item
              key={exclusionKey(e)}
              selected={false}
              onClick={() => onRestore(e)}
              label={e.stock_name || e.code}
              // 「전체」가 자리와 **같은 자리에** 오는 것이 요점이다 — 목록이 하나라
              // 「숨김 N」이 무엇의 N 인지 흐려지지 않는다.
              hint={e.from_date
                ? `${e.from_date.slice(0, 4)}-${e.from_date.slice(4, 6)}-${e.from_date.slice(6)}`
                : '전체'}
            />
          ))}
          {excluded.length > 1 && (
            <>
              <div role="separator" className="my-1 border-t border-border" />
              <Item selected={false} onClick={onRestoreAll} label="전부 되돌리기" />
            </>
          )}
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
