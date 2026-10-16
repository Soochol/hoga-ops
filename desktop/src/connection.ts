import { canonicalOrigin, type Profile } from './profiles';

export interface ServerInfo { version: string; commit?: string; warning?: string }
export async function probeServer(profile: Profile, signal: AbortSignal, request: typeof fetch = fetch): Promise<ServerInfo> {
  const get = async (url: string): Promise<Response> => {
    try {
      const response = await request(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]), redirect: 'error', cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response;
    } catch (error) {
      if (signal.aborted) throw new Error('연결 시도를 취소했습니다.', { cause: error });
      const detail = error instanceof Error && /^HTTP \d+$/.test(error.message) ? error.message : '연결 실패 또는 시간 초과';
      throw new Error(`${new URL(url).pathname}: ${detail}. 서버 주소와 Tailscale 연결을 확인하세요.`, { cause: error });
    }
  };
  const api = profile.apiOrigin ?? profile.origin;
  const [healthResponse, configResponse, page] = await Promise.all([
    get(`${api}/health`), get(`${profile.origin}/config.json`), get(`${profile.origin}/live`),
  ]);
  const health = await healthResponse.json();
  const config = await configResponse.json();
  if (health?.status !== 'ok' || typeof health.version !== 'string') throw new Error('Hoga 서버의 health 응답이 올바르지 않습니다.');
  const configured = config?.api_url ?? config?.apiBaseUrl;
  let configuredOrigin: string | undefined;
  if (typeof configured === 'string') {
    try { configuredOrigin = configured === '' ? profile.origin : canonicalOrigin(configured); } catch { /* rejected below */ }
  }
  if (profile.mode === 'server' ? configured !== '' : configuredOrigin !== api) {
    throw new Error('config.json의 API 주소가 선택한 서버와 다릅니다. 운영 서버는 HOGA_FRONTEND_DIST로 같은 origin을 제공해야 합니다.');
  }
  if (!page.headers.get('content-type')?.includes('text/html') || !(await page.text()).includes('id="root"')) {
    throw new Error('프론트 화면이 없습니다. 서버의 HOGA_FRONTEND_DIST 설정과 프론트 빌드를 확인하세요.');
  }
  return { version: health.version, commit: typeof health.commit === 'string' ? health.commit : undefined };
}
