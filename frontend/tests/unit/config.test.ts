import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  DEFAULT_CONFIG,
  loadConfig,
  resolveApiOrigin,
  resolveApiUrl,
  resolveWsUrl,
} from '../../src/config';

describe('loadConfig', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('returns parsed config on 200', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ api_url: 'http://x:9000/' }),
    } as Response);
    expect(await loadConfig()).toEqual({ api_url: 'http://x:9000' });
  });

  it('accepts apiBaseUrl as a deployment config alias', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ apiBaseUrl: 'http://x:9001/' }),
    } as Response);
    expect(await loadConfig()).toEqual({ api_url: 'http://x:9001' });
  });

  it('falls back to default on failure', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('boom'));
    expect(await loadConfig()).toEqual(DEFAULT_CONFIG);
  });

  it('falls back to default on malformed shape', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ api_url: 123 }),
    } as Response);
    expect(await loadConfig()).toEqual(DEFAULT_CONFIG);
  });

  it('defaults to the real backend port so a config.json failure still reaches the API', () => {
    expect(DEFAULT_CONFIG.api_url).toBe('http://localhost:8000');
  });

  it('builds REST URLs with one slash between base and path', () => {
    expect(resolveApiUrl({ api_url: 'http://x:9000/' }, '/api/health')).toBe('http://x:9000/api/health');
    expect(resolveApiUrl({ api_url: 'http://x:9000' }, 'api/health')).toBe('http://x:9000/api/health');
  });

  it('builds WebSocket URLs from the same runtime config', () => {
    expect(resolveWsUrl({ api_url: 'http://x:9000' }, '/api/ws')).toBe('ws://x:9000/api/ws');
    expect(resolveWsUrl({ api_url: 'https://x.example' }, '/api/ws')).toBe('wss://x.example/api/ws');
  });

  it('absolutizes same-origin WS URLs from window.location (api_url: "")', () => {
    // jsdom 기본 origin 은 http://localhost:3000 — 상대 '/api/ws' 가
    // 스킴 있는 절대 ws:// 로 나와야 구형 웹뷰의 SyntaxError 를 피한다(ADR-0134).
    expect(resolveWsUrl({ api_url: '' }, '/api/ws')).toBe(
      `ws://${window.location.host}/api/ws`,
    );
    expect(resolveWsUrl({ api_url: '' }, '/api/ws').startsWith('ws://')).toBe(true);
  });
});

// 짝이던 `formatApiOrigin`(nav 뱃지용 `:8765` 압축 표기)은 StatusDot 의 텍스트 라벨이
// 사라지면서 함께 삭제됐다 — 유일한 소비자였다. **뱃지가 오리진을 설정에서 읽는다**는
// 계약(리터럴 `:8000` 회귀 방지)은 여전히 유효하고, 이제 툴팁 쪽에서
// `src/nav/StatusDot.test.tsx` 가 지킨다.
describe('resolveApiOrigin', () => {
  const LOC = 'http://127.0.0.1:8765';

  it('returns the raw base when it cannot be parsed', () => {
    expect(resolveApiOrigin({ api_url: 'not a url' }, LOC)).toBe('not a url');
  });

  it('resolves the full origin for the tooltip', () => {
    expect(resolveApiOrigin({ api_url: 'http://127.0.0.1:8765' }, LOC)).toBe('http://127.0.0.1:8765');
    // ADR-0134 same-origin — api_url 이 비면 문서 오리진이 실제 base 다.
    expect(resolveApiOrigin({ api_url: '' }, LOC)).toBe('http://127.0.0.1:8765');
    // 비루프백·명시 포트는 오리진에 그대로 남는다(기본 포트는 URL 이 떼어 준다).
    expect(resolveApiOrigin({ api_url: 'https://hoga.example.com:8443' }, LOC)).toBe('https://hoga.example.com:8443');
    expect(resolveApiOrigin({ api_url: 'https://hoga.example.com:443' }, LOC)).toBe('https://hoga.example.com');
  });
});
