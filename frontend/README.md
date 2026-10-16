# hoga-ops Frontend

React + TypeScript + Vite client for the hoga-ops replay and live market-data workspace.

See `DESIGN.md` at the repo root for the design system and
`docs/superpowers/designs/2026-05-20-replay-viewer.html` for the approved visual reference.

## Prerequisites

- Node.js 20+ and npm
- Backend running (see "Backend" below) on port 8000 by default

## Setup

```bash
npm install
```

## Common commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Vite dev server with HMR on `http://localhost:5173` |
| `npm run build` | Type-check (`tsc -b`) + production bundle to `dist/` |
| `npm run preview` | Serve the built `dist/` locally |
| `npx vitest run` | Run unit + component tests (vitest, JSDOM) |
| `npx vitest` | Watch mode |
| `npx playwright test` | E2E specs (gated — see `tests/e2e/README.md`) |
| `npm run lint` | ESLint |

## Backend

The backend is a FastAPI app served by uvicorn. From the repo root:

```bash
uv run uvicorn hoga.api.app:default_app \
  --factory --host 127.0.0.1 --port 8000 \
  --reload --reload-dir hoga
```

This exposes the replay and `/live` APIs the frontend consumes.

## Runtime configuration

The frontend reads `/config.json` at startup to pick up the API base URL.
A default `public/config.json` ships with `{ "api_url": "http://localhost:8000" }`.
Override per-deployment by replacing the file in the served `dist/` directory —
no rebuild required.

## Project layout

```
frontend/
  src/
    components/      # presentational React components
    hooks/           # data hooks
    store/           # Zustand stores
    api/             # fetch + SSE clients
    tests/           # vitest unit + component tests
  tests/e2e/         # Playwright specs (gated)
  public/config.json # runtime API base URL
```

## Status

분봉 차트의 원하는 날짜 위에 마우스를 두고 `Shift+R`을 누르면 해당 날짜에서
고가가 가장 높은 캔들의 몸통 상단(`max(시가, 종가)`)에 수평선을 바로 그립니다.
현재 분봉 단위와 화면 밖을 포함한 로드된 날짜 데이터를 사용하며, 최고가가 같으면
가장 이른 캔들을 선택합니다. 데이터 로딩 중에는 실행하지 않고, 생성한 선은 이후
시세가 바뀌어도 고정됩니다. 기존 수평선처럼 이동·삭제·저장·실행 취소할 수 있습니다.

`/live` 차트의 **보조지표 → 카탈로그 → 슈퍼트렌드**에서 추세선을 추가할 수 있습니다.
기본값은 Wilder ATR 10봉·배수 3이며, 분봉·일봉·주봉·월봉을 지원합니다.
ATR 기간(1–400봉), 배수(0.1–10), 상승·하락 색상과 선 두께를 설정할 수 있습니다.
기준가는 고가·저가의 평균이고, 초기 ATR 계산 후 하락 추세로 시작합니다.
진행 중인 봉은 가격 변화에 따라 추세가 바뀔 수 있습니다. 설정 저장·레전드·숨김·삭제 취소는 다른 보조지표와 같습니다.

`/live` 차트의 **보조지표 → 카탈로그 → 볼린저 밴드**에서 상단·중심·하단선을 추가할 수 있습니다.
기본값은 종가 기준 20봉 단순이동평균 ± 표준편차 2배이며, 분봉·일봉·주봉·월봉을 지원합니다.
기간(2–400봉), 배수(0.1–10), 기준가, 선별 색상과 공통 두께를 설정할 수 있고,
설정은 창과 봉 종류별로 저장됩니다. 레전드는 커서가 가리키는 봉의 세 값을 표시하며 숨김·삭제·삭제 취소를 지원합니다.

The shell, routing, URL state, replay views, right rail, screeners, heatmap, and `/live`
chart workspace are wired. Live data features use backend REST/SSE endpoints and degrade
locally when optional KIS credentials or market data are unavailable.
