export type AppConfig = Readonly<{ api_url: string }>;
export const DEFAULT_CONFIG: AppConfig = { api_url: 'http://localhost:8000' };

export async function loadConfig(): Promise<AppConfig> {
  try {
    const r = await fetch('/config.json');
    if (!r.ok) throw new Error(`${r.status}`);
    const data = await r.json();
    if (typeof data?.api_url !== 'string') throw new Error('invalid config shape');
    return { api_url: data.api_url };
  } catch (e) {
    console.warn('[config] using DEFAULT_CONFIG:', e);
    return DEFAULT_CONFIG;
  }
}
