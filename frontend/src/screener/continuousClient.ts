import { apiAction, apiCall, type ApiError } from '../api/client';
import { readContinuousResult, type ScanRequest, type ScreenerResponse, type ContinuousStatus } from '../api/screener';

export const hasContinuousVolume = (request: ScanRequest) => request.conditions.some(leaf =>
  (leaf.type === 'new_high_vol' || leaf.type === 'new_high_vol_today')
  && 'timeframe' in leaf.params && ['1m', '3m', '5m', '10m'].includes(leaf.params.timeframe ?? '') && !('mode' in leaf.params));

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
    if (id) {
      try { await apiAction(`/api/screener/monitors/${id}`, { method: 'DELETE' }); }
      catch (error) { if ((error as ApiError).status !== 404) throw error; }
    }
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
          await apiAction(`/api/screener/monitors/${status.id}`, { method: 'DELETE' });
          throw new Error('감시 조건이 변경되었습니다.');
        }
        this.id = status.id;
        return status.id;
      }).finally(() => { if (generation === this.generation) this.pending = null; });
      await this.pending;
    }
    const id = this.id!;
    try {
      const result = await readContinuousResult(id);
      if (generation !== this.generation) throw new DOMException('감시 조건이 변경되었습니다.', 'AbortError');
      return result;
    } catch (error) {
      if (generation !== this.generation) throw new DOMException('감시 조건이 변경되었습니다.', 'AbortError');
      if (this.id === id && (error as ApiError).status === 404) this.id = null;
      throw error;
    }
  }
}
