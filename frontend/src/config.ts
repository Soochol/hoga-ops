export type AppConfig = { api_url: string };
export const DEFAULT_CONFIG: AppConfig = { api_url: 'http://localhost:8000' };

export async function loadConfig(): Promise<AppConfig> {
  try {
    const r = await fetch('/config.json');
    if (!r.ok) throw new Error(`${r.status}`);
    return await r.json();
  } catch {
    return DEFAULT_CONFIG;
  }
}
