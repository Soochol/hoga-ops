import { apiUrl } from './client';
import type { EnqueueRequest, EnqueueResponse, QueueSnapshot } from './types';

function rejectWithDetail(r: Response, body: unknown, fallback: string): never {
  const detail = (body as { detail?: { code?: string; message?: string } })?.detail;
  const err = new Error(detail?.message ?? `${fallback} ${r.status}`);
  (err as { code?: string; status?: number }).code = detail?.code;
  (err as { code?: string; status?: number }).status = r.status;
  throw err;
}

export async function addItems(req: EnqueueRequest): Promise<EnqueueResponse> {
  const url = await apiUrl('/api/captures/items');
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
  if (!r.ok) rejectWithDetail(r, await r.json().catch(() => ({})), 'POST /api/captures/items');
  return r.json();
}

export async function getQueue(): Promise<QueueSnapshot> {
  const url = await apiUrl('/api/captures/queue');
  const r = await fetch(url);
  if (!r.ok) throw new Error(`GET /api/captures/queue failed: ${r.status}`);
  return r.json();
}

export async function cancelItem(itemId: string): Promise<void> {
  const url = await apiUrl(`/api/captures/items/${encodeURIComponent(itemId)}/cancel`);
  const r = await fetch(url, { method: 'POST' });
  if (!r.ok && r.status !== 409) throw new Error(`cancel ${itemId} failed: ${r.status}`);
}

export async function cancelAll(): Promise<void> {
  const url = await apiUrl('/api/captures/cancel-all');
  const r = await fetch(url, { method: 'POST' });
  if (!r.ok) throw new Error(`cancel-all failed: ${r.status}`);
}

export async function resumeQueue(): Promise<void> {
  const url = await apiUrl('/api/captures/queue/resume');
  const r = await fetch(url, { method: 'POST' });
  if (!r.ok) throw new Error(`resume failed: ${r.status}`);
}

export async function dismissDone(): Promise<void> {
  const url = await apiUrl('/api/captures/done');
  const r = await fetch(url, { method: 'DELETE' });
  if (!r.ok) throw new Error(`dismiss-done failed: ${r.status}`);
}
