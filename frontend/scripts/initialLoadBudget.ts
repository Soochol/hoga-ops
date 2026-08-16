/**
 * 초기 로드 예산 + 청크 소속 가드 — `vite build` 안에서 강제한다.
 *
 * 순수 규칙(파싱·판정·상수)은 `initialLoadBudgetRules.ts` 에 있다. **이 파일에만 Node
 * 내장 import 를 둔다** — 이유는 그 파일 머리말 참조(테스트 프로젝트 타입 오염).
 *
 * ## 왜 빌드 안인가
 *
 * 이 리포엔 CI 가 없다(CLAUDE.md 「로컬 검증」). 그래서 "따로 돌리는 검사" 는 결국
 * 안 돌아간다. 반면 `npx vite build` 는 **머지 게이트 명령에 이미 들어 있으므로**,
 * 여기 붙이면 건너뛸 수 없다. 별도 vitest 로 두면 `dist/` 가 없는 신선한 체크아웃에서
 * 실패하거나 스킵되는데, **스킵되는 가드는 없는 가드다**.
 *
 * ## 무엇을 잡나 — 이 파일이 존재하는 이유는 실제 사고 셋이다
 *
 * ① **초기 로드가 조용히 늘었다.** `vite.config.ts` 주석이 2026-07-30 실측
 *    「1071 KB」를 기준선으로 적어 뒀는데, 2026-08-16 감사가 재니 1230 KB 였다.
 *    아무도 몰랐다 — `chunkSizeWarningLimit` 은 **개별 청크만** 보고 합계는 아무도
 *    안 봤기 때문이다.
 *
 * ② **그 「1071 → 1230」 자체가 지표 혼용이었다.** 1071 은 **JS 전용**, 1230 은
 *    JS+CSS 였다(`@font-face` self-host 이후 CSS 가 47 KB → 96 KB 로 커진 것이 절반).
 *    like-for-like 는 +111 KB 다. **그래서 측정 대상을 코드로 고정한다** — 주석에 적힌
 *    숫자는 다음 사람이 같은 방식으로 잴 수 있어야 의미가 있다.
 *
 * ③ **청크 이름이 내용과 달랐다.** `manualChunks` 가 Vite 8(rolldown)에서 무효라
 *    `react-*.js` 가 184 B 인 채 `dnd-*.js` 안에 react-dom 129 KB 가 들어 있었다.
 *    빌드는 **아무 경고도 내지 않았다.** 감사가 파일명을 믿고 "@dnd-kit 186 KB" 라고
 *    4배 오독했다.
 *
 * ## 왜 경고가 아니라 실패인가
 *
 * ③ 이 답이다 — 조용한 빌드가 6주를 갔다. 경고는 읽히지 않는다. 예산을 올리는 것은
 * 규칙 파일의 상수 한 줄을 고치는 일이고, **그 한 줄이 커밋에 남는 것**이 이 장치의 요점이다.
 */
import { gzipSync } from 'node:zlib';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Plugin } from 'vite';
import {
  ATTRIBUTION_RULES,
  INITIAL_LOAD_BUDGET,
  checkAttribution,
  parseInitialLoadAssets,
} from './initialLoadBudgetRules';

export interface InitialLoadEntry {
  file: string;
  raw: number;
  gzip: number;
}

export interface InitialLoadReport {
  entries: InitialLoadEntry[];
  rawTotal: number;
  gzipTotal: number;
}

export function collectInitialLoad(distDir: string): InitialLoadReport {
  const html = readFileSync(join(distDir, 'index.html'), 'utf8');
  const entries = parseInitialLoadAssets(html).map((file) => {
    const abs = join(distDir, file);
    return {
      file,
      raw: statSync(abs).size,
      gzip: gzipSync(readFileSync(abs)).length,
    };
  });
  return {
    entries,
    rawTotal: entries.reduce((n, e) => n + e.raw, 0),
    gzipTotal: entries.reduce((n, e) => n + e.gzip, 0),
  };
}

function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

/**
 * `vite build` 에 붙는 게이트. 위반이면 **빌드를 실패시킨다**(위 「왜 실패인가」).
 */
export function initialLoadBudget(): Plugin {
  // 실제 `outDir` 을 설정에서 받는다 — `join(cwd, 'dist')` 하드코딩은 **가드가 공허하게
  // 통과하는** 경로를 만든다: outDir 이 바뀌면 남아 있던 옛 `dist/` 를 검사하고도
  // 초록이 된다. 지금은 e2e(`playwright.config.ts` 의 `npx vite build && prepare-dist`)도
  // 기본 dist 로 빌드해 복사하므로 결과가 같지만, 그 사실에 기대지 않는다.
  let outDir = 'dist';
  let root = process.cwd();
  return {
    name: 'hoga-initial-load-budget',
    apply: 'build',
    configResolved(config) {
      outDir = config.build.outDir;
      root = config.root;
    },
    // `closeBundle` 은 산출물이 디스크에 다 쓰인 뒤 돈다 — dist 를 직접 읽을 수 있다.
    closeBundle: {
      order: 'post',
      handler() {
        const distDir = join(root, outDir);
        const report = collectInitialLoad(distDir);
        const jsFiles = report.entries
          .filter((e) => e.file.endsWith('.js'))
          .map((e) => ({ file: e.file, text: readFileSync(join(distDir, e.file), 'utf8') }));
        const problems = checkAttribution(jsFiles, ATTRIBUTION_RULES);

        if (report.entries.length === 0) {
          // 파서가 아무것도 못 찾으면 합계가 0 이라 예산을 **늘 통과한다** — 가드가
          // 통과로 위장하는 유일한 경로라 따로 막는다.
          problems.push('index.html 에서 초기 로드 자산을 하나도 못 찾았다 — 파서 결함 의심');
        }
        if (report.rawTotal > INITIAL_LOAD_BUDGET.rawBytes) {
          problems.push(
            `초기 로드 raw ${kb(report.rawTotal)} > 예산 ${kb(INITIAL_LOAD_BUDGET.rawBytes)}`,
          );
        }
        if (report.gzipTotal > INITIAL_LOAD_BUDGET.gzipBytes) {
          problems.push(
            `초기 로드 gzip ${kb(report.gzipTotal)} > 예산 ${kb(INITIAL_LOAD_BUDGET.gzipBytes)}`,
          );
        }

        const summary = `초기 로드 raw ${kb(report.rawTotal)} / gzip ${kb(report.gzipTotal)} `
          + `(${report.entries.length}개 자산, CSS 포함)`;
        if (problems.length === 0) {
          this.info?.(summary);
          return;
        }
        const detail = report.entries
          .slice()
          .sort((a, b) => b.raw - a.raw)
          .map((e) => `  ${kb(e.raw).padStart(10)}  ${kb(e.gzip).padStart(9)}  ${e.file}`)
          .join('\n');
        this.error(
          `초기 로드 가드 실패\n\n`
          + problems.map((p) => `  ✗ ${p}`).join('\n')
          + `\n\n${summary}\n${detail}\n\n`
          + `예산 초과가 **의도된** 것이면 scripts/initialLoadBudgetRules.ts 의 `
          + `INITIAL_LOAD_BUDGET 을 올리고 **이유를 한 줄 적는다**. `
          + `소속 위반은 vite.config.ts 의 codeSplitting.groups 를 보라 — `
          + `그 규칙은 과거에 한 번 조용히 죽은 적이 있다.`,
        );
      },
    },
  };
}
