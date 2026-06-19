export type AppConfig = Readonly<{ api_url: string }>;
export const DEFAULT_CONFIG: AppConfig = { api_url: 'http://localhost:8080' };

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
  return url;
}

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
