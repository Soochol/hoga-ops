import type { DrawingTool } from '../chart/drawing/types';
import { AppIcon, type AppIconName } from '../ui/AppIcon';

const icons: Record<DrawingTool, AppIconName> = {
  select: 'select', hline: 'horizontal', vline: 'vertical', trendline: 'trendline',
  rect: 'rectangle', measure: 'measure', text: 'text', pencil: 'pencil', eraser: 'eraser',
  'day-high': 'dayHigh', 'day-low': 'dayLow', 'day-open': 'dayOpen', 'day-close': 'horizontal',
};

/** UI-only mapping: drawing tools and their coordinate/shortcut contracts remain pure. */
export function DrawingToolIcon({ tool, size = 14 }: { tool: DrawingTool; size?: number }) {
  return <AppIcon name={icons[tool]} size={size} />;
}
