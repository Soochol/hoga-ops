// ============================================================================
// PROTOTYPE — throwaway. 변형 C "결과 전면 + 조건 칩 바": 좌측 칼럼을 전부
// 없애고 조건을 상단 가로 칩으로 표현한다. 칩 클릭 → 파라미터 편집 팝오버,
// ＋ 조건 칩 → 추가 메뉴. 결과 테이블이 화면 전폭의 주인공이 된다.
// (제안 ⑥⑦의 가장 급진적인 답 — 토스 증권/일반 스크리너 계열의 정보 위계)
// ============================================================================
import { useRef, useState } from 'react';
import { PageContainer } from '../../layout/PageContainer';
import { CONDITION_CATALOG, makeLeaf } from '../catalog';
import { CONDITION_GROUPS } from '../ConditionBuilder';
import { UniverseFilterButton } from '../UniverseFilterButton';
import { DataSection } from '../../ui/DataSurface';
import { ControlBar, PanelCard, SegmentedControl, ToolbarButton } from '../../ui/PageShell';
import { useDismissablePopover } from '../../util/useDismissablePopover';
import { useClampedFixedPosition } from '../../util/useClampedFixedPosition';
import type { ConditionLeaf, ConditionType } from '../../api/screener';
import { ResultsBody, ResultsMetaLine, TopFlagBanner, splitFlags } from './resultsBits';
import type { ScreenerViewProps } from './variantShared';

