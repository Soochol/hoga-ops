# Live WebSocket Transport — 단일 전송 통일 설계

- **Date**: 2026-05-30
- **Status**: Approved (GATE 1 통과, grill 완료) — plan 작성 대기
- **Scope**: `both` (backend + frontend)
- **Topic slug**: `live-websocket-transport`
- **ADR**: [ADR-0053](../../adr/0053-live-push-channel-single-websocket.md) — Live push 채널 단일 WebSocket 전송

## 1. 문제 (진단 완료)

`/live`에서 캔들에 호버하면 `GET /api/orderbook` fetch로 10호가를 가져온다. **활성 `/live` 탭을 3개 이상 열면 10호가가 안 뜬다.**

### 근본 원인 (이번 세션에서 재현·검증)

브라우저는 HTTP/1.1에서 **origin당 동시 연결을 6개로 제한**한다(Chrome `kMaxSocketsPerGroup=6`). 이 풀은 *같은 top-frame site의 모든 탭이 공유*한다. **EventSource(SSE)는 소켓을 영구 점유**한다.

활성 `/live` 탭 하나는 `:8000`으로 **장수명 SSE를 정확히 2개** 연다:

1. `/api/events` — 전역 앱 이벤트(inventory/capture/heartbeat). `App.tsx`에서 `useEventStream()`으로 앱 전역 마운트.
2. `/api/live/stream?code=` — 종목별 실시간 스냅샷. `LivePage`의 단일 `useLiveSeries` 소유.

→ **3탭 × 2 SSE = 6 = 풀 포화** → 7번째 요청(호버 orderbook fetch)이 소켓을 못 얻고 무한 대기.

**재현 증거**: 6개 SSE 점유 시 7번째 GET = 3000ms TimeoutError, 2개 닫으면 2ms OK. 두 실제 탭으로 탭 간 풀 공유까지 end-to-end 확인.

### 부수 발견 (이 설계가 함께 해소)

`liveSeries.ts:97`은 `es.onmessage`로 수신하나, 백엔드(`hoga/live/api.py:238`)는 **named 이벤트** `live_snapshot`을 보낸다. SSE에서 named 이벤트는 `onmessage`를 발화시키지 않으므로 **실시간 틱이 통째로 누락**되고 초기 REST 하이드레이트만 동작한다. wire 포맷(`event: heartbeat`)으로 실측 확인했고, 테스트는 스텁이 `onmessage`로 전달해 green을 유지하며 이 버그를 가린다.

## 2. 목표 / 비목표

### 목표
- 탭 수와 무관하게 호버 10호가·캔들 등 모든 REST fetch가 **절대 굶지 않는다**(실패 부류 제거).
- 실시간 시세가 실제로 스트리밍된다(named-event 버그 해소).
- 전송 방식을 단순화한다(전송 종류가 늘지 않고 줄어든다).

### 비목표
- KIS 폴러·`LiveBuffer`·watchdog observer 등 **데이터 공급원 변경 없음**.
- 인증/멀티유저/호스팅 도입 없음(단일 사용자 로컬 툴, CONTEXT.md).
- 화면 동작/레이아웃 변경 없음(사용자에게 보이는 결과는 "안 끊김"뿐).

## 3. 결정과 근거

**WebSocket 단일 전송으로 통일한다.** 탭마다 WS 1개(`/api/ws`)가 전역 이벤트 + 실시간 시세를 다중화하고, 기존 SSE 엔드포인트 2개를 제거한다.

### 왜 WebSocket인가 (대안 비교)

브라우저 풀 한계(6, 전 탭 공유)는 **fetch/SSE가 쓰는 HTTP 소켓 풀**에만 적용된다. **WebSocket은 별도 한계**(Chrome 호스트당 ~255)를 쓰며 이 풀을 소비하지 않는다. 따라서 모든 장수명 SSE를 WS로 옮기면 HTTP 풀은 일시적 fetch만 쓰게 되어 절대 마르지 않는다.

| 방안 | 탭 N개(종목 다름) 상시 연결 | 안전 탭 수 | 비고 |
|---|---|---|---|
| 현재 (SSE 2/탭) | `2N` | 2 (3에서 깨짐) | — |
| merge-SSE-to-one | `N` | 5 | 천장만 올림(궁극 아님) |
| SharedWorker + 다중종목 SSE | `1` | ∞ | 워커 생명주기·refcount·HMR 고착·미테스트 seam (최고 위험) |
| **WebSocket 통일 (채택)** | `N` (WS, 6-풀 미소비) | **∞** (~255) | SharedWorker 불필요, 양방향, 전송 단일화 |

