import { apiCall, type ApiError } from '../api/client';
import { readContinuousResult, type ScanRequest, type ScreenerResponse, type ContinuousStatus } from '../api/screener';

export const hasContinuousVolume = (request: ScanRequest) => request.conditions.some(leaf =>
  (leaf.type === 'new_high_vol' || leaf.type === 'new_high_vol_today')
  && 'timeframe' in leaf.params && leaf.params.timeframe === '1m' && !('mode' in leaf.params));

/** One owner per mounted scan surface; no global cross-tab ownership. */
export class ContinuousClient {
  private id: string | null = null;
  private key: string | null = null;
  private generation = 0;
  private pending: Promise<string> | null = null;
  private readonly clientId = crypto.randomUUID();

  async stop() {
    this.generation += 1;
    const id = this.id;
    this.id = null;
    this.key = null;
    this.pending = null;
    if (id) await apiCall<void>(`/api/screener/monitors/${id}`, { method: 'DELETE' });
  }

  acceptsEvent(monitorId?: string) {
    return monitorId === undefined || monitorId === this.id;
  }

  async heartbeat() {
    if (this.id) await apiCall<ContinuousStatus>(`/api/screener/monitors/${this.id}/heartbeat`, { method: 'POST' });
  }

  async scan(request: ScanRequest): Promise<ScreenerResponse> {
    const key = JSON.stringify(request);
    if (this.key !== key) {
      const stopped = this.stop();
      this.key = key;
      await stopped;
    }
    if (this.key !== key) throw new Error('감시 조건이 변경되었습니다.');
    const generation = this.generation;
    if (!this.id) {
      this.pending ??= apiCall<ContinuousStatus>('/api/screener/monitors', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: `${this.clientId}:${generation}`, request }),
      }).then(async status => {
        if (generation !== this.generation) {
          await apiCall<void>(`/api/screener/monitors/${status.id}`, { method: 'DELETE' });
          throw new Error('감시 조건이 변경되었습니다.');
        }
        this.id = status.id;
        return status.id;
      }).finally(() => { if (generation === this.generation) this.pending = null; });
      await this.pending;
    }
    try {
      return await readContinuousResult(this.id!);
    } catch (error) {
      if ((error as ApiError).status === 404) {
        this.id = null;
        throw new Error('감시가 만료되었습니다. 다시 조회하면 준비를 재개합니다.');
      }
      throw error;
    }
  }
}
