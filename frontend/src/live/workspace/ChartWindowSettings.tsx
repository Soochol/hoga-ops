import { useLayoutEffect, useState } from 'react';
import { useWindowSettingsStore } from '../../state/windowSettings';
import { seedSettingsForWindow } from '../../state/windowSettingsLifecycle';
import { ChartDisplaySettings } from './ChartDisplaySettings';
import { WindowSettingsPopover } from './WindowSettingsPopover';

/** The title bar reads the same window-owned settings as its candle chart. */
export function ChartWindowSettings({ windowId }: { windowId: string }) {
  useLayoutEffect(() => seedSettingsForWindow({ id: windowId, kind: 'chart' }), [windowId]);
  const log = useWindowSettingsStore(s => s.byWindow[windowId]?.chart?.candleLogScale ?? false);
  const inverted = useWindowSettingsStore(s => s.byWindow[windowId]?.chart?.candleInvertScale ?? false);
  const swapColors = useWindowSettingsStore(s => s.byWindow[windowId]?.chart?.candleInvertColors ?? true);
  const [open, setOpen] = useState(false);
  const active = log || inverted;
  const description = [log && '로그 스케일 켜짐', inverted &&
    `가격축 반전 켜짐 · 캔들/거래량 색상 교환 ${swapColors ? '켜짐' : '꺼짐'}`].filter(Boolean).join(' · ');

  return <span className="live-chart-header-settings" data-active={active ? '' : undefined}>
    {active && <button type="button" className="live-chart-scale-status" aria-label={`차트 축 상태: ${description}`}
      aria-haspopup="dialog" aria-expanded={open}
      onPointerDown={event => event.stopPropagation()} onClick={() => setOpen(true)}>
      {log && <span className="live-chart-scale-badge">로그</span>}
      {inverted && <span className="live-chart-scale-badge" data-inverted>반전</span>}
    </button>}
    <WindowSettingsPopover title="차트 설정" scope="이 차트에 적용" width={380}
      open={open} onOpenChange={setOpen} render={() => <ChartDisplaySettings windowId={windowId} />} />
  </span>;
}