- **HTTP/2**: 추상적으로 가장 깔끔하나 이 환경에선 불가 — uvicorn은 h2 미지원, 단일 사용자 로컬이라 TLS/프록시/프로덕션 경로 없음.
- **SharedWorker(연결 1개)**: 종목이 탭마다 달라 per-code 스트림은 공유 불가 → 워커가 종목당 1개씩 보유(=N+1), 헤드룸이 WS보다 작은데 복잡성·위험은 최대. 채택하지 않음.
- **WebSocket**: 실패 부류를 *제거*하면서 SharedWorker 복잡성을 회피한다. 양방향이라 종목 구독 전환이 재연결 없이 메시지 한 줄. 유일한 추가 부담은 자동 재연결을 직접 구현해야 한다는 점.

## 4. 아키텍처

### 4.1 메시지 프로토콜 (봉투)

**서버 → 클라이언트** (모든 메시지는 JSON):
```json
{ "ch": "event", "data": { "type": "inventory_added", "code": "005930", "date": "20260530" } }
{ "ch": "live",  "data": { "t_ms": 1716000000000, "kind": "ob", "...": "..." } }
{ "ch": "heartbeat" }
```
- `ch`가 채널 식별자(demux 키). `event`는 기존 전역 이벤트 payload를 `data`에 그대로 담는다. `live`는 `LiveBuffer` 스냅샷 dict.

**클라이언트 → 서버**:
```json
{ "action": "subscribe",   "code": "005930" }
{ "action": "unsubscribe", "code": "005930" }
```
- 연결 즉시 전역 이벤트(`ch:"event"`)는 **자동 구독**(별도 action 불필요).
- 종목 시세는 `subscribe`로 켠다. `/live`에서 종목 전환 시 `unsubscribe(이전)+subscribe(신규)` — **재연결 없이** 채널만 바꾼다.
- 한 WS는 동시에 0..N개 코드를 구독할 수 있다(현재 UI는 탭당 1개지만 프로토콜은 제약하지 않음).

`live_snapshot` vs `onmessage` 버그는 구조적으로 소멸한다 — 프레임 형태를 우리가 정의하고 `ch`로 demux하므로 named/unnamed 구분 자체가 없다.

### 4.2 백엔드

**새 라우터** `build_ws_router(bus, get_buffer)` → `@router.websocket("/api/ws")`.

연결 수명:
1. accept 후 `q_event = bus.subscribe()` (전역, 항상 구독).
2. 클라이언트 메시지 수신 태스크: `subscribe`/`unsubscribe` action에 따라 `get_buffer().subscribe(code)` / `unsubscribe(code, q)`로 per-code 큐 집합을 관리.
3. 송신: 구독 중인 모든 큐(전역 1 + per-code k)를 **fan-in**(예: 각 큐마다 reader 태스크 → 단일 out-queue, 또는 `asyncio.wait(FIRST_COMPLETED)`)하여 `{ch, data}` 프레임으로 전송.
4. 30초마다 ping(`{ch:"heartbeat"}`) — 죽은 연결 탐지.
5. 종료(`finally`): `bus.unsubscribe(q_event)` + 구독 중이던 모든 `buffer.unsubscribe(code, q)`.

**재사용(무변경)**: `_Bus`(`hoga/api/sse.py`)와 watchdog observer, `LiveBuffer`(`hoga/live/buffer.py`)와 KIS 폴러(`poller.py`)는 공급원으로 그대로 둔다. 출구만 WS로 바뀐다.

**제거**:
- `hoga/api/sse.py`의 `@router.get("/api/events")` 라우트. `build_sse`는 `bus`+`observer` 생성은 유지하되 SSE 라우트는 등록하지 않는다(WS 라우터가 `bus`를 주입받아 소비).
- `hoga/live/api.py`의 `@router.get("/stream")` 라우트.
- 결과적으로 `EventSourceResponse` 사용처가 사라지면 `sse-starlette` 의존성 제거 가능(선택적 정리).

**와이어링** (`hoga/api/app.py`): `build_sse(...)`가 반환하는 `bus`와 `live_get_buffer`를 `build_ws_router(bus, live_get_buffer)`에 주입해 `app.include_router` 한다(둘 다 이미 build 함수 스코프에 있음).

