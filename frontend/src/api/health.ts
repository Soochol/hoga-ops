/** Deep health: process liveness and Capture Queue readiness are separate. */
export interface CaptureQueueHealth {
  owned: boolean;
  disabled_by_env: boolean;
  ready?: boolean;
  state?: string;
  owner_epoch?: number;
  attempts?: number;
  last_attempt_ms?: number | null;
  next_attempt_ms?: number | null;
  error?: string | null;
}

export interface ComputeAdmissionHealth {
  pending_requests: number;
  max_pending_requests: number;
  admission_rejections: number;
  max_workers: number;
}
