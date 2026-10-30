import { AppIcon } from './AppIcon';

export function PlusIcon() { return <AppIcon name="plus" />; }
export function MoreIcon() { return <AppIcon name="more" />; }
export function GripIcon() {
  return <svg width="12" height="14" viewBox="0 0 18 24" fill="currentColor" aria-hidden="true">{[5, 12, 19].flatMap((y) => [5, 12].map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.5" />))}</svg>;
}