**교차 출처**: dev는 `:5173` 페이지 → `:8000` WS. CORSMiddleware는 WS 핸드셰이크에 적용되지 않으며 Starlette은 기본적으로 Origin으로 거부하지 않으므로 동작이 예상되나, 구현 시 핸드셰이크를 1회 검증한다(리스크 항목).

### 4.3 프론트엔드

**신설 `frontend/src/api/ws.ts`** — 단일 WS 클라이언트:
- 모듈 싱글톤 WS(`sse.ts`의 `_source`/`_opening`/`_subscribers` 패턴 계승), `apiUrl()`로 `ws(s)://…/api/ws` 해석.
- 구독자 fan-out: 채널별(`event`/`live`) 핸들러 등록.
- per-code 구독 관리: `subscribeLive(code, handler)` → 첫 구독이면 `{action:"subscribe",code}` 송신, 마지막 해제면 `unsubscribe` 송신(탭 내 refcount; 탭 간 공유는 비목표).
- **자동 재연결**: 지수 백오프, 재연결 후 활성 code 재구독, 끊김 시 `disconnected` 이벤트 발행(기존 복구 로직 재사용).
- DI 가능한 순수 코어(WS 팩토리 주입)로 작성해 단위 테스트가 가능하게 한다.

**`frontend/src/api/sse.ts` → 개편**: `useEventStream`/`subscribeToCaptureEvents`의 **공개 시그니처를 유지**하고 내부 소스만 `ws.ts`의 `event` 채널로 바꾼다. 따라서 호출처 3곳(`App.tsx`, `capture/useCaptureQueue.ts`, `inventory/useInventoryRecaptureOrigins.ts`)은 **변경 없음**. (파일명은 `sse.ts` 유지 또는 `eventStream.ts`로 개명 — plan에서 결정.)

**`frontend/src/api/liveSeries.ts` → 개편**: 자체 `new EventSource('/api/live/stream?code=')` 제거 → `ws.ts`의 `subscribeLive(code, …)` 구독으로 교체. **`LiveSnapshotBuffer`·rAF coalescing·clear-on-unmount는 탭 측에 그대로 유지**(frozen-reference 안정성 캐시 보존). 초기 하이드레이트 `GET /api/live/series`는 유지(일시 fetch).

### 4.4 데이터 흐름

```
KIS poller ──publish──▶ LiveBuffer(code) ──┐
watchdog ──▶ _Bus ─────────────────────────┤ (fan-in)
                                            ▼
                              WS /api/ws  ── {ch,data} ──▶ ws.ts(탭)
                                                              ├─ ch:event ─▶ useEventStream / subscribeToCaptureEvents
                                                              └─ ch:live  ─▶ liveSeries(buffer.push → rAF → render)
```

## 5. 컴포넌트 경계

| 유닛 | 책임 | 의존 |
|---|---|---|
| `build_ws_router` | WS 수명·구독 라우팅·fan-in·ping·teardown | `_Bus`, `LiveBuffer` (주입) |
| `ws.ts` | 단일 WS·재연결·채널 fan-out·per-code refcount | `apiUrl` |
| `sse.ts`(개편) | 전역 이벤트 구독 공개 API(시그니처 불변) | `ws.ts` |
| `liveSeries.ts`(개편) | 초기 하이드레이트 + live 채널 구독 → 버퍼 | `ws.ts`, `LiveSnapshotBuffer` |

## 6. 에러 처리

- **연결 끊김**: `ws.ts`가 백오프 재연결 + 활성 code 재구독. `disconnected` 발행 → 기존 복구(stock-dates/queue/calendar 쿼리 무효화) 그대로 발화.
- **큐 오버플로**: 백엔드 큐는 기존대로 bounded; 느린 소비자는 drop(데이터는 `get_series`/REST로 복구 가능) — 현 동작 유지.
- **죽은 연결**: 30초 ping 무응답/close 이벤트로 탐지 → 재연결 트리거.
- **악성/비정상 메시지**: 알 수 없는 `action`/`ch`는 무시(로그).

## 7. 테스트 전략

