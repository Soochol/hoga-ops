/**
 * 캡처 큐의 **종결 신호를 WebSocket 프레임에서 직접** 관측한다.
 *
 * 왜: 캡처 스펙들은 "N of N done" 같은 **UI 텍스트**에 15~30초 벽시계 바운드를 걸어
 * 백엔드 작업이 끝나기를 기다렸다. 그런데 그 바운드가 감싼 작업은 작지 않다 —
 * `FakeHogaplayClient` 는 캡처 한 건당 **1,523 페이지**를 재생·파싱하고(실측 2.8~3.9초,
 * 32코어 개발기), 스펙은 그걸 동시에 3~4건 돌린다. 즉 예산 대비 여유가 로컬에서도
 * 5배 남짓이라, 2코어 공유 러너에서는 그냥 모자란다.
 *
 * 2026-08-03 CI 실측(PR #1003 의 e2e 잡): cookie-pause 1차 시도가 `4 of 5 done` 을
 * 30초 안에 못 보고 죽었는데, 그 순간 DOM 은 `1 capturing … 324/2916 27%` 였다 —
 * **아직 돌고 있었다.** 그리고 retry1·retry2 는 전혀 다른 줄(일시정지 배너)에서 죽었다.
 * 백엔드가 잡당 한 프로세스라 1차가 남긴 인플라이트 캡처가 재시도의 주입 카운터를
 * 갉아먹었기 때문이다 — **한 번 시간 초과가 나면 그 잡의 재시도는 전부 오염된다.**
 *
 * 그래서 관측을 바꾼다. 앱은 이미 `/api/ws` 로 `{ch:'event', data}` 프레임을 받는다
 * (ADR-0053, `src/api/ws.ts`). 그 안의 `capture_queue_drained` · `capture_queue_paused`
 * 는 백엔드가 "다 끝났다 / 멈췄다" 를 말하는 **1차 신호**다. Playwright 는
 * `page.on('websocket')` 으로 같은 프레임을 볼 수 있으므로, 폴링도 벽시계 예산도 없이
 * 그 신호를 기다릴 수 있다.
 *
 * **UI 단언을 대체하지 않는다.** 신호를 받은 뒤에도 "N of N done" 은 그대로 단언한다 —
 * 달라지는 건 그 단언이 이제 *캡처 작업*이 아니라 *렌더 반영*만 기다린다는 것이고,
 * 그래서 짧은 바운드로 충분해진다. UI 회귀는 여전히 잡힌다.
 *
 * 부수 효과가 하나 더 있다. `capture_finished(phase='failed')` 를 실패 오라클로 쓰면,
 * 캡처가 깨졌을 때 15초를 기다린 뒤 `element(s) not found` 를 보는 대신 **즉시 백엔드
 * 에러 메시지로** 죽는다. range-capture 주석이 적어 둔 과거 사고(주입 카운터가 새어
 * 3행이 전부 failed)가 정확히 이 형태였다.
 */
import type { Page } from '@playwright/test';

/** `src/api/types.ts` 의 `PushEvent` 중 이 헬퍼가 보는 것만. */
interface PushEvent {
  type: string;
  [key: string]: unknown;
}

interface CaptureFinishedEvent extends PushEvent {
  type: 'capture_finished';
  code: string;
  date: string;
  phase: string;
  error?: { code?: string; message?: string } | null;
}

/** 프레임 백스톱 — **성능 예산이 아니다.** 정상 경로는 프레임이 깨우므로 판정에
 *  관여하지 않는다. 교착일 때만 발화하며, 스펙의 `test.setTimeout` 보다 **작게**
 *  잡아 둔다 — 그래야 "테스트 시간 초과" 라는 익명의 메시지 대신 어떤 프레임을
 *  못 받았는지가 실패 사유로 남는다. */
const FRAME_BACKSTOP_MS = 90_000;

interface Waiter {
  label: string;
  match: (e: PushEvent) => boolean;
  failFast: boolean;
  settle: (err?: Error) => void;
}

