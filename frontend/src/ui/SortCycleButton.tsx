import { useId, type ButtonHTMLAttributes } from 'react';
import { SortDirectionIcon, type SortDirection } from './SortDirectionIcon';

const SR_ONLY: React.CSSProperties = {
  position: 'absolute', width: 1, height: 1, padding: 0, margin: -1,
  overflow: 'hidden', clip: 'rect(0, 0, 0, 0)', whiteSpace: 'nowrap', border: 0,
};

/**
 * 우측 패널 드로어-레벨 정렬 버튼 통합 — 스크리너·저장뷰가 공유한다. 하나의
 * 테두리 박스 + 통합 SortDirectionIcon + 정렬 활성 시 accent 강조(관심종목/스크리너
 * 컨벤션에 맞춤; 저장뷰가 중립색이던 것을 통일). 3-상태 순환은 호출부가 소유하고,
 * 이 컴포넌트는 표현만.
 *
 * `label` 은 컨트롤의 안정적 이름(aria-label). `description`(옵션)은 현재 상태+다음
 * 동작 설명으로 마우스 툴팁(title) + aria-describedby(sr-only)로 붙는다 — 아이콘만으론
 * 불투명한 순환 상태를 포인터·스크린리더 양쪽에 전달.
 *
 * `variant`:
 * - `box`(기본): 테두리 박스(h-7 w-7) — 스크리너·저장뷰 툴바처럼 다른 박스형 컨트롤
 *   옆에 설 때.
 * - `inline`: 박스 없는 아이콘만(px-1) — 관심종목 그룹 헤더처럼 행 밀도상 박스가 과한
 *   맥락. 순위 패널 필터바도 이 변형으로 관심종목과 시각 언어를 통일한다. accent/dim
 *   색 규칙과 sr-only 설명은 두 변형이 동일하다.
 */
export function SortCycleButton({
  direction,
  label,
  description,
  variant = 'box',
  className = '',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  direction: SortDirection;
  label: string;
  description?: string;
  variant?: 'box' | 'inline';
}) {
  const active = direction !== 'none';
  const descId = useId();
  const shape =
    variant === 'inline'
      ? `px-1 leading-none ${active ? 'text-accent' : 'text-fg-dimmer hover:text-fg'}`
      : `grid h-7 w-7 place-items-center rounded border ${
          active
            ? 'border-accent bg-tint-selection text-accent'
            : 'border-border bg-bg-input text-fg-dim hover:bg-bg-input-hover hover:text-fg'
        }`;
  return (
    <button
      type="button"
      aria-label={label}
      aria-describedby={description ? descId : undefined}
      aria-pressed={active}
      title={description ?? label}
      {...rest}
      className={`transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${shape} ${className}`.trim()}
    >
      <SortDirectionIcon direction={direction} className="h-4 w-4" />
      {description && <span id={descId} style={SR_ONLY}>{description}</span>}
    </button>
  );
}
