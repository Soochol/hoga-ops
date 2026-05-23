/**
 * Persisted default for the CaptureForm's "Force re-capture source-partial
 * dates" checkbox. Backed by a single localStorage entry; both the Settings
 * page and CaptureForm consume the helper to keep the key string out of
 * call sites.
 */
const STORAGE_KEY = 'capture.force_retry_default';

export function loadForceRetryDefault(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

export function saveForceRetryDefault(value: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(value));
  } catch {
    /* SSR / privacy mode — silently drop the write */
  }
}
