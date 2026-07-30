# E2E specs — 상태와 실행 방법

## 지금 상태 (2026-07-30)

**CI 에서 실제로 실행된다** — `.github/workflows/ci.yml` 의 `e2e` 잡. 단 아직
`continue-on-error: true` 라 머지를 막지 않는다. 통과 집합이 확정되면 승격한다.

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

## 남은 11개는 아직 통과하지 않는다

라우트는 살아 있지만(`/live` · `/capture`) **픽스처 전제가 맞지 않는다.**
`global-setup.ts` 는 005930 · 000660 의 20260521 만 심는데, 예를 들어
`live-smoke` 는 종목 `098460` 을, `calendar-markers` 는 `20260501` · `20260502`
셀을 기대한다. 스펙마다 다른 픽스처를 전제하는데 그 계약이 어디에도 없다.

**이걸 이어받는 사람에게**: 스펙을 하나씩 붙잡고 "이 스펙이 필요로 하는 Stock-Date
가 무엇인가" 를 `global-setup.ts` 의 `SEED` 로 옮기는 것이 작업이다.
`/api/test/add-stockdate` 가 픽스처 복사와 파싱을 서버 쪽에서 다 해주므로
globalSetup 은 호출만 하면 된다. 픽스처 자체는 `tests/fixtures/tiny_tsv_multi/` 에
005930 · 000660 두 종목뿐이므로, 다른 종목이 필요하면 픽스처부터 늘려야 한다.

## 배선 (2026-07-30 해소)

세 가지가 실행 자체를 막고 있었다:

1. **globalSetup 부재** — 픽스처가 안 심겨 스펙이 종목을 못 골랐다.
   `tests/e2e/global-setup.ts` 가 `/api/test/add-stockdate` 를 호출한다
   (`HOGA_ENABLE_TEST_ENDPOINTS=1` 게이트).
2. **포트 불일치** — `public/config.json` 은 8000(사람이 쓰는 개발 서버)을
   가리키는데 playwright 는 백엔드를 8765 로 띄운다. `vite.config.ts` 의
   `e2eConfigJson` 플러그인이 `E2E_API_URL` 이 있을 때만 `/config.json` 을
   가로챈다 — 정적 파일은 건드리지 않는다.
3. **프론트가 5173 점유** — 5173 은 사람 자리다. 5174 로 옮겼다(ALLOWED_ORIGINS
   에 이미 있어 CORS 통과). `--strictPort` 로 조용히 다른 포트로 밀려나는 것도
   막았다. `--host 127.0.0.1` 도 필수다 — 기본 `localhost` 는 CI 에서 IPv6 에만
   바인딩될 수 있고, 그러면 url 폴링이 영원히 실패한다.

## 실행

```bash
cd frontend
npx playwright install --with-deps chromium
npx playwright test
```

webServer 두 개(백엔드 8765, vite 5174)는 playwright 가 직접 띄운다. 사람이 쓰는
5173 · 8000 은 건드리지 않는다.

**주의 — Ubuntu 26.04 에서는 브라우저를 받을 수 없다**
(`ERROR: Playwright does not support chromium on ubuntu26.04-x64`). 그 환경에서
`npx playwright install` 을 돌리면 **다른 도구가 쓰는 브라우저를 "unused" 로 지운다**
— 2026-07-30 에 `/browse`(gstack, playwright-core 1.58.2 / chromium-1208)가 그렇게
깨졌다. 복구는 그 도구 자신의 playwright 로:

```bash
cd ~/.claude/skills/gstack
PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu24.04-x64 \
  node node_modules/playwright-core/cli.js install chromium chromium-headless-shell
```

지원되지 않는 환경에서는 **CI 결과를 유일한 검증 경로로 쓰는 것이 맞다.**
