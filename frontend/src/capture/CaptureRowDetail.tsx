import type { QueueItem } from '../api/types';

export function CaptureRowDetail({ item }: { item: QueueItem }) {
  return <div data-testid={`queue-row-detail-${item.item_id}`} />;
}
