import type { StudyViewListRow, StudyViewWriteRequest } from '../api/studyViews';
import type { RangeBundle } from '../api/types';
import type { CurrentStudySaveSource } from './studySaveSource';
import {
  defaultStudyViewName,
  fallbackViewport,
  rangeForWindow,
  viewportFromCapture,
  visibleWindow,
} from './studySaveRequest';

export type StudySaveCommandMode = 'create' | 'overwrite';

export type StudySaveDialogValues = {
  name: string;
  memo: string;
};

export type StudySaveCommand = {
  mode: StudySaveCommandMode;
  id?: string;
  request: StudyViewWriteRequest;
  dialog: {
    defaultName: string;
    defaultMemo: string;
    rangeLabel: string;
  };
};

function sourceCode(source: CurrentStudySaveSource): string {
  if (source.origin === 'study-reference') return source.save.code;
  return source.code;
}

function sourceLabel(source: CurrentStudySaveSource): string {
  if (source.origin === 'study-reference') return source.save.label;
  return source.label;
}

function sourceTimeframe(source: CurrentStudySaveSource) {
  if (source.origin === 'study-reference') return source.save.timeframe;
  return source.timeframe;
}

function sourceBundle(source: CurrentStudySaveSource): RangeBundle {
  return source.bundle;
}

function sourceFallbackViewport(source: CurrentStudySaveSource) {
  if (source.origin === 'study-reference') return source.save.viewport;
  return fallbackViewport(source.bundle);
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
  existingSave: StudyViewListRow | null | undefined;
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
  const range = rangeForWindow(bundle, window.fromIndex, window.toIndex);
  if (!range) return null;
  const request: StudyViewWriteRequest = {
    name,
    memo,
    code,
    label,
    timeframe,
    range,
    viewport,
    tags: existingSave?.tags ?? [],
  };

  return {
    mode,
    id: mode === 'overwrite' && source.origin !== 'live' ? source.viewId : undefined,
    request,
    dialog: {
      defaultName: commandDefaultName({ mode, source, requestName: request.name }),
      defaultMemo: request.memo ?? '',
      rangeLabel: `${request.range.from_date} ~ ${request.range.to_date}`,
    },
  };
}

export function studySaveCommandBody(
  command: StudySaveCommand,
  values: StudySaveDialogValues,
): StudyViewWriteRequest {
  return { ...command.request, name: values.name, memo: values.memo };
}
