import { AppIcon } from './AppIcon';

/**
 * Shared trash glyph for the inline 관심종목 해제 control on Watchlist Panel rows.
 * Stroke = currentColor (neutral shape signal — see DESIGN.md). Size via `className`
 * (e.g. "w-[1em] h-[1em]"). Mirrors HeartIcon/FunnelIcon.
 */
export function TrashIcon({ className = '' }: { className?: string }) {
  return <AppIcon name="trash" className={className} />;
}
