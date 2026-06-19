import { useRef, useState } from 'react';
import type { ConditionLeaf, ConditionType, ScreenerUniverse } from '../api/screener';
import { CONDITION_CATALOG, makeLeaf } from './catalog';
import { ConditionRow } from './ConditionRow';
import { UniverseFilterButton } from './UniverseFilterButton';
import { useDismissablePopover } from '../util/useDismissablePopover';
import { useClampedFixedPosition } from '../util/useClampedFixedPosition';

export function ConditionBuilder({ conditions, universe, onConditionsChange, onUniverseChange }: {
  conditions: ConditionLeaf[]; universe: ScreenerUniverse;
  onConditionsChange: (c: ConditionLeaf[]) => void; onUniverseChange: (u: ScreenerUniverse) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  // Outside-mousedown / Escape dismissal for the add-condition menu only.
  useDismissablePopover(menuOpen, wrapRef, () => setMenuOpen(false));
  // 버튼 아래로 떠 화면 밖으로 넘치면 가장자리로 슬라이드(공용 클램프).
  const { ref: menuRef, left, top } = useClampedFixedPosition<HTMLUListElement>(
    anchorRect?.left ?? 0,
    anchorRect ? anchorRect.bottom + 4 : 0,
  );

  const toggleMenu = () => {
    const next = !menuOpen;
    if (next && btnRef.current) setAnchorRect(btnRef.current.getBoundingClientRect());
    setMenuOpen(next);
  };
  const add = (t: ConditionType) => { onConditionsChange([...conditions, makeLeaf(t)]); setMenuOpen(false); };
  const replace = (id: string, next: ConditionLeaf) => onConditionsChange(conditions.map((c) => c.id === id ? next : c));
  const remove = (id: string) => onConditionsChange(conditions.filter((c) => c.id !== id));

  const grouped: Array<[string, ConditionType[]]> = [
    ['가격', ['price_range']],
    ['거래대금', ['trade_value', 'trade_value_period']],
    ['신고가/거래량', ['new_high_today', 'new_high', 'new_high_vol_today', 'new_high_vol']],
    ['이동평균', ['ma']],
    ['등락률', ['change_pct']],
  ];

  return (
    <div className="bg-bg-card border rounded-lg p-md flex flex-col gap-sm min-h-0 overflow-auto">
      {/* Header: [조건 추가 (flex-1)] [사전필터 버튼]. 전역 사전필터는 버튼이 여는
          UniverseFilterModal 로 이동(빌더 카드 정리). */}
      <div className="flex gap-sm items-stretch">
        <div ref={wrapRef} className="relative flex-1">
          <button ref={btnRef} type="button" aria-label="조건 추가" aria-expanded={menuOpen} onClick={toggleMenu}
            className="w-full border border-dashed border-border-strong rounded-md text-fg-dim text-sm py-2 hover:bg-bg-input-hover">
            ＋ 조건 추가 ▾
          </button>
          {menuOpen && anchorRect && (
            <ul ref={menuRef} role="menu"
              className="bg-bg-card border border-border-strong rounded-[6px] shadow-[0_8px_24px_rgba(0,0,0,0.4)] overflow-hidden z-50"
              style={{ position: 'fixed', top, left, width: anchorRect.width }}>
              {grouped.map(([label, types]) => (
                <li key={label} role="none">
                  <div className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-fg-dimmer">{label}</div>
                  <ul role="none">
                    {types.map((t) => (
                      <li key={t} role="none"><button type="button" role="menuitem" aria-label={CONDITION_CATALOG[t].label} onClick={() => add(t)}
                        className="w-full text-left px-3 py-2 text-sm text-fg hover:bg-bg-input-hover">{CONDITION_CATALOG[t].label}</button></li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </div>
        <UniverseFilterButton universe={universe} onChange={onUniverseChange} />
      </div>

      {conditions.length > 0 && (
        <div className="text-[10px] tracking-[0.06em] text-fg-dimmer text-center">모두 충족 · AND</div>
      )}
      {conditions.map((leaf) => (
        <ConditionRow key={leaf.id} leaf={leaf} onChange={(n) => replace(leaf.id, n)} onRemove={() => remove(leaf.id)} />
      ))}
    </div>
  );
}
