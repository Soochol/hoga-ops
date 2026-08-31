/**
 * 눈 아이콘 — **레전드와 설정 패널이 같은 그림을 쓴다**.
 *
 * 두 표면이 같은 상태(`{side}PeakHidden` 등)를 가리키는데 아이콘이 갈리면 "저 눈과 이
 * 눈이 같은 것인가" 를 사용자가 매번 추론해야 한다. `PaneLegendOverlay` 안에 있던
 * 지역 컴포넌트를 그대로 끌어올린 것이고, 그림·치수는 바뀌지 않았다.
 *
 * 사선이 그어진 눈 = **숨김**(✕ = 끔 과 구별된다 — ✕ 는 지표를 없앤다).
 */
export default function EyeGlyph({ hidden }: { hidden: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" fill="none">
      <path
        d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"
        stroke="currentColor"
        strokeWidth="1.6"
      />
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.6" />
      {hidden && (
        <path d="M4 4l16 16" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      )}
    </svg>
  );
}
