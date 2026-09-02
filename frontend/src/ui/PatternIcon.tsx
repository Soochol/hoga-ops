/**
 * 봉 패턴 레일 아이콘 — 캔들 두 개(몸통 + 위아래 꼬리).
 * 다른 레일 글리프와 같은 규격(24 viewBox · currentColor · 채움은 상태 신호일 뿐
 * 두 번째 액센트가 아니다 — DESIGN.md 색 규율).
 */
export function PatternIcon({ filled, className }: { filled: boolean; className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="2"
      strokeLinejoin="round"
      strokeLinecap="round"
      aria-hidden="true"
    >
      {/* 왼쪽 캔들: 짧은 몸통이 위쪽 · 오른쪽 캔들: 긴 몸통이 아래쪽 */}
      <line x1="7.5" y1="3" x2="7.5" y2="21" />
      <rect x="4.5" y="7" width="6" height="6" rx="0.5" />
      <line x1="16.5" y1="4" x2="16.5" y2="20" />
      <rect x="13.5" y="10" width="6" height="8" rx="0.5" />
    </svg>
  );
}
