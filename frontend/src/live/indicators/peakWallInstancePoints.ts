import type { AskPeakCandidate, Candle } from '../../api/types';
import type { VirtualAxis } from '../../util/virtualAxis';
import type { PeakWallSegment } from '../../chart/PeakWallSegmentsPrimitive';
import { buildPeakWallStepPoints, buildUnreachedStepPoints, type PeakWallStepPoint } from '../../chart/peakWallSteps';
import { buildBarModePanePoints, type PeakWallStepBuilder } from '../peakWallPanePoints';
import type { PeakWallRenderState } from '../usePeakWallRender';
import type { PeakWallStepKey } from './peakWallStepsRegistry';

/** The original and additional instances use exactly the same six-slot projection. */
export function peakWallInstancePoints({ askWall, bidWall, candles, axis, mode, enabled }: {
  askWall: PeakWallRenderState; bidWall: PeakWallRenderState; candles: readonly Candle[]; axis: VirtualAxis;
  mode: Parameters<typeof buildBarModePanePoints>[0]['mode']; enabled: boolean;
}): Record<PeakWallStepKey, readonly PeakWallStepPoint[]> {
  const project = (barCandidates: readonly AskPeakCandidate[], stepSegments: readonly PeakWallSegment[], color: string,
    stepBuilder: PeakWallStepBuilder = buildPeakWallStepPoints) => buildBarModePanePoints({
    mode, paneEnabled: enabled, barCandidates, stepSegments, stepBuilder, candles, axis, color,
  });
  const sidePoints = (wall: PeakWallRenderState, side: 'ask' | 'bid') => ({
    [`${side}-traded`]: project(wall.barCandidates, wall.stepSegments, wall.color),
    [`${side}-all`]: project(wall.allWallBarCandidates, wall.allWallStepSegments, wall.allWallColor),
    [`${side}-unreached`]: project(wall.unreachedBarCandidates, wall.unreachedStepSegments, wall.unreachedColor,
      (segments, c, a, color) => buildUnreachedStepPoints(segments, c, a, color, side)),
  });
  return { ...sidePoints(askWall, 'ask'), ...sidePoints(bidWall, 'bid') } as Record<PeakWallStepKey, readonly PeakWallStepPoint[]>;
}
