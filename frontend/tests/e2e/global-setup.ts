/// <reference types="node" />
/**
 * Playwright globalSetup — seeds the e2e backend with fixture Stock-Dates.
 *
 * tests/e2e/README.md 의 "Remaining gating #1" 이 이것이다. 이게 없으면 스펙들이
 * 종목을 하나도 못 고르고, 실패가 "회귀" 가 아니라 "데이터 없음" 으로 난다 —
 * 그 구분이 안 되면 CI 에 걸어도 신호가 아니라 소음이다.
 *
 * 서버가 직접 픽스처를 복사하고 파서까지 돌린다(`/api/test/add-stockdate`,
 * HOGA_ENABLE_TEST_ENDPOINTS=1 게이트). 그래서 여기서는 파일을 만지지 않는다 —
 * 경로 계산을 CI 와 로컬에서 두 벌로 유지하지 않기 위해서다.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { API_URL as API, DATA_DIR, WORKTREE_ROOT, describeWorktreeEnv } from './worktreeEnv';

/** 백엔드가 스스로 밝히는 신원. `hoga/api/test_routes.py` 의 `whoami` 와 손 미러다. */
interface WhoAmI {
  repo_root: string;
  data_dir: string;
  /** 기동 시점 체크아웃의 짧은 SHA. git 이 없으면 `"unknown"`. */
  commit: string;
  /** 앱 조립 시각 = 이 프로세스가 소스를 읽은 시점. */
  started_at_ms: number;
}

const HINT = '해당 포트 점유자를 /proc/<pid>/cmdline 으로 확인한 뒤 정리하라.';

/** 이 워크트리의 짧은 SHA. 백엔드도 `--short` 를 쓰므로 축약 길이가 같다.
 *  git 이 없거나 체크아웃이 아니면 null — 그때는 커밋 대조를 **건너뛴다**.
 *  식별 실패가 실행을 막을 이유는 없다(`_read_git_commit` 과 같은 규칙). */
function headCommit(): string | null {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'],
      { cwd: WORKTREE_ROOT, encoding: 'utf-8' }).trim() || null;
  } catch {
    return null;
  }
}

/** 기동이 소비하는 것들 — 파일이든 디렉터리든. 기준은 하나다: **이게 바뀌면 기동을
 *  다시 해야 지금 코드를 재는가.**
 *
 *  - `hoga` — 백엔드 코드. `hoga serve` 는 reload=False 라 한 번 읽은 것이 끝까지 간다.
 *  - `pyproject.toml` · `uv.lock` — 파이썬 **환경 정의**. 의존성을 바꾸고 서버를
 *    재사용하면 조용히 옛 환경으로 돈다(코드만 봐서는 안 보인다).
 *  - `tests/fixtures/tiny_tsv_multi` — `FakeHogaplayClient` 가 `lru_cache` 로 **본문을
 *    캐시**하고 `add-stockdate` 가 복사한다. 프로세스 안에 굳는 값이다.
 *  - `frontend/{src,public,index.html,vite.config.ts,package.json}` — dist 빌드 입력.
 *    서버가 재사용되면 `vite build && prepare-dist` 가 **아예 돌지 않아** dist-smoke 가
 *    옛 산출물을 검사한다.
 *
 *  **`package-lock.json` 은 뺀다** — `npm install` 이 버전 필드를 되돌려 유령 수정을
 *  만드는 파일이라(루트 CLAUDE.md), 넣으면 위양성이 상시로 생긴다. 의존성 변경은
 *  `package.json` 쪽이 잡는다. `.env` 도 뺀다 — 사용자가 자기 dev 서버 때문에 자주
 *  만지는데 e2e 는 자격증명을 비워 띄우므로 영향이 없다. */
const STARTUP_INPUTS = [
  'hoga',
  'pyproject.toml',
  'uv.lock',
  join('tests', 'fixtures', 'tiny_tsv_multi'),
  join('frontend', 'src'),
  join('frontend', 'public'),
  join('frontend', 'index.html'),
  join('frontend', 'vite.config.ts'),
  join('frontend', 'package.json'),
];

