/** 프로토타입 변형 스위처 — **버려질 코드다**. 승자를 접은 뒤 main 에서 삭제한다.
 *
 *  프로덕션 빌드에서는 렌더하지 않는다(`import.meta.env.PROD`) — 프로토타입이 실수로
 *  머지돼도 사용자에게 바가 보이지 않는다.
 */
import { useEffect } from 'react';
import { useSearchParams } from 'react-router';

export const VARIANTS = [
  { key: 'A', name: '상품 선택기 (현행 골격 · 억원 축)' },
  { key: 'B', name: '7상품 동시 보드 (계약수 축)' },
  { key: 'C', name: '콜/풋 대칭 포지션 보드' },
  // 이건 "추가" 판단이라 **안 넣은 쪽**도 사이클에 있어야 한다 — 새 카드만 보면
  // 늘 좋아 보이고, 정작 갈리는 건 옆 카드들과의 밀도다.
  { key: 'CURRENT', name: '현행 주식 수급 (비교용)' },
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
        <span className="min-w-[18rem] text-center font-data text-xs tabular-nums">
          {current} — {VARIANTS[idx].name}
        </span>
        <button type="button" onClick={() => go(1)} className="px-2 py-0.5 text-sm">
          →
        </button>
      </div>
    </div>
  );
}
