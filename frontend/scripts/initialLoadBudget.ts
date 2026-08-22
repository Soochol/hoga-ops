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
 * ③ 이 답이다 — 조용한 빌드가 6주를 갔다. 경고는 읽히지 않는다.
 *
 * **단, 그 답은 청크 소속 가드의 것이다**(2026-08-23). 초기 로드 쪽은 절대 상한으로
 * 두었더니 6일 만에 12번 「올려서 통과시킴」이 됐고 코드를 줄인 사례는 0건이었다 —
 * 상시-red 는 CLAUDE.md 가 금하는 상태다. 그래서 초기 로드는 **점프 감지**로 바꿨다
 * (사유·수치는 규칙 파일 `INITIAL_LOAD_BUDGET` 머리말). 소속 가드는 그대로 실패다:
 * 그쪽은 위반이 곧 설정 사망이라 「의도된 위반」이 없다.
 */
import { gzipSync } from 'node:zlib';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Plugin } from 'vite';
import {
  ATTRIBUTION_RULES,
  INITIAL_LOAD_BUDGET,
  checkAttribution,
  initialLoadJumpProblem,
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
        // **절대 상한이 아니라 점프**를 잰다(2026-08-23 전환 — 사유는 규칙 파일
        // `INITIAL_LOAD_BUDGET` 머리말). 기준선 대비 증분은 아래 summary 가 늘 찍으므로
        // 조용한 누적은 여전히 눈에 보이고, 실패는 한 변경이 크게 뛸 때만이다.
        const jumpProblem = initialLoadJumpProblem(report.rawTotal);
        if (jumpProblem !== null) problems.push(jumpProblem);
        // gzip 은 **실패시키지 않는다** — 이 앱은 무압축 서빙이라 실사용 부담이 아니다
        // (사유는 규칙 파일의 `gzipBytes` 자리 주석). 수치는 아래 summary 로 계속 낸다:
        // raw 와 갈리는 방향이 「반복 문자열인가 새 내용인가」를 말해 준다.

        // 기준선 대비 증분을 **매 빌드 찍는다** — 게이트가 누적을 막지 않으므로,
        // 누적을 보이게 하는 일은 전적으로 이 한 줄이 맡는다.
        const delta = report.rawTotal - INITIAL_LOAD_BUDGET.rawBytes;
        const deltaText = delta === 0
          ? '기준선과 같음'
          : `기준선 대비 ${delta > 0 ? '+' : '-'}${kb(Math.abs(delta))}`;
        const summary = `초기 로드 raw ${kb(report.rawTotal)} / gzip ${kb(report.gzipTotal)} `
          + `(${report.entries.length}개 자산, CSS 포함 · ${deltaText})`;
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
          + `점프가 잡혔으면 **먼저 무엇이 늘었는지 본다** — 이 상한은 정상 기능 추가의 `
          + `3배 이상이라, 대개 무거운 의존이 실수로 초기 청크에 끌려온 경우다. `
          + `정말로 필요한 변경이면 scripts/initialLoadBudgetRules.ts 의 `
          + `INITIAL_LOAD_BUDGET.rawBytes 를 **새 실측값으로** 적고 한 줄 남긴다. `
          + `소속 위반은 vite.config.ts 의 codeSplitting.groups 를 보라 — `
          + `그 규칙은 과거에 한 번 조용히 죽은 적이 있다.`,
        );
      },
    },
  };
}
