import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import type { CalculationPolicy, ConditionLeaf, ConditionType } from '../api/screener';
import { SettingsEditor, SettingsEditorNavItem } from '../live/settings/SettingsEditor';
import { AppIcon } from '../ui/AppIcon';
import { ChevronIcon } from '../ui/ChevronIcon';
import { ModalShell } from '../ui/ModalShell';
import { SegmentedControl } from '../ui/SegmentedControl';
import { catalogEntry, makeLeaf } from './catalog';
import { CONDITION_GROUPS } from './ConditionBuilderHelpers';
import { ConditionExpressionControl } from './ConditionExpressionControl';
import { ConditionParameters } from './ConditionParameters';
import { conditionLabel, expressionError } from './conditionExpression';
import { NumericInputValidationContext, useNumericInputValidation } from './numericInputValidation';
import '../live/settings/CompactSettings.css';
import './ConditionSettingsDialog.css';

export type ConditionEditorMode = 'mine' | 'catalog';

function DraftForm({ leaf, calculationPolicy, onChange, onInvalid }: {
  leaf: ConditionLeaf; calculationPolicy?: CalculationPolicy; onChange: (leaf: ConditionLeaf) => void;
  onInvalid: (invalid: boolean) => void;
}) {
  const validation = useNumericInputValidation();
  useEffect(() => { onInvalid(validation.invalid); }, [validation.invalid, onInvalid]);
  return <NumericInputValidationContext.Provider value={validation.report}>
    <ConditionParameters leaf={leaf} calculationPolicy={calculationPolicy} onChange={onChange} settings />
  </NumericInputValidationContext.Provider>;
}

