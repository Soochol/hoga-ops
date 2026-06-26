import { useSyncExternalStore } from 'react';
import type { StudyViewReference } from '../api/studyViews';
import type { RangeBundle } from '../api/types';
import type { LiveTimeframe } from '../state/livePage';
import type { TabViewport } from '../live/viewportAnchor';

export type LiveStudySaveSource = {
  origin: 'live';
  code: string;
  label: string;
  timeframe: LiveTimeframe;
  bundle: RangeBundle;
  captureViewport: () => TabViewport | null;
};

export type ReferenceStudySaveSource = {
  origin: 'study-reference';
  viewId: string;
  save: StudyViewReference;
  bundle: RangeBundle;
  captureViewport: () => TabViewport | null;
};

export type CurrentStudySaveSource = LiveStudySaveSource | ReferenceStudySaveSource;

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
