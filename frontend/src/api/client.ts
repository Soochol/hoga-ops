import { loadConfig, type AppConfig } from '../config';

let _config: AppConfig | null = null;

export async function apiUrl(path: string): Promise<string> {
  if (!_config) _config = await loadConfig();
  return `${_config.api_url}${path}`;
}

export async function apiGet<T>(path: string): Promise<T> {
  const r = await fetch(await apiUrl(path));
  if (!r.ok) throw new Error(`${r.status} ${path}`);
  return r.json();
}
