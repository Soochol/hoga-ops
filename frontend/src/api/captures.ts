import { apiUrl } from './client';
import type { CaptureJob } from './types';

export interface StartCaptureArgs {
  code: string;
  date: string;
  allow_partial: boolean;
  resume: boolean;
  capture_only: boolean;
}

export async function getLatestCapture(): Promise<CaptureJob | null> {
  const url = await apiUrl('/api/captures/latest');
  const r = await fetch(url);
  if (!r.ok) throw new Error(`GET /api/captures/latest failed: ${r.status}`);
  return r.json();
}

export async function startCapture(args: StartCaptureArgs): Promise<CaptureJob> {
  const url = await apiUrl('/api/captures');
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    const detail = body?.detail;
    const err = new Error(detail?.message ?? `POST /api/captures ${r.status}`);
    (err as { code?: string; status?: number }).code = detail?.code;
    (err as { code?: string; status?: number }).status = r.status;
    throw err;
  }
  return r.json();
}

export async function cancelLatest(): Promise<void> {
  const url = await apiUrl('/api/captures/latest/cancel');
  const r = await fetch(url, { method: 'POST' });
  if (!r.ok && r.status !== 409) throw new Error(`cancel failed: ${r.status}`);
}

export async function dismissLatest(): Promise<void> {
  const url = await apiUrl('/api/captures/latest');
  const r = await fetch(url, { method: 'DELETE' });
  if (!r.ok && r.status !== 409) throw new Error(`dismiss failed: ${r.status}`);
}