export function ConditionSettingsDialog({ open, conditions, calculationPolicy, expression, expressionScope,
  initialMode, initialId, initialType, onConditionsChange, onExpressionChange, onCatalogSelect, onClose }: {
  open: boolean; conditions: ConditionLeaf[]; calculationPolicy?: CalculationPolicy; expression?: string | null;
  expressionScope?: string | null; initialMode: ConditionEditorMode; initialId?: string; initialType: ConditionType;
  onConditionsChange: (conditions: ConditionLeaf[]) => void; onExpressionChange?: (text: string) => void;
  onCatalogSelect: (type: ConditionType) => void; onClose: () => void;
}) {
  const [mode, setMode] = useState(initialMode);
  const [selectedId, setSelectedId] = useState(initialId);
  const [selectedType, setSelectedType] = useState(initialType);
  const [drafts, setDrafts] = useState<Record<string, ConditionLeaf>>(() => ({ [initialType]: makeLeaf(initialType) }));
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState(() => new Set(CONDITION_GROUPS.filter(([, types]) => types.includes(initialType)).map(([label]) => label)));
  const [invalidDraft, setInvalidDraft] = useState(false);
  const [lastAdded, setLastAdded] = useState('');
  const [helpOpen, setHelpOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null), navRef = useRef<HTMLElement>(null), contentRef = useRef<HTMLDivElement>(null);
  const groupId = useId();
  const selected = mode === 'catalog' ? drafts[selectedType] : conditions.find(c => c.id === selectedId) ?? conditions[0];
  const index = selected ? conditions.findIndex(c => c.id === selected.id) : -1;
  const entry = selected ? catalogEntry(selected.type) : null;
  const invalidExpression = expressionError(expression, conditions.length);
  const normalizedQuery = query.trim().toLocaleLowerCase().replaceAll(/\s+/g, '');
  const matches = (text: string) => text.toLocaleLowerCase().replaceAll(/\s+/g, '').includes(normalizedQuery);
  useEffect(() => {
    if (!open) {
      setDrafts({ [selectedType]: makeLeaf(selectedType) }); setInvalidDraft(false);
      return;
    }
    setMode(initialMode); setSelectedId(initialId); setQuery(''); setLastAdded(''); setHelpOpen(false);
  }, [open, initialMode, initialId]);

  useLayoutEffect(() => { if (contentRef.current) contentRef.current.scrollTop = 0; }, [mode, selected?.id]);
  const chooseType = (type: ConditionType) => {
    setDrafts(previous => previous[type] ? previous : { ...previous, [type]: makeLeaf(type) });
    setSelectedType(type); onCatalogSelect(type); setLastAdded(''); setHelpOpen(false);
  };
  const changeMode = (next: ConditionEditorMode) => {
    setMode(next); setQuery(''); setLastAdded(''); setHelpOpen(false);
  };
  const onSearchKey = (event: KeyboardEvent<HTMLElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Escape' && query) { event.stopPropagation(); setQuery(''); searchRef.current?.focus(); }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const rows = [...navRef.current?.querySelectorAll<HTMLButtonElement>('[data-condition-option]') ?? []];
    if (!rows.length) return;
    const current = rows.indexOf(document.activeElement as HTMLButtonElement);
    const next = current < 0 ? (event.key === 'ArrowDown' ? 0 : rows.length - 1)
      : (current + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
    event.preventDefault(); rows[next].focus();
  };
  const add = () => {
    if (!selected || invalidDraft || invalidExpression) return;
    const added = { ...structuredClone(selected), id: makeLeaf(selected.type).id };
    onConditionsChange([...conditions, added]);
    setLastAdded(`${conditionLabel(conditions.length)} · ${catalogEntry(added.type).label} 추가됨`);
  };

  return createPortal(<ModalShell open={open} ariaLabel="조건 설정" width="w-[880px]" height="h-[min(860px,86vh)]" onClose={onClose}>
    <SettingsEditor title="조건 설정" scope="현재 조건검색" onClose={onClose} closeLabel="조건 설정 닫기"
      testId="condition-settings-dialog" className="settings-compact screener-condition-editor"
      footer={mode === 'catalog' ? lastAdded || '추가 전' : '현재 조건검색에 반영 · 저장은 메인에서'} statusIcon={null}
      footerAction={<><button type="button" onClick={onClose}>닫기</button>
        {mode === 'catalog' && <button type="button" className="condition-catalog-add" disabled={!selected || invalidDraft || !!invalidExpression} onClick={add}>추가</button>}</>}
      sidebar={<nav ref={navRef} className="condition-picker" aria-label="조건 목록" onKeyDown={onSearchKey}>
        <SegmentedControl label="조건 목록 보기" value={mode} onChange={changeMode}
          options={[{ value: 'mine', label: `내 조건 ${conditions.length}` }, { value: 'catalog', label: '조건 추가' }]} />
        <label className="condition-picker-search"><AppIcon name="search" />
          <input ref={searchRef} data-modal-autofocus aria-label="조건 검색" placeholder="조건 검색" value={query}
            onChange={event => setQuery(event.currentTarget.value)} />
        </label>
        <div className="condition-picker-list">
          {mode === 'catalog' ? CONDITION_GROUPS.map(([label, types], groupIndex) => {
            const visible = types.filter(type => matches(label) || matches(catalogEntry(type).label));
            if (!visible.length) return null;
            const open = !!normalizedQuery || expanded.has(label), id = `${groupId}-${groupIndex}`;
            return <section key={label}>
              <button type="button" className="condition-picker-group" aria-expanded={open} aria-controls={id}
                onClick={() => setExpanded(previous => { const next = new Set(previous); if (next.has(label)) next.delete(label); else next.add(label); return next; })}>
                <ChevronIcon collapsed={!open} size={14} /><span>{label}</span><span>{types.length}</span>
              </button>
              {open && <div id={id}>{visible.map(type => <SettingsEditorNavItem key={type} active={selectedType === type}
                data-condition-option aria-label={`${catalogEntry(type).label} 선택`} onClick={() => chooseType(type)}>
                {catalogEntry(type).label}
              </SettingsEditorNavItem>)}</div>}
            </section>;
          }) : conditions.map((leaf, i) => matches(`${conditionLabel(i)} ${catalogEntry(leaf.type).label}`)
            ? <SettingsEditorNavItem key={leaf.id} active={selected?.id === leaf.id} data-condition-option
              aria-label={`${conditionLabel(i)} ${catalogEntry(leaf.type).label} 설정`}
              onClick={() => { setSelectedId(leaf.id); setHelpOpen(false); }}>
              <span><span className="condition-picker-letter font-data">{conditionLabel(i)}</span>{catalogEntry(leaf.type).label}
                <span className="condition-picker-summary">{catalogEntry(leaf.type).summarize(leaf.params)}</span></span>
            </SettingsEditorNavItem> : null)}
          {mode === 'mine' && !conditions.length && <p>조건 추가에서 원하는 조건을 선택하세요.</p>}
          {!!normalizedQuery && !(mode === 'catalog' ? CONDITION_GROUPS.some(([label, types]) => matches(label) || types.some(t => matches(catalogEntry(t).label)))
            : conditions.some((leaf, i) => matches(`${conditionLabel(i)} ${catalogEntry(leaf.type).label}`))) && <p>일치하는 조건이 없습니다.</p>}
        </div>
      </nav>}>
      <div ref={contentRef} className="settings-editor-content condition-settings-content">
        {mode === 'mine' && onExpressionChange && <ConditionExpressionControl conditions={conditions}
          expression={expression} scope={expressionScope} onChange={onExpressionChange} />}
        {selected && entry ? <>
          <div className="condition-detail-heading"><h3>{mode === 'mine' ? `${conditionLabel(index)} · ` : ''}{entry.label}</h3>
            {entry.help && <button type="button" className="ui-icon-button" aria-label={`${entry.label} 도움말`}
              aria-expanded={helpOpen} onClick={() => setHelpOpen(value => !value)}><AppIcon name="help" /></button>}
            {mode === 'mine' && <button type="button" className="condition-detail-remove" aria-label="조건 제거"
              disabled={!!invalidExpression} onClick={() => onConditionsChange(conditions.filter(c => c.id !== selected.id))}>삭제</button>}
          </div>
          {helpOpen && <p className="condition-settings-help">{entry.help}</p>}
        </> : <p className="condition-settings-empty">추가한 조건이 없습니다.</p>}
        {conditions.map(leaf => <div key={leaf.id} hidden={mode !== 'mine' || selected?.id !== leaf.id}
          role="group" aria-label={`${catalogEntry(leaf.type).label} 조건`} className="condition-settings-parameters">
          <ConditionParameters leaf={leaf} calculationPolicy={calculationPolicy} settings
            onChange={next => onConditionsChange(conditions.map(c => c.id === next.id ? next : c))} />
        </div>)}
        {mode === 'catalog' && selected && <div key={selected.id} role="group" aria-label={`${entry!.label} 조건`} className="condition-settings-parameters">
          <DraftForm leaf={selected} calculationPolicy={calculationPolicy} onInvalid={setInvalidDraft}
            onChange={next => setDrafts(previous => ({ ...previous, [selectedType]: next }))} />
        </div>}
        {entry && selected && <div className="condition-settings-summary"><span>조건 요약</span><p>{entry.summarize(selected.params)}</p></div>}
        {mode === 'catalog' && invalidExpression && <p role="alert" className="condition-expression-error">내 조건의 조합식을 먼저 확인하세요. {invalidExpression}</p>}
      </div>
    </SettingsEditor>
  </ModalShell>, document.body);
}
