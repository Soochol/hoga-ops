/** Small actions share SVG geometry regardless of the user's font. */
export function MoreIcon() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="19" cy="12" r="1.5" /></svg>;
}
export function GripIcon() {
  return <svg width="12" height="14" viewBox="0 0 18 24" fill="currentColor" aria-hidden="true">{[5, 12, 19].flatMap((y) => [5, 12].map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.5" />))}</svg>;
}
