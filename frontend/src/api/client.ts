import { loadConfig, type AppConfig } from '../config';

let _configPromise: Promise<AppConfig> | null = null;

export async function apiUrl(path: string): Promise<string> {
  if (!_configPromise) _configPromise = loadConfig();
  const cfg = await _configPromise;
  return `${cfg.api_url}${path}`;
}

export async function apiGet<T>(path: string): Promise<T> {
  const r = await fetch(await apiUrl(path));
  if (!r.ok) throw new Error(`${r.status} ${path}`);
  return r.json();
}

export function __resetConfigForTests(): void {
  _configPromise = null;
}
