/** 프로토타입 변형 스위처 — **버려질 코드다**. 승자를 접은 뒤 main 에서 삭제한다.
 *
 *  프로덕션 빌드에서는 렌더하지 않는다(`import.meta.env.PROD`) — 프로토타입이 실수로
 *  머지돼도 사용자에게 바가 보이지 않는다.
 */
import { useEffect } from 'react';
import { useSearchParams } from 'react-router';
import { TAB_STYLES, TAB_STYLE_NAMES, type TabStyle } from './ProductTabs';

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

/** 선택기 시안은 **두 번째 축**이다 — 변형 A 안에서만 의미가 있으므로 variant 사이클에
 *  섞지 않는다. 섞으면 목록이 7개가 되고 "레이아웃 판단" 과 "컨트롤 판단" 이 한 줄에서
 *  뒤엉킨다. ↑/↓ 로 돈다. */
export function useTabStyle(): TabStyle {
  const [params] = useSearchParams();
  const raw = params.get('tabs')?.toUpperCase();
  return (TAB_STYLES.some((t) => t === raw) ? raw : 'T1') as TabStyle;
}

export function PrototypeSwitcher() {
  const [params, setParams] = useSearchParams();
  const current = useVariant();
  const tab = useTabStyle();
  const idx = VARIANTS.findIndex((v) => v.key === current);
  const tabIdx = TAB_STYLES.indexOf(tab);

  const set = (key: string, value: string) => {
    const p = new URLSearchParams(params);
    p.set(key, value);
    setParams(p, { replace: true });
  };
  const go = (delta: number) =>
    set('variant', VARIANTS[(idx + delta + VARIANTS.length) % VARIANTS.length].key);
  const goTab = (delta: number) =>
    set('tabs', TAB_STYLES[(tabIdx + delta + TAB_STYLES.length) % TAB_STYLES.length]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.key === 'ArrowLeft') go(-1);
      if (e.key === 'ArrowRight') go(1);
      if (e.key === 'ArrowUp') goTab(-1);
      if (e.key === 'ArrowDown') goTab(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (import.meta.env.PROD) return null;

  return (
    <div className="fixed bottom-12 left-1/2 z-50 flex -translate-x-1/2 flex-col items-center gap-1">
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
      {/* 선택기 시안 줄 — A 에서만 화면에 걸린다.
          배경은 `bg-fg/80` 이 아니라 `bg-fg` 다: `--fg` 가 `<alpha-value>` 없이 등록된
          CSS 변수라 opacity modifier 가 무효가 되고, 배경이 통째로 사라져 `text-bg`
          글씨만 남는다(= 밝은 배경 위 흰 글씨 = 안 보임). */}
      {current === 'A' && (
        <div className="flex items-center gap-2 rounded-full bg-fg px-2 py-0.5 text-bg shadow-lg">
          <button type="button" onClick={() => goTab(-1)} className="px-2 text-xs">
            ↑
          </button>
          <span className="min-w-[16rem] text-center font-data text-[11px] tabular-nums">
            {tab} — {TAB_STYLE_NAMES[tab]}
          </span>
          <button type="button" onClick={() => goTab(1)} className="px-2 text-xs">
            ↓
          </button>
        </div>
      )}
    </div>
  );
}
