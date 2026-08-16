export type AppConfig = Readonly<{ api_url: string }>;
// 폴백은 백엔드 실제 기본 포트(8000)와 일치해야 한다 — 8080 이던 시절에는
// config.json 로드 실패가 "아무도 안 듣는 포트로의 전면 무응답" 으로 위장됐다.
export const DEFAULT_CONFIG: AppConfig = { api_url: 'http://localhost:8000' };

function normalizeApiUrl(raw: string): string {
  return raw.replace(/\/+$/, '');
}

function readApiUrl(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const record = data as { api_url?: unknown; apiBaseUrl?: unknown };
  const raw = typeof record.api_url === 'string'
    ? record.api_url
    : typeof record.apiBaseUrl === 'string'
      ? record.apiBaseUrl
      : null;
  return raw === null ? null : normalizeApiUrl(raw);
}

function normalizePath(path: string): string {
  return path.startsWith('/') ? path : `/${path}`;
}

export function resolveApiUrl(config: AppConfig, path: string): string {
  const normalizedPath = normalizePath(path);
  if (config.api_url === '') return normalizedPath;
  return `${normalizeApiUrl(config.api_url)}${normalizedPath}`;
}

export function resolveWsUrl(config: AppConfig, path: string): string {
  const url = resolveApiUrl(config, path);
  if (url.startsWith('https://')) return url.replace(/^https:\/\//, 'wss://');
  if (url.startsWith('http://')) return url.replace(/^http:\/\//, 'ws://');
  // same-origin 모드(api_url: "") — resolveApiUrl 이 상대 경로를 돌려준다.
  // `new WebSocket('/api/ws')` 의 상대 URL 지원은 2024년에야 표준화돼 구형
  // 웹뷰에서 SyntaxError 로 죽는다. location 기준으로 절대화한다(ADR-0134).
  if (url.startsWith('/') && typeof window !== 'undefined' && window.location?.host) {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${window.location.host}${url}`;
  }
  return url;
}

/** api_url 이 비면(ADR-0134 same-origin 서빙) 실제 base 는 문서의 오리진이다. */
function apiBase(config: AppConfig, locationOrigin: string): string {
  return config.api_url === '' ? locationOrigin : config.api_url;
}

/** 클라이언트가 실제로 때릴 백엔드 오리진(툴팁·진단용 전체 표기). */
export function resolveApiOrigin(config: AppConfig, locationOrigin: string): string {
  const base = apiBase(config, locationOrigin);
  try {
    return new URL(base).origin;
  } catch {
    return base;
  }
}

// 여기 있던 `formatApiOrigin`(nav 뱃지용 `:8000` 압축 표기)과 그 `LOOPBACK_HOSTNAMES`
// 는 삭제됐다 — 유일한 소비자가 StatusDot 의 텍스트 라벨이었고, 그 라벨이 사라졌다.
// 툴팁은 전체 오리진(`resolveApiOrigin`)을 쓰므로 압축 표기가 필요 없다.

export async function loadConfig(): Promise<AppConfig> {
  try {
    const r = await fetch('/config.json');
    if (!r.ok) throw new Error(`${r.status}`);
    const data = await r.json();
    const apiUrl = readApiUrl(data);
    if (apiUrl === null) throw new Error('invalid config shape');
    return { api_url: apiUrl };
  } catch (e) {
    console.warn('[config] using DEFAULT_CONFIG:', e);
    return DEFAULT_CONFIG;
  }
}
