# E2E specs — 상태와 실행 방법

## 지금 상태 (2026-07-31)

**게이트다.** `.github/workflows/ci.yml` 의 `e2e` 잡이 `continue-on-error` 없이
머지를 막는다. **19 passed / 0 skipped / 0 failed**, 잡 소요 ~1.5분.

**로컬에서도 돈다.** `playwright.config.ts` 가 CI 밖에서는 시스템 Chrome
(`channel: 'chrome'`)을 쓴다 — Ubuntu 26.04 는 Playwright 가 번들 chromium 설치를
거부하기 때문이다. 이전 판 주석은 "CI 가 유일한 판정 경로" 라고 적었지만, 스펙 11개 중
7개는 **이미** 시스템 Chrome 을 쓰고 있었다.

반복 실행 전에는 e2e 전용 서버·데이터를 반드시 초기화한다 — 포트 8765·5174 를 kill 하고
**실제로 비워질 때까지 기다린 뒤** `rm -rf /tmp/hoga-e2e-data`. 안 그러면 이전 실행의
캡처 큐 행이 남아 개수 단언이 엉킨다. **사용자 개발 서버(5173·8000)는 건드리지 말 것.**

`workers: 1` 은 필수다 — 캡처 큐 · 페이크 실패 카운터 · 디스크 픽스처가 모두 백엔드
전역이라 병렬이면 서로의 상태를 센다.

그전까지 이 스펙들은 **한 번도 실행된 적이 없었다.** CI 는 타입체크만 했고, 타입은
`page.goto('/replay')` 가 죽은 경로인지 알 수 없다. 그래서 파일 20개가 커밋돼 있고
타입도 통과하니 커버리지가 있어 보였지만 실제로 도는 것은 0건이었다.

이 문서의 이전 판은 `replay-smoke` 와 `multi-tab` 이 "now live" 라고 적고 있었다.
그 문장은 `/replay` 삭제(2026-05-29) 이전에 쓰였고 갱신되지 않았다.

## 2026-07-30 에 삭제한 스펙 8개

`/replay` 는 **2026-05-29 에 제거**됐다(`2b478c9d` "remove replay route + nav",
`1f6643f6` "delete replay page, ChartStage, VolumeProfileOverlay, useCursor").
기능은 `/live` 와 `/study` 로 이주했고 CONTEXT.md 가 그 이주를 완료로 기록한다.
그런데 스펙 8개가 그 뒤로도 삭제된 화면을 검사하고 있었다:

| 스펙 | 왜 죽었나 |
|---|---|
| `replay-smoke` · `replay-zoom` · `replay-indicators` | `/replay` 페이지 자체가 없다 |
| `multi-tab` · `push-refresh` · `error-states` | 〃 (멀티탭 모델도 함께 제거됨) |
| `inventory-tree` | `toHaveURL(/\/replay/)` 를 단언. 같은 커밋이 "drop inventory row click" |
| `drawing` | 그리기 **기능은 `/live` 에 살아 있지만** 스펙이 쓰는 `data-drawing-tool` · `data-drawing-menu` 선택자가 프로덕션 코드에 **0곳**이고, `data-pane` 을 달던 `ChartStage` 도 삭제됐다 |

`drawing` 은 경로만 `/live` 로 바꿔서는 살릴 수 없다 — 선택자를 새로 심어야 하는
별건 작업이다. 그리기 회귀 커버리지가 필요하면 그 작업을 먼저 하라.

## (사료) 남은 11개의 원인은 **셀렉터 드리프트**였다 — 2026-07-31 전부 해소

아래는 진단 당시의 기록이다. 표의 수치는 그때의 것이고, 해당 스펙들은 이후
#972 · #973 에서 현재 UI 에 맞춰 고쳐졌다.

처음에는 "픽스처 전제가 안 맞는다" 로 봤다. **틀렸다.** 모킹 URL 을 고쳐도
20 failed / 0 passed 가 그대로였고, 실제 원인은 **스펙이 기대하는 UI 문자열이
프로덕션 코드에서 사라진 것**이다. `live-smoke` 는 첫 단언에서 죽는다 —
모킹이 관여하기도 전이다:

```
Locator: getByText('관심종목을 선택해주세요')   ← 프로덕션 코드에 0곳
```

전수 조사(2026-07-30, 스펙의 `getByText('…')` · `name: '…'` 를 `src/` 와 대조):

| 스펙 | 문자열 셀렉터 | 사라진 것 |
|---|---:|---:|
| `watchlist-collapse-layout` | 4 | **4** |
| `watchlist-edit-reorder` | 5 | **3** |
| `live-smoke` | 5 | **2** |
| `screener-panel-layout` | 2 | **1** |
| `watchlist-panel-drag` | 4 | 1 |
| `watchlist-group-menu` | 11 | 1 |
| `watchlist-context-menu` | 3 | 0 |

`/replay` 8개와 **같은 계열**이다. 정도가 덜할 뿐, UI 가 진화하는 동안 스펙이
따라가지 않았고 실행된 적이 없으니 아무도 몰랐다.

**이 작업에서 남길 교훈**(#971~#974):

1. **개수를 못 박지 말고 상태를 기다려라.** 워커 동시성은 코어 수가 정한다 — 로컬
   32코어에서 4건이던 것이 CI 에서는 2건이었다. 로컬 재현법: `HOGA_MAX_CONCURRENT=1`.
2. **모킹 패턴은 호스트 루트에 앵커하라.** `**/api/…` 는 vite 가 서빙하는 앱 자기 소스
   `/src/api/…` 까지 가로채 페이지를 통째로 빈 화면으로 만든다(`helpers/apiRoutes.ts`).
3. **날짜를 박지 마라.** 달력은 언제나 현재 달을 연다. 날짜는 UI 가 쓰는 그 API
   (`/api/inventory/calendar`)에서 런타임에 고른다(`helpers/calendar.ts`).
4. **스펙이 틀렸을 가능성을 먼저 의심하라.** 이번에 고친 11건 중 2건은 **제거된 기능**을
   지키고 있었고(결함 배너 `d5c2adc1` · Esc 패널 닫기 `#534`), 1건은 애초에 성립하지
   않는 전제였다(`force_retry` 가 뒤집을 스킵이 없었다).
5. 그래도 **진짜 버그도 나온다.** `cookie-pause` 를 살리다 "Refresh & Resume" 이 실제로는
   재개하지 못하는 제품 버그를 찾았다(취소된 `cancel_token` 승계, #974).

남은 공백: `/live` 틱 채널은 아직 모킹할 수 없다(`helpers/liveMocks.ts` 의
`TODO(ws-migration)` — `page.routeWebSocket` 으로 복구 가능).