/** 위 입력들 중 **가장 최근에 바뀐 것**과 그 시각. 못 재면 null.
 *
 *  경로까지 돌려주는 이유: "서버가 오래됐다" 만으로는 무엇이 바뀌었는지 몰라 사용자가
 *  다시 뒤져야 한다. 특히 의존성·픽스처는 **코드를 안 만졌는데** 걸리는 경우라
 *  경로가 없으면 가드가 오작동처럼 읽힌다. */
function newestStartupInput(): { path: string; mtimeMs: number } | null {
  let newest: { path: string; mtimeMs: number } | null = null;
  const consider = (full: string): void => {
    const { mtimeMs } = statSync(full);
    if (newest === null || mtimeMs > newest.mtimeMs) newest = { path: full, mtimeMs };
  };
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === '__pycache__') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else consider(full);
    }
  };
  try {
    for (const rel of STARTUP_INPUTS) {
      const full = join(WORKTREE_ROOT, rel);
      if (statSync(full).isDirectory()) walk(full);
      else consider(full);
    }
  } catch {
    return null;  // 트리 모양이 예상과 다르다 — 판정 포기(새 flake 를 만들지 않는다)
  }
  return newest;
}

/** **지금 붙은 백엔드가 내 워크트리의, 지금 소스로 뜬 것인지 확인한다.**
 *
 *  포트는 워크트리 경로 해시로 파생되지만 슬롯은 512개뿐이라 충돌이 가능하고,
 *  `reuseExistingServer` 는 CI 밖에서 항상 true 라 충돌하면 **에러 대신 남의 서버에
 *  붙는다**. 그러면 스위트는 초록인데 잰 것은 남의 트리다 — 실측으로 겪은 실패
 *  모드다(2026-08-10: `Errno 98` 뒤에 조용히 다른 워크트리 백엔드로 통과).
 *
 *  **축이 셋인데 각자 다른 것을 잡는다. 앞의 것으로 뒤의 것을 대신할 수 없다:**
 *
 *  1. `repo_root`·`data_dir` — **다른 체크아웃**. `/health` 로는 안 된다: version·
 *     commit 은 워크트리끼리 같을 수 있다(같은 커밋에서 딴 브랜치가 흔하다).
 *  2. `commit` — **같은 워크트리인데 다른 커밋**. 브랜치를 갈아탄 뒤 옛 서버가
 *     고아로 남은 경우다. 1번은 경로가 같아서 통과시킨다.
 *  3. `started_at_ms` vs 기동 입력 mtime — **커밋 안 된 편집과 의존성·픽스처 변경**.
 *     2번이 원리적으로 못 잡는데, 개발 중에는 오히려 이쪽이 흔하다(고치고 바로 다시
 *     돌린다). 무엇을 입력으로 세는지는 `STARTUP_INPUTS` 참고.
 *
 *  2·3 은 git·파일시스템을 못 읽으면 **조용히 건너뛴다** — 판정 근거가 없을 때
 *  죽이는 것은 새 flake 를 만드는 짓이다. 1번만 무조건이다. */
async function assertBackendIsOurs(): Promise<void> {
  const res = await fetch(`${API}/api/test/whoami`);
  if (!res.ok) {
    throw new Error(
      `whoami ${res.status} — ${API} 가 e2e 백엔드가 아니거나 ` +
      `HOGA_ENABLE_TEST_ENDPOINTS=1 로 뜨지 않았다. (${describeWorktreeEnv()})`,
    );
  }
  const who = await res.json() as WhoAmI;

  if (who.repo_root !== WORKTREE_ROOT || who.data_dir !== DATA_DIR) {
    throw new Error(
      `${API} 에 뜬 백엔드가 **다른 체크아웃**의 것이다 — 이 실행은 내 코드를 재지 않는다.\n` +
      `  기대: repo_root=${WORKTREE_ROOT} data_dir=${DATA_DIR}\n` +
      `  실제: repo_root=${who.repo_root} data_dir=${who.data_dir}\n` +
      `포트 슬롯이 겹쳤거나(워크트리 경로 해시) 이전 실행의 서버가 남아 있다. ` +
      `${HINT} (${describeWorktreeEnv()})`,
    );
  }

  const head = headCommit();
  if (head !== null && who.commit !== 'unknown' && who.commit !== head) {
    throw new Error(
      `${API} 에 뜬 백엔드가 **다른 커밋**으로 떠 있다 — 경로는 같지만 코드가 다르다.\n` +
      `  기대: ${head}\n  실제: ${who.commit}\n` +
      `브랜치를 갈아타기 전에 뜬 서버가 고아로 남았다. ${HINT}`,
    );
  }

  const newest = newestStartupInput();
  if (newest !== null && newest.mtimeMs > who.started_at_ms) {
    throw new Error(
      `${API} 에 뜬 백엔드가 **기동 입력보다 오래됐다** — 재사용된 서버가 지금 것을 안 읽었다.\n` +
      `  서버 기동: ${new Date(who.started_at_ms).toISOString()}\n` +
      `  최신 입력: ${new Date(newest.mtimeMs).toISOString()}  ${newest.path}\n` +
      `\`hoga serve\` 는 reload=False 라 조용히 옛 코드로 계속 돈다. ` +
      `프론트도 마찬가지다 — 서버가 재사용되면 \`vite build\` 가 아예 돌지 않아 ` +
      `dist-smoke 가 옛 산출물을 검사한다. ${HINT}`,
    );
  }
}

