/**
 * vite dist → e2e 서빙 사본 준비 (dist-smoke 전제, ADR-0134 §4).
 *
 * dist/config.json 은 localhost:8000(사용자 dev 백엔드)을 가리키므로 원본을
 * 그대로 서빙하면 스모크가 **사용자 서버** 에 붙어 "로컬에선 그럭저럭 통과" 형
 * 오염이 된다(vite.config 의 e2e config.json 미들웨어와 같은 문제의식 — 그
 * 미들웨어는 apply:'serve' 라 빌드 산출물에는 못 쓴다). 사본에 same-origin
 * (`{"api_url": ""}`)을 write 해 8765 백엔드 자신을 보게 한다. 원본 dist 는
 * 건드리지 않는다.
 *
 * playwright.config.ts 의 백엔드 webServer command 가 `vite build` 직후에
 * 부른다 — globalSetup 은 webServer 이후에 돌므로 거기 두면 늦다(서버가
 * HOGA_FRONTEND_DIST 를 기동 시점에 검사한다 — 없으면 시끄럽게 죽는 계약).
 */
import { cpSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const frontendRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dist = join(frontendRoot, 'dist');
const out = process.env.E2E_DIST_DIR ?? '/tmp/hoga-e2e-dist';

if (!existsSync(join(dist, 'index.html'))) {
  console.error(`prepare-dist: ${dist}/index.html 이 없다 — vite build 가 선행돼야 한다.`);
  process.exit(1);
}
rmSync(out, { recursive: true, force: true });
cpSync(dist, out, { recursive: true });
writeFileSync(join(out, 'config.json'), '{ "api_url": "" }\n');
console.log(`prepare-dist: ${out} ready (same-origin config.json)`);