/** 조건 1개 = 칩 1개. 클릭하면 아래로 파라미터 편집 팝오버(fixed + 클램프). */
function ConditionChip({ leaf, onChange, onRemove }: {
  leaf: ConditionLeaf;
  onChange: (next: ConditionLeaf) => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  useDismissablePopover(open, wrapRef, () => setOpen(false));
  const { ref: popRef, left, top } = useClampedFixedPosition<HTMLDivElement>(
    anchorRect?.left ?? 0,
    anchorRect ? anchorRect.bottom + 4 : 0,
  );
  const entry = CONDITION_CATALOG[leaf.type];
  const ParamForm = entry.ParamForm;
  const toggle = () => {
    const next = !open;
    if (next && btnRef.current) setAnchorRect(btnRef.current.getBoundingClientRect());
    setOpen(next);
  };
  return (
    <div ref={wrapRef} className="relative">
      <button ref={btnRef} type="button" aria-expanded={open}
        aria-label={`${entry.label} 조건 편집`} onClick={toggle}
        className={`inline-flex max-w-[20rem] items-center gap-1.5 rounded-full border px-2.5 py-1 text-sm ${
          open ? 'border-border-strong bg-tint-selection text-fg' : 'border-border bg-bg-input text-fg hover:bg-bg-input-hover'}`}>
        <span className="shrink-0 font-medium">{entry.label}</span>
        <span className="truncate font-data text-xs text-fg-dim">{entry.summarize(leaf.params)}</span>
      </button>
      {open && anchorRect && (
        <div ref={popRef} role="dialog" aria-label={`${entry.label} 조건 편집`}
          className="z-50 w-[21rem] rounded-md border border-border-strong bg-bg-card p-2.5 shadow-overlay"
          style={{ position: 'fixed', left, top }}>
          <div className="mb-2 flex items-center gap-2">
            <span className="text-sm font-medium text-fg">{entry.label}</span>
            <button type="button" aria-label="조건 제거"
              onClick={() => { setOpen(false); onRemove(); }}
              className="ml-auto rounded px-1.5 py-0.5 text-xs text-fg-dim hover:bg-bg-input-hover hover:text-fg">
              제거
            </button>
          </div>
          <ParamForm params={leaf.params}
            onChange={(params: ConditionLeaf['params']) => onChange({ ...leaf, params } as ConditionLeaf)} />
        </div>
      )}
    </div>
  );
}

/** ＋ 조건 칩 — ConditionBuilder 의 그룹 메뉴를 팝오버로 재사용. */
function AddConditionChip({ onAdd }: { onAdd: (t: ConditionType) => void }) {
  const [open, setOpen] = useState(false);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  useDismissablePopover(open, wrapRef, () => setOpen(false));
  const { ref: menuRef, left, top } = useClampedFixedPosition<HTMLUListElement>(
    anchorRect?.left ?? 0,
    anchorRect ? anchorRect.bottom + 4 : 0,
  );
  const toggle = () => {
    const next = !open;
    if (next && btnRef.current) setAnchorRect(btnRef.current.getBoundingClientRect());
    setOpen(next);
  };
  return (
    <div ref={wrapRef} className="relative">
      <button ref={btnRef} type="button" aria-label="조건 추가" aria-expanded={open} onClick={toggle}
        className="inline-flex items-center gap-1 rounded-full border border-dashed border-border-strong px-2.5 py-1 text-sm text-fg-dim hover:bg-bg-input-hover">
        ＋ 조건
      </button>
      {open && anchorRect && (
        <ul ref={menuRef} role="menu"
          className="z-50 max-h-[24rem] w-[15rem] overflow-auto rounded-lg border border-border-strong bg-bg-card shadow-overlay"
          style={{ position: 'fixed', left, top }}>
          {CONDITION_GROUPS.map(([label, types]) => (
            <li key={label} role="none">
              <div className="px-3 pt-2 pb-1 text-2xs font-semibold uppercase text-fg-dim">{label}</div>
              <ul role="none">
                {types.map((t) => (
                  <li key={t} role="none">
                    <button type="button" role="menuitem"
                      onClick={() => { onAdd(t); setOpen(false); }}
                      className="w-full px-3 py-2 text-left text-sm text-fg hover:bg-bg-input-hover">
                      {CONDITION_CATALOG[t].label}
                    </button>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function VariantC(p: ScreenerViewProps) {
  const { banner, chips } = splitFlags(p);
  const replace = (id: string, next: ConditionLeaf) =>
    p.editor.editConditions(p.editor.conditions.map((c) => (c.id === id ? next : c)));
  const remove = (id: string) =>
    p.editor.editConditions(p.editor.conditions.filter((c) => c.id !== id));
  return (
    <PageContainer className="flex min-h-0 flex-col gap-md !pb-0">
      <PanelCard borderless flat className="flex min-h-0 flex-1 flex-col">
        <div className="flex flex-col gap-sm p-md pb-sm">
          <ControlBar className="flex-wrap">
            <select
              aria-label="저장한 조건검색 선택"
              value={p.editor.anchorId ?? ''}
              onChange={(e) => {
                const id = e.target.value;
                if (!id) { p.editor.newDraft(); return; }
                const s = p.saves.find((x) => x.id === id);
                if (s) p.editor.load(s);
              }}
              className="max-w-[14rem] rounded-md border border-border bg-bg-input px-2 py-1.5 text-sm font-semibold text-fg"
            >
              <option value="">새 조건검색</option>
              {p.saves.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
            {p.editor.dirty && <span className="text-2xs text-fg-dim">수정됨</span>}
            <ToolbarButton onClick={p.saveCurrent} disabled={p.editor.isSaving} className="text-fg">
              {p.editor.isSaving ? '저장 중…' : '저장'}
            </ToolbarButton>
            <ToolbarButton onClick={p.openSaveAs} disabled={p.editor.isSaving}>
              다른 이름으로
            </ToolbarButton>
            <div className="min-w-0 flex-1" />
            <SegmentedControl aria-label="스크리너 기준">
              {(['intraday', 'eod'] as const).map((value) => (
                <button key={value} type="button" onClick={() => p.setBasis(value)}
                  title={value === 'intraday' ? '조건검색 실행 시 오늘 KIS quote를 일봉 위에 임시 반영합니다' : undefined}
                  className={`px-3 py-[7px] text-sm ${p.basis === value ? 'bg-tint-selection text-accent' : 'text-fg-dim hover:bg-bg-input-hover'}`}>
                  {value === 'intraday' ? '오늘 장중' : '전일 확정'}
                </button>
              ))}
            </SegmentedControl>
            <ToolbarButton tone="primary" onClick={p.runScan}
              disabled={p.scanPending || p.notSeeded || !p.hasConditions}
              className="px-lg py-sm text-base">
              {p.scanPending ? '조회 중…' : '조회'}
            </ToolbarButton>
            {!p.notSeeded && (
              <ToolbarButton aria-label="데이터 갱신" onClick={p.onUpdate}
                disabled={p.updatePending || p.serverUpdating}>
                {p.updatePending || p.serverUpdating ? '갱신 중…' : '갱신'}
              </ToolbarButton>
            )}
            {p.updateFailed && <span className="text-sm" style={{ color: 'var(--error)' }}>갱신 실패</span>}
            {p.updateFeedback && (
              <span className="text-sm text-fg-dim">{p.updateFeedback.message}</span>
            )}
          </ControlBar>

          {/* 조건 칩 줄 — AND 결합이라 나열 순서에 의미가 없어 DnD 를 생략한다. */}
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-2xs font-semibold uppercase text-fg-dim">조건 · 모두 충족</span>
            {p.editor.conditions.map((leaf) => (
              <ConditionChip key={leaf.id} leaf={leaf}
                onChange={(next) => replace(leaf.id, next)}
                onRemove={() => remove(leaf.id)} />
            ))}
            <AddConditionChip onAdd={(t) => p.editor.editConditions([...p.editor.conditions, makeLeaf(t)])} />
            <UniverseFilterButton universe={p.editor.universe} onChange={p.editor.editUniverse} />
          </div>
          {p.editor.saveError && (
            <div className="text-xs" style={{ color: 'var(--error)' }}>
              저장 실패: {p.editor.saveError.message}
            </div>
          )}
        </div>

        <DataSection title="결과" flushHeader className="flex min-h-0 flex-1 flex-col"
          contentClassName="flex min-h-0 flex-1 flex-col gap-sm p-md">
          <ResultsMetaLine p={p} chips={chips} />
          <TopFlagBanner banner={banner} />
          <ResultsBody p={p} />
        </DataSection>
      </PanelCard>
    </PageContainer>
  );
}
