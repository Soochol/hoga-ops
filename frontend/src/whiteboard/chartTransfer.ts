/** Small route handoff. No editor imports on the live chart's initial path. */
import { randomId } from '../util/randomId';
export interface ChartTransfer {
  blob: Blob;
  source: Record<string, unknown>;
}
const transfers = new Map<string, ChartTransfer>();
export function stageChartTransfer(transfer: ChartTransfer) {
  const id = randomId();
  transfers.set(id, transfer);
  return id;
}
export function takeChartTransfer(id: string) {
  const transfer = transfers.get(id);
  transfers.delete(id);
  return transfer;
}
