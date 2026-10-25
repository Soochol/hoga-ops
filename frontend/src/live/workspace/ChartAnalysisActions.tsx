import type { RefObject } from 'react';
import { IconToolbarButton } from '../../ui/WorkspaceShell';
import { useWorkspaceStore, type WorkspaceWindow } from '../../state/workspace';
import { isCalendarTimeframe, type LiveTimeframe } from '../../state/livePage';
import { ChartCaptureActions } from '../../chart/ChartCaptureActions';
import { IndicatorsButton } from '../LiveToolbar';
import { DrawingMenu } from '../DrawingMenu';
import { CursorLinkAction } from './CursorLinkAction';
import EyeGlyph from '../EyeGlyph';
import { requestIndicatorDrawer } from './indicatorDrawerControls';

/** Both resolutions use the same toolbar controls and window-owned settings. */
export function ChartAnalysisActions({ win, code, timeframe, viewportRef, available }: {
  win: WorkspaceWindow; code: string | null; timeframe: LiveTimeframe;
  viewportRef: RefObject<HTMLDivElement | null>; available: boolean;
}) {
  const legends = win.chart?.indicatorLegendsVisible ?? true;
  return <>
    <IndicatorsButton onClick={() => requestIndicatorDrawer(win.id)} showLabel={false} />
    <ChartCaptureActions key={`${code}|${timeframe}`} viewportRef={viewportRef} code={code} timeframe={timeframe} available={available} />
    <DrawingMenu code={code} timeframe={timeframe} showLabel={false} />
    <IconToolbarButton aria-label={legends ? '레전드 끄기' : '레전드 켜기'}
      title={`${legends ? '레전드 끄기' : '레전드 켜기'} — 시가·고가·저가·종가는 항상 표시`}
      aria-pressed={legends} className="aria-pressed:text-accent"
      onClick={() => useWorkspaceStore.getState().setChartIndicatorLegendsVisible(win.id, !legends)}
      icon={<EyeGlyph hidden={!legends} />} />
    {!isCalendarTimeframe(timeframe) && <CursorLinkAction win={win} />}
  </>;
}
