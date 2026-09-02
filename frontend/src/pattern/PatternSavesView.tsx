import { useMemo, useState } from 'react';
import type { PatternSave } from '../api/screener';
import { RailState } from '../ui/RailShell';
import { groupPatternSaves, matchesPatternSave } from './usePatternSaves';

/**
 * 저장 목록 **화면** — 팝오버가 아니다.
 *
 * 사용자의 저장뷰가 실측 **125개**다. 좁은 드로어에서 그 규모를 드롭다운으로 다루면
 * 스크롤 안의 스크롤이 되고 검색을 넣을 자리도 없다. 그래서 「저장한 검색」 은 패널을
 * **목록 모드로 바꾸고**, 하나를 고르면 결과 모드로 돌아온다.
 *
 * 종목별로 묶는 이유도 그 규모다 — 항목에는 조건만 남기고 종목명은 그룹 헤더가 말한다.
 */
export function PatternSavesView({
  saves,
  onPick,
  onDelete,
  onBack,
}: {
  saves: readonly PatternSave[];
  onPick: (save: PatternSave) => void;
  onDelete: (save: PatternSave) => void;
  onBack: () => void;
}) {
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const filtered = useMemo(
    () => saves.filter((s) => matchesPatternSave(s, query)),
    [saves, query],
  );
  const groups = useMemo(() => groupPatternSaves(filtered), [filtered]);

  return (
    <>
      <div className="flex items-center gap-sm border-b border-border px-md py-sm">
        <button
          type="button"
          onClick={onBack}
          className="rounded border border-border px-2 py-1 text-2xs text-fg-dim hover:bg-bg-input-hover hover:text-fg"
        >
          ← 결과
        </button>
        <input
          aria-label="저장한 검색 찾기"
          placeholder="이름·종목으로 찾기"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="min-w-0 flex-1 rounded border border-border bg-bg-input px-2 py-1 text-xs text-fg"
        />
      </div>
      <div className="px-md pb-xs pt-sm font-data text-2xs text-fg-dimmer">
        {saves.length}개 저장됨
        {query ? ` · ${filtered.length}개 일치` : ` · 종목 ${groupPatternSaves(saves).length}개`}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {groups.length === 0 ? (
          <RailState>
            {saves.length === 0
              ? '저장한 검색이 없다. 결과 화면에서 「저장」 을 눌러 담는다.'
              : `«${query}» 에 맞는 저장이 없다 — 이름·종목명·코드로 찾는다.`}
          </RailState>
        ) : (
          groups.map(([stock, items]) => {
            const open = !collapsed[stock];
            return (
              <div key={stock} className="border-b border-grid">
                <button
                  type="button"
                  aria-expanded={open}
                  onClick={() => setCollapsed((c) => ({ ...c, [stock]: !c[stock] }))}
                  className="flex w-full items-center gap-1.5 px-md py-1.5 text-left text-xs text-fg hover:bg-bg-input-hover"
                >
                  <span className="w-2 text-2xs text-fg-dimmer">{open ? '▾' : '▸'}</span>
                  <span className="truncate">{stock}</span>
                  <span className="ml-auto font-data text-2xs text-fg-dimmer">{items.length}</span>
                </button>
                {open
                  && items.map((s) => (
                    <SaveRow key={s.id} save={s} onPick={onPick} onDelete={onDelete} />
                  ))}
              </div>
            );
          })
        )}
      </div>
    </>
  );
}

function SaveRow({
  save, onPick, onDelete,
}: {
  save: PatternSave; onPick: (s: PatternSave) => void; onDelete: (s: PatternSave) => void;
}) {
  const fixed = save.window.kind === 'fixed';
  return (
    <div
      role="button"
      tabIndex={0}
      data-testid={`pattern-save-${save.id}`}
      onClick={() => onPick(save)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(save); }
      }}
      className="flex cursor-pointer items-center gap-1.5 py-1.5 pl-7 pr-md hover:bg-bg-input-hover"
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs text-fg">{save.name}</div>
        <div className="truncate font-data text-2xs text-fg-dimmer">{conditionLine(save)}</div>
      </div>
      {/* 이름은 사용자가 고칠 수 있어 종류를 잃는다 — 뱃지가 그 축을 보존한다.
          불러왔을 때 **오늘 기준으로 다시 찾을지 그 날로 갈지**가 갈리는 값이다. */}
      <span
        className={
          'shrink-0 rounded-full border px-1.5 text-[9px] '
          + (fixed ? 'border-accent text-accent' : 'border-border text-fg-dim')
        }
      >
        {fixed ? '고정' : '움직임'}
      </span>
      <button
        type="button"
        aria-label={`${save.name} 삭제`}
        onClick={(e) => { e.stopPropagation(); onDelete(save); }}
        className="shrink-0 px-1 text-2xs text-fg-dimmer hover:text-error"
      >
        ✕
      </button>
    </div>
  );
}

/** 항목의 둘째 줄 — 종목은 그룹 헤더가 이미 말하므로 **조건만** 남긴다. */
export function conditionLine(save: PatternSave): string {
  const c = save.conditions;
  const period = c.since
    ? `${c.since.slice(0, 4)}-${c.since.slice(4, 6)} 이후`
    : '전체 기간';
  const parts = [period, `${c.count}개`];
  if (c.sim_floor > 0) parts.push(`유사도 ${c.sim_floor.toFixed(2)}+`);
  if (c.volume_weight > 0) parts.push('거래량');
  return parts.join(' · ');
}
