// ============================================================================
// PROTOTYPE — throwaway. 하단 중앙 플로팅 변형 스위처. `?variant=` 를 순환한다.
// 평가 대상 디자인과 헷갈리지 않도록 고대비 pill + 프로덕션 빌드에서는 렌더 안 함.
// ============================================================================
import { useEffect } from 'react';
import { useSearchParams } from 'react-router';

export const PROTOTYPE_VARIANTS = ['current', 'a', 'b', 'c'] as const;
export type PrototypeVariant = (typeof PROTOTYPE_VARIANTS)[number];

const VARIANT_LABELS: Record<PrototypeVariant, string> = {
  current: '현행',
  a: 'A — 정제된 3단',
  b: 'B — 2단 워크벤치',
  c: 'C — 결과 전면 + 조건 칩',
};

export function usePrototypeVariant(): PrototypeVariant {
  const [params] = useSearchParams();
  const raw = params.get('variant') ?? 'current';
  const v = (PROTOTYPE_VARIANTS as readonly string[]).includes(raw)
    ? (raw as PrototypeVariant)
    : 'current';
  return import.meta.env.PROD ? 'current' : v;
}

export function PrototypeSwitcher() {
  const [params, setParams] = useSearchParams();
  const current = usePrototypeVariant();
  const idx = PROTOTYPE_VARIANTS.indexOf(current);

  const go = (delta: number) => {
    const n = PROTOTYPE_VARIANTS.length;
    const next = PROTOTYPE_VARIANTS[(idx + delta + n) % n];
    const nextParams = new URLSearchParams(params);
    if (next === 'current') nextParams.delete('variant');
    else nextParams.set('variant', next);
    setParams(nextParams, { replace: true });
  };

  useEffect(() => {
    if (import.meta.env.PROD) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idx, params]);

  if (import.meta.env.PROD) return null;

  return (
    <div
      className="fixed bottom-10 left-1/2 z-[100] flex -translate-x-1/2 items-center gap-1 rounded-full border px-2 py-1 shadow-overlay"
      style={{ background: 'var(--fg)', color: 'var(--bg)', borderColor: 'var(--fg)' }}
    >
      <button type="button" aria-label="이전 변형" onClick={() => go(-1)}
        className="px-2 py-0.5 text-sm leading-none hover:opacity-70">←</button>
      <span className="min-w-[11rem] text-center font-data text-xs font-semibold tabular-nums">
        {VARIANT_LABELS[current]}
      </span>
      <button type="button" aria-label="다음 변형" onClick={() => go(1)}
        className="px-2 py-0.5 text-sm leading-none hover:opacity-70">→</button>
    </div>
  );
}
