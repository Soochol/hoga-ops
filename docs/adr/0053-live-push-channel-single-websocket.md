# 0053 — Live push 채널은 단일 WebSocket 전송으로 통일한다 (SSE 2종 대체)

**Status:** accepted (2026-05-30) — 구현은 spec/plan에서 추적

**Related:**
- ADR-0044 — Live page hover spot reads from parquet, not LiveBuffer (본 ADR이 보존하는 invariant)
- ADR-0039 — Source Preference (`sources_available` 판정의 "SSE buffer" 용어 출처)
- ADR-0036 — 로컬 단일 사용자 배포 (HTTP/2 프로덕션 경로 부재의 근거)
- ADR-0005 — Capture state mutation lives on the event loop (async 핸들러 전제)
- `docs/superpowers/specs/2026-05-30-live-websocket-transport-design.md`

## Decision

`/live`를 비롯한 모든 페이지의 실시간 push 데이터는 **탭당 WebSocket 1개(`/api/ws`)**로
전달한다. 지금까지 두 개의 장수명 SSE — 전역 앱 이벤트(`/api/events`)와 종목별 실시간
스냅샷(`/api/live/stream?code=`) — 가 하던 일을 한 WS 연결에 다중화하고, **두 SSE
엔드포인트는 제거**한다.

- 서버→클라 프레임: `{ "ch": "event" | "live" | "heartbeat", "data": {…} }`. 클라이언트가
  `ch`로 demux.
- 클라→서버: `{ "action": "subscribe" | "unsubscribe", "code": "005930" }`. 연결 시
  전역 이벤트는 자동 구독, 종목 시세는 `subscribe`로 켜고 종목 전환 시 재연결 없이
  채널만 바꾼다.
- 데이터 공급원(`_Bus` + watchdog observer, `LiveBuffer` + KIS poller)은 **변경 없음** —
  출구만 WS로 바뀐다.

## Why

브라우저는 HTTP/1.1에서 **origin당 동시 연결 6개**로 제한하며(Chrome
`kMaxSocketsPerGroup=6`), 이 소켓 풀은 같은 top-frame site의 **모든 탭이 공유**한다.
EventSource(SSE)는 소켓을 영구 점유하므로, 활성 `/live` 탭마다 2개의 SSE가
풀을 갉아먹어 **3탭에서 6개가 차고**, 7번째 요청(호버 시 `/api/orderbook` fetch,
ADR-0044의 parquet spot 경로)이 소켓을 못 얻어 무한 대기한다. 이번 세션에서
재현·검증했다(6 SSE 점유 → 7번째 GET 3000ms timeout, 2개 닫으면 2ms OK; 두 실제
탭으로 탭 간 풀 공유까지 확인).

**WebSocket은 이 HTTP 소켓 풀을 소비하지 않는다** — 별도 한계(Chrome 호스트당 ~255)를
쓴다. 따라서 모든 장수명 SSE를 WS로 옮기면 HTTP 풀은 일시적 fetch만 쓰게 되어
**탭 수와 무관하게 절대 마르지 않는다(실패 부류 제거)**.

### 대안과 기각 사유

- **HTTP/2**: 추상적으로 가장 깔끔(연결 1개에 ~100 스트림 다중화, 프론트 무변경).
  그러나 uvicorn은 h2 미지원이고, 단일 사용자 로컬 배포라 TLS/리버스 프록시/프로덕션
  경로가 없다(ADR-0036). 설치할 수 없는 치료제 → 기각.
- **SharedWorker(연결 1개)**: 종목이 탭마다 달라 per-code 스트림은 공유 불가 →
  워커가 종목당 1개 + 전역 1개 = N+1 연결. WS(탭당 1, 풀 미소비)보다 헤드룸이 *작은데*
  워커 생명주기·cross-tab refcount·Vite HMR 고착·미테스트 onconnect seam의 복잡성과
  위험은 최대 → 기각.
- **merge-SSE-to-one**: 탭당 SSE 2→1로 천장을 3→6탭으로 올릴 뿐 실패 부류는 잔존
  (6탭에서 재발) → 궁극 해결 아님, 기각.
- **WebSocket(채택)**: 실패 부류를 제거하면서 SharedWorker 복잡성을 회피. 양방향이라
  종목 구독 전환이 메시지 한 줄. 유일한 추가 부담은 자동 재연결 직접 구현.

## 보존하는 invariant (ADR-0044)

WS 마이그레이션은 **live tick stream 전송 경로만** 바꾼다. `/live` hover spot
(`useLiveOrderbookAtCursor` / `useLiveBrokersAtCursor`)은 ADR-0044대로 **parquet REST
경로를 그대로** 쓰며 WS/LiveBuffer에 의존하지 않는다 — 즉 ADR-0044의 invariant는
유지된다. (호버가 굶던 것은 *그 fetch가 풀 슬롯을 못 얻어서*였지, 경로가 SSE라서가
아니다.)

## 새 invariant

> 실시간 push 채널(전역 이벤트 + live tick)은 단일 WebSocket(`/api/ws`)으로만 전달한다.
> 새 EventSource/SSE 장수명 엔드포인트를 추가하면 ADR-0053 위반 — HTTP/1.1 연결풀
> 회귀(멀티탭 고갈)를 재도입하게 된다.

## Trade-off / consequences

- **재연결**: EventSource의 자동 재연결이 사라지므로 프론트가 백오프 재연결 +
  활성 code 재구독 + ping 기반 dead-connection 탐지를 구현한다.
- **용어 표류**: ADR-0039가 부르는 "SSE buffer"는 실제로는 `LiveBuffer`(in-memory ring)
  이며 본 결정 이후에도 그대로다 — 전송만 WS로 바뀐다. "SSE buffer"는 레거시 별칭이 되며,
  새 코드/문서는 `LiveBuffer`로 칭한다.
- **부수 수정**: `liveSeries.ts`가 `es.onmessage`로 named `live_snapshot` 이벤트를 놓치던
  잠재 버그가 프로토콜을 우리가 정의함으로써 구조적으로 소멸한다.
- **의존성**: `EventSourceResponse` 사용처가 사라지면 `sse-starlette` 의존성 제거 가능
  (선택적 정리).
- **용어 구분**: WS 프로토콜의 `subscribe`/`unsubscribe`는 **전송 계층 액션**으로,
  도메인 **Watchlist**(CONTEXT.md가 "subscription"이라 부르길 피하는 그것)와 무관하다.

## Future signal to revisit

- 멀티유저/호스팅 검토 시(ADR-0036의 트리거와 동일) — 그 경우 인증·세션이 WS
  핸드셰이크에 얹혀야 하고 HTTP/2 프록시도 비로소 선택지가 된다.
- 단일 WS의 fan-in이 다수 종목 동시 구독에서 병목이 되는 신호가 측정될 때(현 UI는
  탭당 activeCode 1개라 비현실적).
