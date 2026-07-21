import type { StudyViewListRow, StudyViewWriteRequest } from '../api/studyViews';
import type { RangeBundle } from '../api/types';
import {
  defaultStudyViewName,
  fallbackViewport,
  rangeForWindow,
  viewportFromCapture,
  visibleWindow,
  type LiveStudySaveSource,
} from './studySaveRequest';

export type { LiveStudySaveSource };

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

function sourceCode(source: LiveStudySaveSource): string {
  return source.code;
}

function sourceLabel(source: LiveStudySaveSource): string {
  return source.label;
}

function sourceTimeframe(source: LiveStudySaveSource) {
  return source.timeframe;
}

function sourceBundle(source: LiveStudySaveSource): RangeBundle {
  return source.bundle;
}

function sourceFallbackViewport(source: LiveStudySaveSource) {
  return fallbackViewport(source.bundle);
}

function commandDefaultName({
  mode,
  source,
  requestName,
}: {
  mode: StudySaveCommandMode;
  source: LiveStudySaveSource;
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
  source: LiveStudySaveSource;
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
    // 덮어쓰기 대상 id 의 유일한 출처는 `study-reference` 소스의 viewId 였는데,
    // 그 변종이 사라지며 함께 없어졌다. 현재 프로덕션 호출부는 'create' 뿐이라
    // 무해하지만, 덮어쓰기를 되살릴 땐 id 출처부터 다시 정해야 한다.
    id: undefined,
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
