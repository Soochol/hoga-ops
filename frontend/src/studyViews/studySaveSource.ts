import { useSyncExternalStore } from 'react';
import type { ParquetStudySnapshot, StudyIndicatorState } from '../api/studyViews';
import type { RangeBundle } from '../api/types';
import type { LiveTimeframe } from '../state/livePage';
import type { TabViewport } from '../live/viewportAnchor';

export type LiveStudySaveSource = {
  origin: 'live';
  code: string;
  label: string;
  timeframe: LiveTimeframe;
  bundle: RangeBundle;
  indicatorState: StudyIndicatorState;
  captureViewport: () => TabViewport | null;
};

export type StoredStudySaveSource = {
  origin: 'study';
  viewId: string;
  snapshot: ParquetStudySnapshot;
  bundle: RangeBundle;
  captureViewport: () => TabViewport | null;
};

export type CurrentStudySaveSource = LiveStudySaveSource | StoredStudySaveSource;

let currentStudySaveSource: CurrentStudySaveSource | null = null;
const studySaveSourceListeners = new Set<() => void>();

export function setCurrentStudySaveSource(next: CurrentStudySaveSource | null) {
  currentStudySaveSource = next;
  studySaveSourceListeners.forEach((listener) => listener());
}

export function clearCurrentStudySaveSource(source: CurrentStudySaveSource) {
  if (currentStudySaveSource !== source) return;
  setCurrentStudySaveSource(null);
}

export function useCurrentStudySaveSource() {
  return useSyncExternalStore(
    (listener) => {
      studySaveSourceListeners.add(listener);
      return () => studySaveSourceListeners.delete(listener);
    },
    () => currentStudySaveSource,
    () => null,
  );
}