export interface CaptureQueueProbe {
  /**
   * 지금 이후에 도착할 `capture_queue_drained` 1건을 예약한다.
   *
   * **행동을 일으키기 전에 부른다** — `const drained = probe.nextDrained();` 로 예약한 뒤
   * Start 를 클릭하고 `await drained` 한다. 클릭 후에 부르면 그 사이에 도착한 프레임을
   * 놓친다(Playwright 의 `waitForEvent` 와 같은 관용구).
   *
   * @param opts.allowFailed 실패한 항목이 **정상 시나리오**인 스펙(cookie-pause)에서만 켠다.
   *   기본값(false)은 `capture_finished(phase='failed')` 를 보는 즉시 그 에러로 거절한다.
   */
  nextDrained(opts?: { allowFailed?: boolean }): Promise<void>;
  /** 지금 이후의 `capture_queue_paused` 1건(쿠키 만료 일시정지). */
  nextPaused(): Promise<void>;
  /** 지금까지 받은 이벤트(디버깅·단언 보강용). */
  seen(): readonly PushEvent[];
}

/**
 * **네비게이션 전에 호출한다.** `page.on('websocket')` 은 리스너를 붙인 뒤에 열리는
 * 소켓만 잡는데, 앱은 첫 페이지 로드에서 `/api/ws` 를 연다. `selectSymbol()` 이
 * `page.goto` 를 하므로 그보다 앞서야 한다.
 */
export function observeCaptureQueue(page: Page): CaptureQueueProbe {
  const waiters = new Set<Waiter>();
  const seen: PushEvent[] = [];

  const describeFailure = (e: CaptureFinishedEvent): string =>
    `${e.code}/${e.date} 캡처 실패 — ${e.error?.code ?? 'unknown'}: ${e.error?.message ?? '(메시지 없음)'}`;

  const onEvent = (event: PushEvent): void => {
    seen.push(event);
    const failed =
      event.type === 'capture_finished' && (event as CaptureFinishedEvent).phase === 'failed';
    for (const w of [...waiters]) {
      if (failed && w.failFast) {
        waiters.delete(w);
        w.settle(
          new Error(
            `${w.label} 를 기다리는 중 ${describeFailure(event as CaptureFinishedEvent)}. ` +
              '실패 주입이 샜거나 페이크가 깨졌다 — 대기 시간 초과가 아니라 이게 원인이다.',
          ),
        );
        continue;
      }
      if (w.match(event)) {
        waiters.delete(w);
        w.settle();
      }
    }
  };

  page.on('websocket', (ws) => {
    ws.on('framereceived', (frame) => {
      if (typeof frame.payload !== 'string') return; // 바이너리 프레임은 이 채널에 없다
      let parsed: { ch?: string; data?: PushEvent };
      try {
        parsed = JSON.parse(frame.payload) as { ch?: string; data?: PushEvent };
      } catch {
        return;
      }
      if (parsed.ch === 'event' && parsed.data) onEvent(parsed.data);
    });
  });

  const waitFor = (label: string, match: Waiter['match'], failFast: boolean): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(waiter);
        reject(
          new Error(
            `${label} 프레임이 ${FRAME_BACKSTOP_MS / 1000}s 안에 오지 않았다. ` +
              `받은 이벤트: ${seen.map((e) => e.type).join(', ') || '없음'}`,
          ),
        );
      }, FRAME_BACKSTOP_MS);
      const waiter: Waiter = {
        label,
        match,
        failFast,
        settle: (err) => {
          clearTimeout(timer);
          if (err) reject(err);
          else resolve();
        },
      };
      waiters.add(waiter);
    });

  return {
    nextDrained: (opts) =>
      waitFor('capture_queue_drained', (e) => e.type === 'capture_queue_drained', !opts?.allowFailed),
    nextPaused: () => waitFor('capture_queue_paused', (e) => e.type === 'capture_queue_paused', false),
    seen: () => seen,
  };
}
