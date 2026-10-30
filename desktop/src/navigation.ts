import type { Profile } from './profiles';

const ROUTES = new Set(['/', '/live', '/heatmap', '/inventory', '/screener', '/capture', '/sentiment', '/market', '/settings', '/study']);
export function appNavigation(raw: string, profile: Profile): boolean {
  try {
    const url = new URL(raw);
    return url.origin === profile.origin && !url.username && !url.password && ROUTES.has(url.pathname);
  } catch { return false; }
}
export function networkAllowed(raw: string, profile: Profile): boolean {
  try {
    const url = new URL(raw);
    if (url.username || url.password) return false;
    if (url.protocol === 'data:') return true;
    if (url.protocol === 'blob:') return url.origin === profile.origin;
    if (url.protocol === 'ws:') url.protocol = 'http:';
    if (url.protocol === 'wss:') url.protocol = 'https:';
    return url.origin === profile.origin || (profile.mode === 'development' && url.origin === profile.apiOrigin);
  } catch { return false; }
}
export function externalLink(raw: string): boolean {
  try { const url = new URL(raw); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; }
  catch { return false; }
}
