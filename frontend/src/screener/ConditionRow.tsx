import type { ConditionLeaf } from '../api/screener';
import { CONDITION_CATALOG } from './catalog';

export function ConditionRow({ leaf, onChange, onClone, onRemove }: {
  leaf: ConditionLeaf; onChange: (next: ConditionLeaf) => void; onClone: () => void; onRemove: () => void;
}) {
  const entry = CONDITION_CATALOG[leaf.type];
  const ParamForm = entry.ParamForm;
  return (
    <div className="border border-border bg-bg-subtle rounded-md overflow-hidden">
      <div className="flex items-center gap-2 px-2.5 py-1.5">
        <span className="text-sm font-medium">{entry.label}</span>
        <span className="font-mono text-xs text-fg-dim">{entry.summarize(leaf.params)}</span>
        <button type="button" aria-label="조건 복제" onClick={onClone}
          className="ml-auto text-fg-dimmer hover:text-fg bg-transparent border-none cursor-pointer leading-none text-xs">복제</button>
        <button type="button" aria-label="조건 제거" onClick={onRemove}
          className="text-fg-dimmer hover:text-fg bg-transparent border-none cursor-pointer leading-none">×</button>
      </div>
      <div className="px-2.5 pb-2.5">
        <ParamForm params={leaf.params} onChange={(params: ConditionLeaf['params']) => onChange({ ...leaf, params } as ConditionLeaf)} />
      </div>
    </div>
  );
}
