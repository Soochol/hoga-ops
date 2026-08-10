import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  DEFAULT_CONFIG,
  formatApiOrigin,
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

describe('formatApiOrigin / resolveApiOrigin', () => {
  const LOC = 'http://127.0.0.1:8765';

  it('shows the port of the configured base, not a hardcoded one', () => {
    // e2e 는 :8765 로 뜬다(vite 의 /config.json 미들웨어). 뱃지가 :8000 이라고
    // 하면 "테스트가 사용자 dev 서버에 붙었다" 로 오독된다.
    expect(formatApiOrigin({ api_url: 'http://127.0.0.1:8765' }, LOC)).toBe(':8765');
    expect(formatApiOrigin({ api_url: 'http://localhost:8000' }, LOC)).toBe(':8000');
  });

  it('falls back to the document origin in same-origin mode (api_url: "")', () => {
    // ADR-0134 prod dist 서빙 — 포트는 백엔드가 뜬 포트다.
    expect(formatApiOrigin({ api_url: '' }, LOC)).toBe(':8765');
    expect(formatApiOrigin({ api_url: '' }, 'https://hoga.example.com')).toBe('hoga.example.com');
  });

  it('keeps the host for non-loopback bases, with the port only when explicit', () => {
    expect(formatApiOrigin({ api_url: 'https://hoga.example.com' }, LOC)).toBe('hoga.example.com');
    expect(formatApiOrigin({ api_url: 'https://hoga.example.com:8443' }, LOC)).toBe('hoga.example.com:8443');
    // 기본 포트는 URL 이 떼어 준다 — 표기에 :443 이 남지 않아야 한다.
    expect(formatApiOrigin({ api_url: 'https://hoga.example.com:443' }, LOC)).toBe('hoga.example.com');
  });

  it('returns the raw base when it cannot be parsed', () => {
    expect(formatApiOrigin({ api_url: 'not a url' }, LOC)).toBe('not a url');
    expect(resolveApiOrigin({ api_url: 'not a url' }, LOC)).toBe('not a url');
  });

  it('resolves the full origin for the tooltip', () => {
    expect(resolveApiOrigin({ api_url: 'http://127.0.0.1:8765' }, LOC)).toBe('http://127.0.0.1:8765');
    expect(resolveApiOrigin({ api_url: '' }, LOC)).toBe('http://127.0.0.1:8765');
  });
});
