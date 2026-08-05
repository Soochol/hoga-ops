// PROTOTYPE — throwaway. 변형 키·훅 (fast-refresh 규칙 때문에 컴포넌트와 분리).
import { useSearchParams } from 'react-router';

export const LAYOUT_VARIANTS = ['current', 'a', 'b', 'c'] as const;
export type LayoutVariant = (typeof LAYOUT_VARIANTS)[number];

export const LABELS: Record<LayoutVariant, string> = {
  current: '현행 — 풀와이드 행',
  a: 'A — 중앙 고정 폭 + 행 재균형',
  b: 'B — 풀와이드 3존 (차트|요약|리스트)',
  c: 'C — 2단 분할 (차트 스택|리스트 열)',
};

export function useLayoutVariant(): LayoutVariant {
  const [params] = useSearchParams();
  const raw = params.get('variant') ?? 'current';
  return (LAYOUT_VARIANTS as readonly string[]).includes(raw) ? (raw as LayoutVariant) : 'current';
}

