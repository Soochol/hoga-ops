import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { validZoomFactor } from './zoom';

export interface Profile { id: string; name: string; mode: 'server' | 'development'; origin: string; apiOrigin?: string }
export interface Bounds { x: number; y: number; width: number; height: number; maximized?: boolean }
export interface Settings { version: 1; profiles: Profile[]; activeId?: string; bounds: Record<string, Bounds>; zoomFactors: Record<string, number> }
export const emptySettings = (): Settings => ({ version: 1, profiles: [], bounds: {}, zoomFactors: {} });

export function canonicalOrigin(input: unknown): string {
  if (typeof input !== 'string' || input.length > 2048) throw new Error('서버 주소를 입력하세요.');
  const url = new URL(input.trim());
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('http(s)://호스트:포트 형식의 주소만 입력하세요. 경로와 인증정보는 넣지 마세요.');
  }
  return url.origin;
}

export function validateProfile(raw: unknown, developmentAllowed = true): Profile {
  if (!raw || typeof raw !== 'object') throw new Error('연결 설정이 올바르지 않습니다.');
  const value = raw as Record<string, unknown>;
  if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 80) throw new Error('서버 이름을 80자 이내로 입력하세요.');
  if (value.mode !== 'server' && value.mode !== 'development') throw new Error('지원하지 않는 연결 모드입니다.');
  if (value.mode === 'development' && !developmentAllowed) throw new Error('개발 모드는 소스 실행에서만 사용할 수 있습니다.');
  const profile: Profile = {
    id: typeof value.id === 'string' && /^[\w-]{1,80}$/.test(value.id) ? value.id : randomUUID(),
    name: value.name.trim(), mode: value.mode, origin: canonicalOrigin(value.origin),
  };
  if (profile.mode === 'development') profile.apiOrigin = canonicalOrigin(value.apiOrigin);
  return profile;
}

export function sessionKey(profile: Profile): string {
  return createHash('sha256').update(`${profile.mode}:${profile.origin}:${profile.apiOrigin ?? ''}`).digest('hex').slice(0, 32);
}

export function validateBounds(raw: unknown): raw is Bounds {
  if (!raw || typeof raw !== 'object') return false;
  const b = raw as Record<string, unknown>;
  return ['x', 'y', 'width', 'height'].every(key => typeof b[key] === 'number' && Number.isFinite(b[key]))
    && Number(b.width) >= 400 && Number(b.width) <= 20000 && Number(b.height) >= 300 && Number(b.height) <= 20000;
}

export function readSettings(path: string): { settings: Settings; warning?: string } {
  if (!existsSync(path)) return { settings: emptySettings() };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    if (raw.version !== 1 || !Array.isArray(raw.profiles) || raw.profiles.length > 50) throw new Error('schema');
    const profiles = raw.profiles.map((p: unknown) => validateProfile(p));
    if (new Set(profiles.map((p: Profile) => p.id)).size !== profiles.length) throw new Error('duplicate');
    const bounds: Record<string, Bounds> = {};
    const zoomFactors: Record<string, number> = {};
    if (raw.bounds && typeof raw.bounds === 'object') {
      for (const [key, value] of Object.entries(raw.bounds)) if (/^[a-f0-9]{32}$/.test(key) && validateBounds(value)) bounds[key] = value;
    }
    if (raw.zoomFactors && typeof raw.zoomFactors === 'object') {
      for (const [key, value] of Object.entries(raw.zoomFactors)) if (/^[a-f0-9]{32}$/.test(key) && validZoomFactor(value)) zoomFactors[key] = value;
    }
    return { settings: { version: 1, profiles, bounds, zoomFactors, activeId: profiles.some((p: Profile) => p.id === raw.activeId) ? raw.activeId : undefined } };
  } catch {
    // Keep the original bytes in a recoverable sibling before future writes.
    const backup = `${path}.corrupt-${Date.now()}`;
    renameSync(path, backup);
    return { settings: emptySettings(), warning: '연결 설정이 손상되어 백업한 뒤 초기화했습니다. 서버 주소를 다시 입력하세요.' };
  }
}

export function saveSettings(path: string, settings: Settings): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
  renameSync(temporary, path);
}

export function fitBounds(saved: Bounds | undefined, areas: Bounds[]): Bounds {
  const area = areas.find(a => saved && saved.x < a.x + a.width && saved.x + saved.width > a.x
    && saved.y < a.y + a.height && saved.y + saved.height > a.y) ?? areas[0];
  const width = Math.min(saved?.width ?? 1440, area.width);
  const height = Math.min(saved?.height ?? 960, area.height);
  return { x: Math.max(area.x, Math.min(saved?.x ?? area.x, area.x + area.width - width)),
    y: Math.max(area.y, Math.min(saved?.y ?? area.y, area.y + area.height - height)), width, height };
}
