import { useLiveCursorStore } from '../useLiveCursorStore';
import type { GroupId } from '../../state/workspace';

/** Clear only the publishing group's hover channels; preserve range and jump state. */
export function returnGroupToLatest(group: GroupId): void {
  const cursor = useLiveCursorStore.getState();
  const origin = cursor.sidebarCursorOrigin;
  if (!origin || origin.group !== group) return;
  cursor.clearSidebarCursorFrom(origin.windowId);
  cursor.clearSyncCursorFrom(origin.windowId);
}
