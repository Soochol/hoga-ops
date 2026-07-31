/**
 * `/live` 틱 채널 모킹 — `page.routeWebSocket` (Playwright ≥ 1.48; 이 저장소는 1.60).
 *
 * SSE→WebSocket 이관(ADR-0053) 이후 틱은 `page.route` 로 못 잡는다. 앱은 `/api/ws` 하나만
 * 열고 `{ch}` 로 다중화한다. 그래서 `liveMocks.ts` 에 "TODO(ws-migration)" 만 남고 e2e 가
 * **실시간 흐름을 한 번도 구동하지 못했다** — 정적 화면만 검사해 온 셈이다.
 *
 * 계약(`src/api/ws.ts` 그대로):
 *   - 클라이언트 → 서버: `{action: 'subscribe'|'unsubscribe', code}`
 *   - 서버 → 클라이언트: `{ch:'event', data}` · `{ch:'live', code, data}`
 *     (`subscribed`·`heartbeat` 는 클라이언트에 분기가 없다 — 아무 프레임이나 liveness 를
 *      갱신할 뿐이다. 그래도 실제 서버가 보내므로 핸드셰이크에서 돌려준다.)
 *
 * 핸들러가 `connectToServer()` 를 부르지 않으므로 **진짜 백엔드로 가지 않는다** — 틱 타이밍이
 * 전적으로 스펙 손에 있다. 그게 이 모킹의 요점이다.
 */
import { expect, type Page, type WebSocketRoute } from '@playwright/test';

export interface LiveWsHandle {
  /** 앱이 `code` 를 구독할 때까지 기다린다. 구독 전에 밀어 넣으면 조용히 사라진다. */
  waitForSubscribe(code: string): Promise<void>;
  /** `{ch:'live', code, data}` 한 프레임. */
  pushLive(code: string, data: Record<string, unknown>): void;
  /** 지금까지 구독된 코드들(디버깅용). */
  subscribed(): string[];
}

/** KRX 정규장 안의 **고정** 시각(2026-06-01 10:00 KST).
 *
 *  `liveVenueAcceptsFrame` 은 AUTO venue 에서 `liveSubscriptionVenueForMs(t_ms)` 와 태그를
 *  비교하는데, 그 함수는 **t_ms 의 순수 함수**다(그 날짜의 09:00 기준 08:50~15:31 이면 KRX).
 *  따라서 고정 시각을 쓰면 테스트가 **언제 돌든** 같은 판정을 받는다 — `Date.now()` 를 쓰면
 *  장 시간 밖에서 NXT 로 판정돼 프레임이 조용히 버려진다. */
export const KRX_SESSION_MS = Date.UTC(2026, 5, 1, 1, 0, 0); // 10:00 KST = 01:00 UTC

export async function installLiveWs(page: Page): Promise<LiveWsHandle> {
  let socket: WebSocketRoute | null = null;
  const subs = new Set<string>();

  await page.routeWebSocket('**/api/ws', (ws) => {
    socket = ws;
    ws.onMessage((message) => {
      let parsed: { action?: string; code?: string };
      try {
        parsed = JSON.parse(String(message)) as { action?: string; code?: string };
      } catch {
        return;
      }
      if (parsed.action === 'subscribe' && parsed.code) {
        subs.add(parsed.code);
        ws.send(JSON.stringify({ ch: 'subscribed', code: parsed.code }));
      } else if (parsed.action === 'unsubscribe' && parsed.code) {
        subs.delete(parsed.code);
      }
    });
  });

  return {
    async waitForSubscribe(code: string) {
      await expect
        .poll(() => subs.has(code), {
          message: `앱이 ${code} 를 구독하지 않았다 (구독된 것: ${[...subs].join(',') || '없음'})`,
          timeout: 15_000,
        })
        .toBe(true);
    },
    pushLive(code: string, data: Record<string, unknown>) {
      if (socket === null) throw new Error('WebSocket 이 아직 연결되지 않았다 — waitForSubscribe 먼저');
      socket.send(JSON.stringify({ ch: 'live', code, data }));
    },
    subscribed: () => [...subs],
  };
}

/** `tradeSample`(liveTickOverlay.ts) 이 받아들이는 최소 체결 프레임.
 *
 *  통과 조건이 좁다 — `kind==='trade'` · 숫자 `t_ms` · venue 수용 · 비어 있지 않은 `trades`
 *  배열의 마지막 원소에 양수 `price`. 종목 단위 값(`prev_close` 등)은 체결마다 반복되지 않고
 *  payload 최상위에 실린다. */
export function tradeFrame(opts: {
  price: number;
  prevClose?: number;
  tMs?: number;
  venue?: 'KRX' | 'NXT';
}): Record<string, unknown> {
  return {
    t_ms: opts.tMs ?? KRX_SESSION_MS,
    kind: 'trade',
    venue: opts.venue ?? 'KRX',
    trades: [{ price: opts.price }],
    ...(opts.prevClose === undefined ? {} : { prev_close: opts.prevClose }),
  };
}
