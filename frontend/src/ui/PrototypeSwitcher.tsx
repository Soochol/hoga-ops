/**
 * PROTOTYPE ONLY — main 머지 금지. 폐기 전제 코드.
 *
 * `?variant=` 를 순환시키는 플로팅 바. 평가 대상 디자인과 섞이지 않도록
 * 일부러 고대비 알약 모양이며, 프로덕션 빌드에서는 렌더하지 않는다.
 */
import { useEffect } from 'react';
import { useSearchParams } from 'react-router';

export function usePrototypeVariant(variants: readonly string[]): string {
  const [params] = useSearchParams();
  const raw = params.get('variant') ?? variants[0];
  return variants.includes(raw) ? raw : variants[0];
}

export function PrototypeSwitcher({
  variants,
  labels,
}: {
  variants: readonly string[];
  labels: Record<string, string>;
}) {
  const [params, setParams] = useSearchParams();
  const current = usePrototypeVariant(variants);

  const go = (delta: number) => {
    const i = variants.indexOf(current);
    const next = variants[(i + delta + variants.length) % variants.length];
    const p = new URLSearchParams(params);
    p.set('variant', next);
    setParams(p, { replace: true });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.key === 'ArrowLeft') go(-1);
      else if (e.key === 'ArrowRight') go(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (import.meta.env.PROD) return null;

  return (
    <div
      data-testid="prototype-switcher"
      className="fixed bottom-4 left-1/2 z-[9999] flex -translate-x-1/2 items-center gap-1 rounded-full bg-black/85 px-2 py-1 text-white shadow-2xl ring-1 ring-white/25 backdrop-blur"
      style={{ fontFamily: 'ui-monospace, monospace' }}
    >
      <button
        type="button"
        onClick={() => go(-1)}
        className="rounded-full px-2 py-0.5 text-sm hover:bg-white/20"
        aria-label="이전 변형"
      >
        ←
      </button>
      <span className="min-w-[190px] select-none px-1 text-center text-xs">
        <b>{current}</b> — {labels[current]}
      </span>
      <button
        type="button"
        onClick={() => go(1)}
        className="rounded-full px-2 py-0.5 text-sm hover:bg-white/20"
        aria-label="다음 변형"
      >
        →
      </button>
    </div>
  );
}
