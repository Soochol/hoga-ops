import { apiCall } from './client';

export type RecoveryItemStatus = 'pending' | 'staged' | 'observed' | 'quarantined' | 'failed';
export type RecoveryJobStatus = 'collecting' | 'complete' | 'partial' | 'interrupted' | 'failed';
export type ConfirmationState = 'unverified' | 'confirmed' | 'too_early' | 'unstable';

export interface RecoveryItem {
  status: RecoveryItemStatus;
  candidate_id: string | null;
  observation_id: string | null;
  snapshot_id: string | null;
  added_original_days: number;
  original_missing: string[];
  price_missing: string[];
  conflict_dates: string[];
  share_evidence_ready: boolean;
  violations: number;
  error: string | null;
  confirmation_state: ConfirmationState;
  resolved_conflict_dates: string[];
  correction_id: string | null;
}

export interface RecoveryJob {
  plan_id: string;
  status: RecoveryJobStatus;
  items: Record<string, RecoveryItem>;
  current_code: string | null;
  preserved: boolean;
  error: string | null;
}

export interface RecoveryRunRequest { resume: boolean }
export interface RecoveryAccepted { plan_id: string; started: boolean }
export interface RecoveryCancellation { cancel_requested: boolean }

export function startRecovery(planId: string, resume = false): Promise<RecoveryAccepted> {
  const body: RecoveryRunRequest = { resume };
  return apiCall(`/api/screener/recovery/${encodeURIComponent(planId)}/run`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
}

export function getRecovery(planId: string): Promise<RecoveryJob> {
  return apiCall(`/api/screener/recovery/${encodeURIComponent(planId)}`);
}

export function cancelRecovery(planId: string): Promise<RecoveryCancellation> {
  return apiCall(`/api/screener/recovery/${encodeURIComponent(planId)}/cancel`, { method: 'POST' });
}
