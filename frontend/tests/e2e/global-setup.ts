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
import { API_URL as API, DATA_DIR, WORKTREE_ROOT, describeWorktreeEnv } from './worktreeEnv';

/** **지금 붙은 백엔드가 내 워크트리 것인지 확인한다.**
 *
 *  포트는 워크트리 경로 해시로 파생되지만 슬롯은 512개뿐이라 충돌이 가능하고,
 *  `reuseExistingServer` 는 CI 밖에서 항상 true 라 충돌하면 **에러 대신 남의 서버에
 *  붙는다**. 그러면 스위트는 초록인데 잰 것은 남의 트리다 — 실측으로 겪은 실패
 *  모드다(2026-08-10: `Errno 98` 뒤에 조용히 다른 워크트리 백엔드로 통과).
 *
 *  파생은 확률을 낮출 뿐이고, 이 확인이 그걸 **시끄러운 실패**로 바꾼다. `/health`
 *  로는 안 된다 — version·commit 은 워크트리끼리 같을 수 있다(같은 커밋에서 딴
 *  브랜치가 흔하다). 판별에 필요한 것은 경로다. */
async function assertBackendIsOurs(): Promise<void> {
  const res = await fetch(`${API}/api/test/whoami`);
  if (!res.ok) {
    throw new Error(
      `whoami ${res.status} — ${API} 가 e2e 백엔드가 아니거나 ` +
      `HOGA_ENABLE_TEST_ENDPOINTS=1 로 뜨지 않았다. (${describeWorktreeEnv()})`,
    );
  }
  const { repo_root: repoRoot, data_dir: dataDir } =
    await res.json() as { repo_root: string; data_dir: string };
  if (repoRoot !== WORKTREE_ROOT || dataDir !== DATA_DIR) {
    throw new Error(
      `${API} 에 뜬 백엔드가 **다른 체크아웃**의 것이다 — 이 실행은 내 코드를 재지 않는다.\n` +
      `  기대: repo_root=${WORKTREE_ROOT} data_dir=${DATA_DIR}\n` +
      `  실제: repo_root=${repoRoot} data_dir=${dataDir}\n` +
      `포트 슬롯이 겹쳤거나(워크트리 경로 해시) 이전 실행의 서버가 남아 있다. ` +
      `해당 포트 점유자를 /proc/<pid>/cmdline 으로 확인한 뒤 정리하라. (${describeWorktreeEnv()})`,
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
