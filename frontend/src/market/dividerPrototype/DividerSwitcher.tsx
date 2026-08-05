/**
 * PROTOTYPE — throwaway. /market 카드 구분 시안 스위처 (main 병합 금지).
 *
 * 질문: "카드가 한 덩어리로 읽힌다 — 무엇으로 카드를 분리해야 하나?"
 * `?variant=` 로 전환(공유·새로고침 안정), ←/→ 키 순환. PROD 에선 아무것도 안 그린다.
 */
import { useEffect } from 'react';
import { useSearchParams } from 'react-router';
import { DIVIDER_VARIANTS, LABELS, MECHANISM, useDividerVariant } from './dividerVariantState';
import './dividerPrototype.css';

export function DividerSwitcher() {
  const [, setParams] = useSearchParams();
  const variant = useDividerVariant();

  const apply = (next: string) => {
    setParams(next === 'current' ? {} : { variant: next }, { replace: true });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const i = DIVIDER_VARIANTS.indexOf(variant);
      const d = e.key === 'ArrowRight' ? 1 : -1;
      apply(DIVIDER_VARIANTS[(i + d + DIVIDER_VARIANTS.length) % DIVIDER_VARIANTS.length]);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (!import.meta.env.DEV) return null;

  return (
    <div className="proto-divider-bar">
      <div className="flex items-center gap-2xs">
        <span className="pr-xs text-2xs text-fg-dimmer">구분 시안</span>
        {DIVIDER_VARIANTS.map((k) => (
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
      {/* 상태 노출 — 지금 무엇이 분리를 담당하는지 화면에 그대로 적는다. */}
      <p className="max-w-[820px] text-center text-2xs text-fg-dimmer">{MECHANISM[variant]}</p>
    </div>
  );
}
