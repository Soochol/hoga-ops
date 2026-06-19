export type LiveOpenDisposition = 'current-tab' | 'new-tab';

export type MouseModifierState = Pick<React.MouseEvent, 'ctrlKey' | 'metaKey'>;

export function dispositionFromMouseEvent(e: MouseModifierState): LiveOpenDisposition {
  return e.ctrlKey || e.metaKey ? 'new-tab' : 'current-tab';
}
