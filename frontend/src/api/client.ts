import { loadConfig, type AppConfig } from '../config';

let _configPromise: Promise<AppConfig> | null = null;

export async function apiUrl(path: string): Promise<string> {
  if (!_configPromise) _configPromise = loadConfig();
  const cfg = await _configPromise;
  return `${cfg.api_url}${path}`;
}

/** Build a ws(s):// URL by swapping the configured http(s) api_url scheme. */
export async function wsUrl(path: string): Promise<string> {
  return (await apiUrl(path)).replace(/^http/, 'ws');
}

/** Error thrown by apiCall / apiAction when the backend responds non-OK.
 *  `code` and `status` are populated from the FastAPI-style structured detail
 *  body (`{detail: {code, message}}`). Consumers that know the router's
 *  error-code set may cast to a narrowed type (see CaptureRestError).
 *  `data` carries the raw parsed JSON body for non-FastAPI-detail responses
 *  (e.g. the ADR-0042 all-blocked 409 returns `{enqueued, deduped, blocked}`
 *  directly, not wrapped in {detail}). */
export interface ApiError extends Error {
  code?: string;
  status?: number;
  data?: unknown;
}

async function buildApiError(r: Response, path: string): Promise<ApiError> {
  const body = await r.json().catch(() => ({}));
  const rawDetail = (body as { detail?: unknown })?.detail;

  // FastAPI request-validation errors (422) put `detail` as an ARRAY of
  // {loc, msg, type}. The object path below only reads detail.message, so
  // without this branch a 422 surfaces the useless "<status> <path>" while the
  // real per-field reason sits unused in the body (the screener "조회 실패 →
  // 422 /api/screener/scan" case). Summarize the msgs instead.
  if (Array.isArray(rawDetail)) {
    const reason = rawDetail
      .map((e) => (e && typeof e === 'object' && 'msg' in e ? String((e as { msg: unknown }).msg) : ''))
      .filter(Boolean)
      // Strip Pydantic's "Value error, " prefix ONLY when present — field
      // constraints (ge/le, min_length, …) emit msgs without it.
      .map((m) => m.replace(/^Value error,\s*/, ''))
      .join('; ');
    const err = new Error(reason || `${r.status} ${path}`) as ApiError;
    err.code = 'validation_error';
    err.status = r.status;
    err.data = body;
    return err;
  }

  const detail = rawDetail as { code?: string; message?: string } | undefined;
  const err = new Error(detail?.message ?? `${r.status} ${path}`) as ApiError;
  err.code = detail?.code;
  err.status = r.status;
  err.data = body;
  return err;
}

/** Fetch a JSON-returning endpoint. Throws ApiError on non-OK. */
export async function apiCall<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(await apiUrl(path), init);
  if (!r.ok) throw await buildApiError(r, path);
  return r.json();
}

/** Fire-and-forget action endpoint with no JSON response body. Throws ApiError
 *  on non-OK; consumers may catch and inspect `.status` for special cases
 *  (e.g. cancelItem swallows 409 = item already terminal). */
export async function apiAction(path: string, init?: RequestInit): Promise<void> {
  const r = await fetch(await apiUrl(path), init);
  if (!r.ok) throw await buildApiError(r, path);
}

/** Thin alias preserved for existing useQuery callers (session, stock-dates). */
export const apiGet = <T>(path: string): Promise<T> => apiCall<T>(path);

export function __resetConfigForTests(): void {
  _configPromise = null;
}
