// PROTOTYPE — throwaway. 변형 키·훅 (fast-refresh 규칙 때문에 컴포넌트와 분리).
import { useSearchParams } from 'react-router';

export const DIVIDER_VARIANTS = ['current', 'a', 'b', 'c', 'ab'] as const;
export type DividerVariant = (typeof DIVIDER_VARIANTS)[number];

export const LABELS: Record<DividerVariant, string> = {
  current: '현행 — 분리 없음',
  a: 'A — 헤더 밑줄 + 간격',
  b: 'B — 좌측 스파인 + 간격',
  c: 'C — 톤 스텝 (일탈)',
  ab: 'A+B — 헤더 밑줄 + 스파인',
};

/** 각 변형이 "무엇으로 분리하는가" — 스위처가 화면에 그대로 띄운다(상태 노출). */
export const MECHANISM: Record<DividerVariant, string> = {
  current: 'bg=bg-card · borderless · flat(그림자 0) · gap 4.5px → 세 채널 모두 0',
  a: '카드 첫 줄 아래 --border 1px + gap 12/24px. DESIGN.md 내부 구분선 용법 그대로',
  b: '--border-strong 2px 좌측 스파인 + gap 12/24px. 히트맵 폴더 예외 선례',
  c: '--bg-card 를 한 톤 올려 카드를 띄움 + shadow-panel 복원. DESIGN.md 일탈 — 승인 필요',
  ab: 'A 의 밑줄(위 경계) + B 의 스파인(좌 경계) → 프레임 없이 ㄴ자로 카드가 확정',
};

export function useDividerVariant(): DividerVariant {
  const [params] = useSearchParams();
  const raw = params.get('variant') ?? 'current';
  return (DIVIDER_VARIANTS as readonly string[]).includes(raw) ? (raw as DividerVariant) : 'current';
}
