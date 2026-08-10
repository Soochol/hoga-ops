/// <reference types="node" />
/**
 * e2e 실행 자원을 **워크트리마다 다르게** 파생시킨다 — 포트 2개, 데이터 디렉터리,
 * dist 디렉터리.
 *
 * ## 왜
 *
 * 이전에는 백엔드 8765 · vite 5174 · `/tmp/hoga-e2e-data` · `/tmp/hoga-e2e-dist` 가
 * **전부 상수**였다. 그런데 `playwright.config.ts` 의 `reuseExistingServer` 는
 * CI 밖에서 항상 true 라, 두 번째 세션의 Playwright 는 포트가 이미 물려 있으면
 * **에러 대신 그 서버에 붙었다**. 실측(2026-08-10):
 *
 * ```
 * [WebServer] ERROR: [Errno 98] ... bind on address ('127.0.0.1', 8765): address already in use
 *   ✓  1 [chromium] › tests/e2e/cookie-pause.spec.ts … (9.4s)
 * ```
 *
 * 저 초록은 **내 트리가 아니라 남의 트리를 잰 결과**였다(점유자를 `/proc/<pid>/cmdline`
 * 로 확인하니 다른 워크트리였다). 같은 이유로 캡처 큐 · `_fail_streaks` ·
 * `FakeHogaplayClient` 주입 싱글턴 · 디스크 픽스처가 전부 남과 공유됐고, 한쪽의
 * `cookie_expire_at {index:-1}` 이 다른 쪽 주입을 끄거나 `전체 취소` 가 남의 행을
 * 취소하는 일이 생겼다. `workers: 1` 은 **한 실행 안의** 병렬만 직렬화하므로 이걸
 * 막지 못한다.
 *
 * ## 어떻게
 *
 * 워크트리 루트 경로를 해시해 슬롯 하나를 고른다. 같은 워크트리는 언제나 같은 슬롯,
 * 다른 워크트리는 거의 항상 다른 슬롯이다.
 *
 * **슬롯이 512개인 이유**: 이 리포는 병행 세션이 6개까지 간다. 64개면 생일 충돌이
 * ~25% 라 실제로 부딪히고, 512개면 ~3% 다. 그리고 충돌해도 **조용히 틀리지 않는다** —
 * `global-setup.ts` 가 `/api/test/whoami` 로 "지금 붙은 백엔드가 내 워크트리 것인가" 를
 * 확인하고 아니면 즉시 죽는다. 즉 설계는 "낮은 확률 + 시끄러운 실패" 다.
 *
 * 포트 대역은 **ephemeral(32768~)을 피하고** 사람이 쓰는 자리(5173 · 8000)와 옛
 * e2e 자리(8765 · 5174)를 비켜 간다 — 옛 포트를 재사용하면 구 체계로 도는 병행
 * 세션과 다시 겹친다.
 *
 * 경로는 **realpath 로 접는다.** 심볼릭 링크로 같은 트리를 두 이름으로 부르면 슬롯이
 * 갈려 같은 트리가 두 벌 도는 것처럼 보인다.
 *
 * 모든 값은 환경변수로 **덮어쓸 수 있다**(CI · 수동 디버깅용). 덮어쓰면 파생은 건너뛴다.
 */
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** `<worktree>/frontend/tests/e2e` → `<worktree>`.
 *
 *  `process.cwd()` 가 아니라 **이 파일 위치**에서 올라간다 — 설정은 `frontend/` 에서,
 *  스펙 워커는 또 다른 cwd 에서 이 모듈을 읽으므로 cwd 기준이면 둘이 갈릴 수 있다. */
export const WORKTREE_ROOT = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'));

const SLOTS = 512;

/** 워크트리 경로 → [0, SLOTS) 슬롯. 순수 함수라 설정과 스펙이 같은 값을 얻는다. */
export const SLOT = parseInt(
  createHash('sha256').update(WORKTREE_ROOT).digest('hex').slice(0, 8), 16,
) % SLOTS;

const num = (envValue: string | undefined, derived: number): number =>
  envValue ? Number(envValue) : derived;

/** 백엔드(`hoga serve`) 포트. */
export const BACKEND_PORT = num(process.env.E2E_BACKEND_PORT, 20000 + SLOT);
/** vite dev server 포트. **5173 은 사람이 쓰는 자리라 절대 쓰지 않는다.** */
export const FRONTEND_PORT = num(process.env.E2E_FRONTEND_PORT, 21000 + SLOT);

export const API_URL = process.env.E2E_API_URL ?? `http://127.0.0.1:${BACKEND_PORT}`;
export const BASE_URL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${FRONTEND_PORT}`;

/** `HOGA_DATA_DIR` — 캡처 큐 매니페스트 · fail_streak · parquet 픽스처가 여기 산다. */
export const DATA_DIR = process.env.E2E_DATA_DIR ?? `/tmp/hoga-e2e-data-${SLOT}`;
/** `HOGA_FRONTEND_DIST` — dist-smoke 용 same-origin 산출물 사본.
 *
 *  **이것도 반드시 파생해야 한다.** 포트만 나누면 `vite build` + `prepare-dist` 가
 *  남의 실행 중에 같은 디렉터리를 덮어쓴다 — 포트 격리로는 안 잡히는 경로다. */
export const DIST_DIR = process.env.E2E_DIST_DIR ?? `/tmp/hoga-e2e-dist-${SLOT}`;

/** 사람이 읽을 한 줄 — 문서와 실패 메시지가 같은 문구를 쓰도록 여기 둔다. */
export function describeWorktreeEnv(): string {
  return [
    `worktree=${WORKTREE_ROOT}`,
    `slot=${SLOT}`,
    `backend=${BACKEND_PORT}`,
    `frontend=${FRONTEND_PORT}`,
    `data=${DATA_DIR}`,
    `dist=${DIST_DIR}`,
  ].join(' · ');
}
