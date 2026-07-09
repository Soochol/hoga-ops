import type { ReactNode } from 'react';
import { useToastPresence } from './useToastPresence';

export type ToastVariant = 'neutral' | 'warn' | 'success' | 'error';

/** variant → 좌측 강조 바 + 테두리 색 토큰. 팔레트는 이미 tokens.css 에 존재. */
const VARIANT_BORDER: Record<ToastVariant, string> = {
  neutral: 'border-border',
  warn: 'border-warn',
  success: 'border-success',
  error: 'border-error',
};

const VARIANT_PROGRESS: Record<ToastVariant, string> = {
  neutral: 'bg-accent',
  warn: 'bg-warn',
  success: 'bg-success',
  error: 'bg-error',
};

type ToastCardProps = {
  /** false 로 바뀌면 exit 애니메이션 후 언마운트된다. */
  visible: boolean;
  /** exit 애니메이션 완료(=실제 제거 시점) 콜백. 리스트 소유자가 항목을 지운다. */
  onExited?: () => void;
  variant?: ToastVariant;
  /** 주어지면 카드 전체가 클릭 버튼이 된다(시그널 토스트의 점프 동작). */
  onClick?: () => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  role?: string;
  ariaLabel?: string;
  /** 남은 시간 진행바. paused=true(hover 등) 면 정지. 모션 감소 시 표시 안 함. */
  progress?: { durationMs: number; paused: boolean } | null;
  children: ReactNode;
};

/**
 * 프레젠테이션 전용 토스트 카드 — variant 색, 슬라이드+페이드 enter/exit,
 * 선택적 남은시간 진행바를 담당한다. 데이터/트리거는 호출 측(호스트)이 소유.
 *
 * onClick 이 있으면 `<button>`(시그널: 카드 전체가 점프 버튼), 없으면 `<div>`
 * (KIS: 내부에 닫기 버튼·토글을 중첩) — 버튼-속-버튼 중첩을 피한다.
 */
export function ToastCard({
  visible,
  onExited,
  variant = 'neutral',
  onClick,
  onMouseEnter,
  onMouseLeave,
  role,
  ariaLabel,
  progress,
  children,
}: ToastCardProps) {
  const { rendered, phase } = useToastPresence(visible, onExited);
  if (!rendered) return null;

  const className =
    'toast-card pointer-events-auto relative w-full overflow-hidden rounded border bg-bg-card ' +
    'px-3 py-2 text-left shadow-lg ' +
    VARIANT_BORDER[variant] +
    (onClick ? ' hover:border-line-strong hover:bg-bg-input' : '');

  const inner = (
    <>
      {children}
      {progress && (
        <span
          aria-hidden
          className={`toast-progress absolute inset-x-0 bottom-0 block h-[2px] ${VARIANT_PROGRESS[variant]}`}
          style={{
            animationDuration: `${progress.durationMs}ms`,
            animationPlayState: progress.paused ? 'paused' : 'running',
          }}
        />
      )}
    </>
  );

  if (onClick) {
    return (
      <button
        type="button"
        data-phase={phase}
        aria-label={ariaLabel}
        className={className}
        onClick={onClick}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
      >
        {inner}
      </button>
    );
  }

  return (
    <div
      data-phase={phase}
      role={role}
      aria-label={ariaLabel}
      className={className}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {inner}
    </div>
  );
}
