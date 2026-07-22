import { useEffect } from 'react';
import { useSearchParams } from 'react-router';

/** PROTOTYPE 전용 부유 전환 바 — 하단 중앙 고정, `?variant=` 를 순환시킨다.
 *  평가 대상 디자인과 헷갈리지 않도록 의도적으로 시스템 토큰 밖 고대비 pill.
 *  프로덕션 게이트는 마운트하는 쪽(모듈 스코프 DEV 삼항)이 담당한다.
 *  프로토타입 정리 시 이 파일도 함께 제거. */
export function PrototypeSwitcher({
  variants,
  names = {},
}: {
  variants: string[];
  names?: Record<string, string>;
}) {
  const [params, setParams] = useSearchParams();
  const current = params.get('variant')?.toUpperCase() ?? variants[0];
  const idx = Math.max(0, variants.indexOf(current));

  const go = (delta: number) => {
    const next = variants[(idx + delta + variants.length) % variants.length];
    const p = new URLSearchParams(params);
    p.set('variant', next);
    setParams(p, { replace: true });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest('input, textarea, [contenteditable]')) return;
      if (e.key === 'ArrowLeft') go(-1);
      if (e.key === 'ArrowRight') go(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <div
      className="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-1 rounded-full px-2 py-1 shadow-modal"
      style={{ background: '#000', color: '#fff', border: '1px solid #444' }}
    >
      <button
        type="button"
        aria-label="이전 시안"
        onClick={() => go(-1)}
        className="grid h-6 w-6 place-items-center rounded-full text-sm hover:bg-white/15"
      >
        ←
      </button>
      <span className="min-w-[9rem] px-1 text-center text-xs font-semibold">
        {current}
        {names[current] ? ` — ${names[current]}` : ''}
      </span>
      <button
        type="button"
        aria-label="다음 시안"
        onClick={() => go(1)}
        className="grid h-6 w-6 place-items-center rounded-full text-sm hover:bg-white/15"
      >
        →
      </button>
    </div>
  );
}