- jsdom엔 WebSocket이 없다(현재 테스트는 `globalThis.EventSource`를 스텁). → **`globalThis.WebSocket`을 `FakeWebSocket`으로 스텁**.
- 마이그레이션 대상 6개 테스트 파일: `sse.test.ts`, `liveSeries.test.tsx`, `LivePage.test.tsx`, `inventory/useInventoryRecapture.test.tsx`, `capture/CaptureForm.test.tsx`, `inventory/StockDateGroupDetail.test.tsx`.
- `liveSeries.test.tsx`: 버퍼/하이드레이트 단언은 유지, "구독 → 메시지" 메커니즘만 WS `ch:"live"` 프레임으로 교체(→ 실시간 틱 누락 회귀 방지).
- 백엔드: `build_ws_router`를 Starlette `TestClient.websocket_connect`로 단위 테스트(subscribe/unsubscribe/fan-in/teardown/heartbeat).

## 8. 범위와 영향 파일

**백엔드**: `hoga/api/sse.py`(라우트 제거, bus/observer 유지), `hoga/live/api.py`(stream 라우트 제거), `hoga/api/app.py`(WS 라우터 와이어링), 신규 `hoga/api/ws.py`(또는 기존 모듈 내), `pyproject.toml`(선택: `sse-starlette` 제거), 신규 백엔드 테스트.

**프론트**: 신규 `frontend/src/api/ws.ts`, 개편 `sse.ts`·`liveSeries.ts`, 스텁 교체 6개 테스트 파일. 호출처 3곳(App/useCaptureQueue/useInventoryRecaptureOrigins)은 무변경.

## 9. 마이그레이션

단일 사용자 로컬 툴이고 외부 클라이언트가 없으므로 **하드 컷**(SSE 동시 운영 없이 한 번에 교체). 점진 전환의 복잡성을 들이지 않는다.

## 10. 리스크 / 검증 항목

- dev 교차 출처 WS 핸드셰이크(`:5173`→`:8000`) — 구현 초기 1회 확인.
- WS 재연결/백오프의 폭주 방지(상한·jitter).
- 재연결 시 누락 구간 — 활성 code 재구독 + 필요 시 `get_series` 재하이드레이트로 보강.
- `ws.ts`의 per-code refcount 정확성(중복 subscribe/조기 unsubscribe 방지).

## 11. 기존 결정과의 정합성 (grill 검증)

CONTEXT.md·ADR과 대조한 결과(2026-05-30 grill):

- **ADR-0044 (hover spot은 parquet, LiveBuffer 아님)** — 정합·보강. 굶던 호버 10호가는
  `/api/orderbook`(parquet REST spot) 경로이며 WS/LiveBuffer에 의존하지 않는다. WS
  마이그레이션은 **live tick stream 전송만** 바꾸므로 ADR-0044의 invariant
  (`useLiveOrderbookAtCursor` 등이 LiveBuffer/SSE를 import하면 위반)는 그대로 유지된다.
  호버가 안 되던 원인은 *경로가 SSE라서가 아니라 그 fetch가 풀 슬롯을 못 얻어서*였다.
- **ADR-0039 ("SSE buffer" 용어)** — `sources_available` 판정이 부르는 "SSE buffer"는
  실제로는 `LiveBuffer`(in-memory ring)이고 본 작업으로 바뀌지 않는다(전송만 WS).
  "SSE buffer"는 레거시 별칭이 되며 새 코드/문서는 `LiveBuffer`로 칭한다.
- **ADR-0036 (로컬 단일 사용자 배포)** — HTTP/2 대안 기각의 근거(프로덕션/TLS/프록시
  경로 없음). 멀티유저 전환 시 본 결정도 함께 재검토(ADR-0036 트리거와 동조).
- **용어 구분** — WS 프로토콜의 `subscribe`/`unsubscribe`는 **전송 계층 액션**으로,
  CONTEXT.md가 "subscription"이라 부르길 피하는 도메인 **Watchlist**와 무관하다.
- **CONTEXT.md 신규 용어 없음** — 전송 방식(SSE↔WS)은 구현 세부이지 도메인 전문가의
  언어가 아니므로 CONTEXT.md에 항목을 추가하지 않는다.

## 12. 미해결/이월 메모 (grill·plan 입력)

- 파일 개명 여부: `sse.ts` 유지 vs `eventStream.ts`.
- 재연결 시 live 버퍼 재하이드레이트를 자동화할지(초기엔 수동/REST로 충분).
- `sse-starlette` 의존성 제거를 이번 작업에 포함할지(정리 범위).
