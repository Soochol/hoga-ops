/** 프로토타입 변형 스위처 — **버려질 코드다**. 승자를 접은 뒤 main 에서 삭제한다.
 *
 *  프로덕션 빌드에서는 렌더하지 않는다(`import.meta.env.PROD`) — 프로토타입이 실수로
 *  머지돼도 사용자에게 바가 보이지 않는다.
 */
import { useEffect } from 'react';
import { useSearchParams } from 'react-router';

export const VARIANTS = [
  { key: 'A', name: '주체 토글 + 순매수 랭킹' },
  { key: 'B', name: '업종 × 주체 매트릭스' },
  { key: 'C', name: '등락률 × 외국인 산점도' },
  // 교체 판단이라 **빼는 쪽**도 사이클에 넣는다 — 나란히 못 보면 "새 게 좋아 보인다"
  // 는 착시가 이긴다.
  { key: 'BREADTH', name: '현행 시장 폭 (비교용)' },
] as const;

export type VariantKey = (typeof VARIANTS)[number]['key'];

export function useVariant(): VariantKey {
  const [params] = useSearchParams();
  const raw = params.get('variant')?.toUpperCase();
  return (VARIANTS.some((v) => v.key === raw) ? raw : 'A') as VariantKey;
}

export function PrototypeSwitcher() {
  const [params, setParams] = useSearchParams();
  const current = useVariant();
  const idx = VARIANTS.findIndex((v) => v.key === current);

  const go = (delta: number) => {
    const next = VARIANTS[(idx + delta + VARIANTS.length) % VARIANTS.length].key;
    const p = new URLSearchParams(params);
    p.set('variant', next);
    setParams(p, { replace: true });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.key === 'ArrowLeft') go(-1);
      if (e.key === 'ArrowRight') go(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (import.meta.env.PROD) return null;

  return (
    <div className="fixed bottom-12 left-1/2 z-50 -translate-x-1/2">
      <div className="flex items-center gap-2 rounded-full bg-fg px-2 py-1 text-bg shadow-lg">
        <button type="button" onClick={() => go(-1)} className="px-2 py-0.5 text-sm">
          ←
        </button>
        <span className="min-w-[15rem] text-center font-data text-xs tabular-nums">
          {current} — {VARIANTS[idx].name}
        </span>
        <button type="button" onClick={() => go(1)} className="px-2 py-0.5 text-sm">
          →
        </button>
      </div>
    </div>
  );
}
