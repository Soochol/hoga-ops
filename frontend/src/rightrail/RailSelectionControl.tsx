export function RailSelectionControl({ active, count, onToggle, disabled = false }: {
  active: boolean; count: number; onToggle: () => void; disabled?: boolean;
}) {
  return <div className="flex min-h-7 items-center gap-2 text-xs">
    <button type="button" aria-label={active ? "선택 완료" : "다중 선택"} aria-pressed={active} onClick={onToggle} disabled={disabled}
      className="h-7 shrink-0 rounded px-2 text-accent hover:bg-bg-input-hover disabled:opacity-40 disabled:cursor-not-allowed">
      {active ? '선택 완료' : '다중 선택'}
    </button>
    {active && <span role="status" className="text-fg-dim">{count}개 선택</span>}
  </div>;
}
