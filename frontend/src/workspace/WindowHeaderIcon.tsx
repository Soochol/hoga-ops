import { AppIcon } from '../ui/AppIcon';

/** Window chrome uses the same refined glyphs as the rest of the application. */
export function WindowHeaderIcon({ kind, filled = false }: {
  kind: 'settings' | 'top' | 'maximize' | 'restore' | 'close' | 'pin';
  filled?: boolean;
}) {
  return <AppIcon name={kind} filled={filled} className="window-header-icon" />;
}
