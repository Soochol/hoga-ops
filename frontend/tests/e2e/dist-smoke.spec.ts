import { test, expect } from '@playwright/test';
import { API_URL } from './worktreeEnv';

/**
 * prod dist 서빙 스모크 (ADR-0134 §4, 지도 #985 · #993).
 *
 * 이 스펙만 vite 가 아니라 **백엔드를 직접** 본다 — 백엔드가
 * HOGA_FRONTEND_DIST 로 빌드 산출물을 same-origin 서빙하는
 * prod 형태를 그대로 재현한다(webServer command 가 build→prepare-dist→serve).
 * 리포에서 **빌드 산출물을 브라우저로 여는 유일한 검증**이다: manualChunks
 * 분할·modulepreload·config.json 로드·WS 상대경로 절대화는 vite dev 서버로는
 * 재현되지 않는 부류라, 이 스모크 전에는 전부 무검증이었다(감사 gap 발견).
 */
const DIST = API_URL;

test.describe('prod dist serving (ADR-0134)', () => {
  test('smoke: SPA 딥링크 → config.json → 첫 렌더 → same-origin WS 생존', async ({
    page,
  }) => {
    // goto 전에 대기를 건다 — 이벤트가 로드 중에 지나가면 못 잡는다.
    const wsEvent = page.waitForEvent('websocket', {
      predicate: (ws) => ws.url().includes('/api/ws'),
      timeout: 15_000,
    });
    const configResp = page.waitForResponse(
      (r) => r.url() === `${DIST}/config.json` && r.ok(),
      { timeout: 15_000 },
    );

    // 딥링크로 진입 — index.html 이 아니라 /live 를 직접 여는 것이 SPA fallback
    // (frontend_static.SpaStaticFiles) 검증을 겸한다.
    await page.goto(`${DIST}/live`);
    await configResp;

    // 첫 렌더 마커 — live-smoke S1 과 같은 계약(워크스페이스 빈 창 문구).
    await expect(page.getByText(/종목 없음/).first()).toBeVisible();

    // WS 가 same-origin 절대화(ws://<백엔드>/api/ws)로 열리고 **살아남는지**.
    // 포트는 워크트리마다 파생되므로 **API_URL 에서 만든다** — 박아 두면 이 스펙만
    // 다른 워크트리에서 깨진다.
    // OriginGuard 가 거부하면 accept 전에 1008 로 닫힌다 — 접속 직후 닫힘이
    // 그 서명이므로, 잠깐 뒤에도 열려 있음을 단언한다. (첫 하트비트는 30초
    // 뒤라 framereceived 대기는 스모크에 부적합.)
    const ws = await wsEvent;
    expect(ws.url()).toBe(`${API_URL.replace(/^http/, 'ws')}/api/ws`);
    await page.waitForTimeout(1500);
    expect(ws.isClosed()).toBe(false);
  });

  test('비폴백 경계: 미등록 /api 는 404 JSON 자리, index.html 이 아니다', async ({
    request,
  }) => {
    const res = await request.get(`${DIST}/api/definitely-not-a-route`);
    expect(res.status()).toBe(404);
    expect((await res.text()).includes('<!doctype html>')).toBe(false);
  });
});
