/** PROTOTYPE — throwaway. 「시장 폭」 지표 시안 스위처. `?breadth=` · ←/→ 키. */
import { useEffect } from 'react';
import { useSearchParams } from 'react-router';
import { BREADTH_VARIANTS, LABELS, MECHANISM, useBreadthVariant } from './breadthVariantState';

export function BreadthSwitcher() {
  const [, setParams] = useSearchParams();
  const variant = useBreadthVariant();

  const apply = (next: string) => {
    setParams(next === 'current' ? {} : { breadth: next }, { replace: true });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const i = BREADTH_VARIANTS.indexOf(variant);
      const d = e.key === 'ArrowRight' ? 1 : -1;
      apply(BREADTH_VARIANTS[(i + d + BREADTH_VARIANTS.length) % BREADTH_VARIANTS.length]);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (!import.meta.env.DEV) return null;

  return (
    <div className="proto-breadth-bar">
      <div className="flex items-center gap-2xs">
        <span className="pr-xs text-2xs text-fg-dimmer">시장 폭 시안</span>
        {BREADTH_VARIANTS.map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => apply(k)}
            aria-pressed={variant === k}
            className={`whitespace-nowrap rounded-md px-2 py-[3px] text-2xs ${
              variant === k ? 'bg-tint-selection text-accent' : 'text-fg-dim hover:bg-bg-input-hover'
            }`}
          >
            {LABELS[k]}
          </button>
        ))}
        <span className="pl-xs text-2xs text-fg-dimmer">←/→</span>
      </div>
      {/* 상태 노출 — 이 시안이 무엇을 말하는지 화면에 그대로 적는다. */}
      <p className="max-w-[900px] text-center text-2xs text-fg-dimmer">{MECHANISM[variant]}</p>
    </div>
  );
}
