import type { ParquetStudyView, ParquetStudyViewWriteRequest, StudySavedFromRoute } from '../api/studyViews';
import type { RangeBundle } from '../api/types';
import type { CurrentStudySaveSource } from './studySaveSource';
import {
  defaultStudyViewName,
  fallbackViewport,
  viewportFromCapture,
  visibleWindow,
} from './studySaveRequest';
import { buildStudySnapshotRequest } from './useStudySnapshotCapture';

export type StudySaveCommandMode = 'create' | 'overwrite';

export type StudySaveCommand = {
  mode: StudySaveCommandMode;
  id?: string;
  request: ParquetStudyViewWriteRequest;
  defaultName: string;
  defaultMemo: string;
};

function sourceRoute(source: CurrentStudySaveSource): StudySavedFromRoute {
  return source.origin === 'study' ? '/study' : '/live';
}

function sourceCode(source: CurrentStudySaveSource): string {
  return source.origin === 'study' ? source.snapshot.code : source.code;
}

function sourceLabel(source: CurrentStudySaveSource): string {
  return source.origin === 'study' ? source.snapshot.label : source.label;
}

function sourceTimeframe(source: CurrentStudySaveSource) {
  return source.origin === 'study' ? source.snapshot.timeframe : source.timeframe;
}

function sourceIndicatorState(source: CurrentStudySaveSource) {
  return source.origin === 'study' ? source.snapshot.indicator_state : source.indicatorState;
}

function sourceBundle(source: CurrentStudySaveSource): RangeBundle {
  return source.bundle;
}

function sourceFallbackViewport(source: CurrentStudySaveSource) {
  return source.origin === 'study' ? source.snapshot.viewport : fallbackViewport(source.bundle);
}

function commandDefaultName({
  mode,
  source,
  requestName,
}: {
  mode: StudySaveCommandMode;
  source: CurrentStudySaveSource;
  requestName: string;
}): string {
  if (mode === 'create' && source.origin === 'live') return '';
  return requestName;
}

export function makeStudySaveCommand({
  mode,
  source,
  existingSave,
}: {
  mode: StudySaveCommandMode;
  source: CurrentStudySaveSource;
  existingSave: ParquetStudyView | null | undefined;
}): StudySaveCommand | null {
  const bundle = sourceBundle(source);
  const viewport = viewportFromCapture(source.captureViewport, sourceFallbackViewport(source));
  if (!viewport) return null;

  const code = sourceCode(source);
  const label = sourceLabel(source);
  const timeframe = sourceTimeframe(source);
  const window = visibleWindow(bundle, viewport);
  const name = defaultStudyViewName(mode === 'overwrite' ? existingSave ?? undefined : undefined, label, timeframe);
  const memo = mode === 'overwrite' ? existingSave?.memo ?? '' : '';
  const route = sourceRoute(source);
  const request = buildStudySnapshotRequest({
    name,
    memo,
    route,
    code,
    label,
    timeframe,
    viewport,
    indicatorState: sourceIndicatorState(source),
    bundle,
    fromIndex: window.fromIndex,
    toIndex: window.toIndex,
  });

  return {
    mode,
    id: mode === 'overwrite' && source.origin === 'study' ? source.viewId : undefined,
    request,
    defaultName: commandDefaultName({ mode, source, requestName: request.name }),
    defaultMemo: request.memo ?? '',
  };
}
