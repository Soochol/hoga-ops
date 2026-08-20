import { loadConfig, resolveApiUrl, resolveWsUrl, type AppConfig } from '../config';
import { livePerfDebugEnabled, livePerfLog } from '../util/perfDebug';

let _configPromise: Promise<AppConfig> | null = null;

/** 해소된 런타임 설정. `apiUrl`/`wsUrl` 과 **같은 프로미스를 공유**하므로
 *  `/config.json` 을 다시 받지 않는다 — 메모이제이션이 config.ts 가 아니라
 *  여기 있어서, 표시용으로 `loadConfig()` 를 직접 부르면 중복 요청이 된다. */
export async function getConfig(): Promise<AppConfig> {
  if (!_configPromise) _configPromise = loadConfig();
  return _configPromise;
}

export async function apiUrl(path: string): Promise<string> {
  const cfg = await getConfig();
  return resolveApiUrl(cfg, path);
}

export async function wsUrl(path: string): Promise<string> {
  const cfg = await getConfig();
  return resolveWsUrl(cfg, path);
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
  const url = await apiUrl(path);
  const perfEnabled = livePerfDebugEnabled();
  const t0 = perfEnabled ? performance.now() : 0;
  try {
    const r = await fetch(url, init);
    if (!r.ok) throw await buildApiError(r, path);
    const out = await r.json() as T;
    if (perfEnabled) {
      livePerfLog('api_call', {
        status: r.status,
        method: init?.method ?? 'GET',
        path,
        durationMs: Math.round((performance.now() - t0) * 10) / 10,
        contentLength: r.headers.get('content-length'),
      });
    }
    return out;
  } catch (e) {
    if (perfEnabled) {
      livePerfLog('api_call_error', {
        method: init?.method ?? 'GET',
        path,
        durationMs: Math.round((performance.now() - t0) * 10) / 10,
        name: e instanceof Error ? e.name : String(e),
        message: e instanceof Error ? e.message : String(e),
      });
    }
    throw e;
  }
}

/** Fire-and-forget action endpoint with no JSON response body. Throws ApiError
 *  on non-OK; consumers may catch and inspect `.status` for special cases
 *  (e.g. cancelItem swallows 409 = item already terminal). */
export async function apiAction(path: string, init?: RequestInit): Promise<void> {
  const r = await fetch(await apiUrl(path), init);
  if (!r.ok) throw await buildApiError(r, path);
}

/** Thin alias preserved for existing useQuery callers (session, stock-dates). */
/** GET 헬퍼. `init` 은 **취소용 `signal` 을 넘기기 위해** 열어 둔 구멍이다 —
 *  커서 스팟처럼 사용자가 계속 키를 바꾸는 표면에서 죽은 요청을 끊지 않으면
 *  브라우저 커넥션이 시체로 막혀 최신 요청이 자기 앞의 폐기분을 기다린다
 *  (실측 2026-08-20: 서버 2~7ms 인 `/api/orderbook` 이 스크럽 중 596~781ms). */
export const apiGet = <T>(path: string, init?: RequestInit): Promise<T> => apiCall<T>(path, init);

export function __resetConfigForTests(): void {
  _configPromise = null;
}
