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
const API = process.env.E2E_API_URL ?? 'http://127.0.0.1:8765';

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

export default async function globalSetup(): Promise<void> {
  // webServer 가 /health 를 기다리고 나서 부르므로 서버는 이미 떠 있다.
  // 그래도 재시도를 둔다 — 준비 신호와 라우터 마운트 사이에 틈이 있을 수 있다.
  let lastErr: unknown;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      for (const [code, date] of SEED) await seedOne(code, date);
      return;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw lastErr;
}