/** README 의 W6.4 가 요구하는 다종목 시드. multi-tab 스펙이 두 종목을 전제한다. */
const SEED: ReadonlyArray<readonly [code: string, date: string]> = [
  ['005930', '20260521'],
  ['000660', '20260521'],
];

async function seedOne(code: string, date: string): Promise<void> {
  const url = `${API}/api/test/add-stockdate?code=${code}&date=${date}`;
  const res = await fetch(url, { method: 'POST' });
  if (!res.ok) {
    // 503 = 픽스처 미탑재(휠 설치본), 404 = 해당 종목 픽스처 없음.
    // 어느 쪽이든 "테스트가 실패" 가 아니라 "환경이 안 갖춰짐" 이므로 즉시 죽인다.
    throw new Error(
      `seed ${code}/${date} failed: ${res.status} ${await res.text()}\n` +
      `백엔드가 HOGA_ENABLE_TEST_ENDPOINTS=1 로 떴는지 확인하라.`,
    );
  }
}

/** 거래일 캐시를 평일로 선주입 — 범위 캡처 enqueue 의 전제.
 *
 *  `trading_days_in_range` 는 KIS 거래일 목록을 요구하고 **폴백이 없다**. CI 에는
 *  자격증명이 없어 enqueue 가 503(`KIS_CREDENTIALS_MISSING`)으로 즉시 실패했고,
 *  자격증명이 있는 로컬은 토큰 발급 쿨다운(분당 1회)에 걸려 201/503 을 오갔다.
 *  스펙이 쓰는 달(전월·현재월)만 심는다. 자세한 근거는 `/api/test/seed-trading-days`. */
async function seedTradingDays(): Promise<void> {
  const now = new Date();
  const months = [
    [now.getFullYear(), now.getMonth() + 1],
    [new Date(now.getFullYear(), now.getMonth() - 1, 1).getFullYear(),
     new Date(now.getFullYear(), now.getMonth() - 1, 1).getMonth() + 1],
  ];
  for (const [year, month] of months) {
    const res = await fetch(`${API}/api/test/seed-trading-days?year=${year}&month=${month}`,
      { method: 'POST' });
    if (!res.ok) throw new Error(`seed-trading-days ${year}-${month}: ${res.status} ${await res.text()}`);
  }
}

export default async function globalSetup(): Promise<void> {
  // webServer 가 /health 를 기다리고 나서 부르므로 서버는 이미 떠 있다.
  // 그래도 재시도를 둔다 — 준비 신호와 라우터 마운트 사이에 틈이 있을 수 있다.
  // **시드보다 먼저** 확인한다 — 남의 백엔드에 시드를 심고 나서 알아채면 이미 남의
  // 데이터 디렉터리를 오염시킨 뒤다. 재시도 루프 밖에 두는 것도 의도다: 이건
  // "아직 준비 안 됨" 이 아니라 "잘못된 서버" 라 기다린다고 달라지지 않는다.
  await assertBackendIsOurs();

  let lastErr: unknown;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      for (const [code, date] of SEED) await seedOne(code, date);
      await seedTradingDays();
      return;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw lastErr;
}
