import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  DEFAULT_CONFIG,
  loadConfig,
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
