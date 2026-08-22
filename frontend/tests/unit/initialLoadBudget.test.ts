/**
 * 초기 로드 가드의 **순수 부분** 테스트.
 *
 * 가드 자체는 `vite build` 안에서 돈다(빌드가 머지 게이트에 이미 있으므로). 그런데
 * 그 안의 파서가 조용히 덜 읽으면 **가드가 통과로 위장한다** — 자산을 못 찾으면
 * 합계가 작아져서 예산을 늘 통과하고, 마커를 못 찾으면 "청크에 없다" 가 아니라
 * 검사 대상이 0개가 된다. 이 리포는 같은 실패를 이미 겪었다(wire enum 가드의 TS
 * union 파서가 덜 읽어 **드리프트로 위장**했다 — CLAUDE.md 「가드를 고칠 때」).
 *
 * 그래서 파서·판정 로직만 따로 값으로 못박는다. 빌드 산출물이 없어도 돈다.
 */
import { describe, it, expect } from 'vitest';
import {
  parseInitialLoadAssets,
  checkAttribution,
  chunkNameOf,
  INITIAL_LOAD_BUDGET,
  ATTRIBUTION_RULES,
} from '../../scripts/initialLoadBudgetRules';

describe('parseInitialLoadAssets', () => {
  it('entry script · modulepreload · stylesheet 를 모두 걷는다', () => {
    const html = `<!doctype html><html><head>
      <link rel="stylesheet" crossorigin href="/assets/index-AAA.css">
      <link rel="modulepreload" crossorigin href="/assets/react-BBB.js">
      <link rel="modulepreload" crossorigin href="/assets/charts-CCC.js">
      <script type="module" crossorigin src="/assets/index-DDD.js"></script>
    </head><body><div id="root"></div></body></html>`;
    expect(parseInitialLoadAssets(html)).toEqual([
      'assets/charts-CCC.js',
      'assets/index-AAA.css',
      'assets/index-DDD.js',
      'assets/react-BBB.js',
    ]);
  });

  it('CSS 를 **포함한다** — 지표 정의의 핵심', () => {
    // 「1071 KB」 기준선이 JS 전용이었고 나중 측정은 JS+CSS 였다. 그 혼용이 「+159 KB
    // 회귀」라는 없는 사고를 만들었다. 여기가 그 정의를 고정하는 자리다.
    const html = '<link rel="stylesheet" href="/assets/index-AAA.css">';
    expect(parseInitialLoadAssets(html)).toEqual(['assets/index-AAA.css']);
  });

  it('중복은 한 번만 센다', () => {
    const html = `<link rel="modulepreload" href="/assets/react-BBB.js">
                  <script type="module" src="/assets/react-BBB.js"></script>`;
    expect(parseInitialLoadAssets(html)).toEqual(['assets/react-BBB.js']);
  });

  it('/assets/ 밖의 참조는 세지 않는다 — 초기 로드 비용이 아니다', () => {
    const html = `<link rel="icon" href="/favicon.svg">
                  <script src="https://cdn.example.com/x.js"></script>
                  <link rel="modulepreload" href="/assets/react-BBB.js">`;
    expect(parseInitialLoadAssets(html)).toEqual(['assets/react-BBB.js']);
  });

  it('아무것도 못 찾으면 빈 배열 — 합계 0 이 "통과" 로 읽히면 안 되므로 호출부가 안다', () => {
    expect(parseInitialLoadAssets('<html></html>')).toEqual([]);
  });
});

describe('chunkNameOf', () => {
  it('해시만 떼고 이름을 남긴다', () => {
    expect(chunkNameOf('assets/react-CvBZlOBd.js')).toBe('react');
    expect(chunkNameOf('assets/live-workspace-Bktk0rGt.js')).toBe('live-workspace');
    // 자동 분할이 만드는 이름 — `react` 와 **다른 청크**로 판정돼야 한다.
    expect(chunkNameOf('assets/react-dom-BmJ_wqrz.js')).toBe('react-dom');
  });
});

describe('checkAttribution', () => {
  const rules = [{ marker: 'MARK_A', chunk: 'alpha', label: 'libA' }];

  it('기대한 청크에만 있으면 통과', () => {
    expect(checkAttribution(
      [{ file: 'assets/alpha-111.js', text: 'x MARK_A y' },
       { file: 'assets/beta-222.js', text: 'nothing' }],
      rules,
    )).toEqual([]);
  });

  it('기대 청크에 없으면 위반 — 규칙이 죽은 경우', () => {
    const v = checkAttribution(
      [{ file: 'assets/beta-222.js', text: 'MARK_A' }],
      rules,
    );
    expect(v.some((m) => m.includes('청크에 없다'))).toBe(true);
    expect(v.some((m) => m.includes('assets/beta-222.js'))).toBe(true);
  });

  it('마커 자체가 사라져도 위반 — 라이브러리 업그레이드가 가드를 조용히 죽이지 못한다', () => {
    const v = checkAttribution([{ file: 'assets/alpha-111.js', text: 'no marker' }], rules);
    expect(v).toHaveLength(1);
    expect(v[0]).toContain('마커가 사라졌거나');
  });

  it('다른 청크에도 있으면 위반 — 벤더가 앱 청크로 새는 경우', () => {
    const v = checkAttribution(
      [{ file: 'assets/alpha-111.js', text: 'MARK_A' },
       { file: 'assets/live-workspace-333.js', text: 'MARK_A' }],
      rules,
    );
    expect(v.some((m) => m.includes('밖에도 있다'))).toBe(true);
  });

  /**
   * 이 가드가 **크기가 아니라 소속**을 재는 이유의 회귀 방지.
   *
   * 실측(2026-08-17): 청킹 규칙을 죽인 상태의 초기 로드는 1219.1 KB 로 정상(1253.6 KB)
   * 보다 **34 KB 작았다**. 크기만 재는 가드였다면 망가진 상태를 개선으로 읽었을 것이다.
   * 실제로 잡은 것은 "react-dom 이 react 청크에 없다" 하나뿐이었다.
   */
  it('망가진 분할이 더 작을 수 있다 — 그래서 소속을 잰다', () => {
    const broken = [
      { file: 'assets/react-dom-999.js', text: 'MARK_A' },   // 자동 분할 산물
      { file: 'assets/alpha-111.js', text: 'empty shell' },  // 이름만 남은 껍데기
    ];
    expect(checkAttribution(broken, rules)).not.toEqual([]);
  });
});

describe('설정값 자체', () => {
  it('예산이 현재 실측보다 위이되 무의미하게 크지 않다', () => {
    // 2026-08-17 실측 raw 1253.6 KB. 헤드룸 ~3%.
    // gzip 은 게이트가 아니라 상한이 없다(규칙 파일의 `gzipBytes` 자리 주석 참조).
    //
    // ⚠ 예산을 **정당하게** 올리면 이 테스트도 실패한다 — 아래 실측값을 같이 갱신해야
    // 한다. **그 강제가 이 테스트의 목적이다**: 예산을 올릴 때 실제로 다시 재게 만든다.
    // 빌드 가드와 중복이라고 지우지 말 것 — 빌드 가드는 「현재값이 예산 아래인가」만
    // 보고, 이건 「예산이 실측 대비 합리적 폭인가」를 본다(다른 질문이다).
    // 위: 현재값을 통과시켜야 한다. 아래: 헤드룸이 10% 를 넘으면 가드가 아니라 장식이다.
    expect(INITIAL_LOAD_BUDGET.rawBytes).toBeGreaterThan(1_253.6 * 1024);
    expect(INITIAL_LOAD_BUDGET.rawBytes).toBeLessThan(1_253.6 * 1024 * 1.1);
  });

  it('소속 규칙이 비어 있지 않다 — 0건 순회는 항상 통과한다', () => {
    expect(ATTRIBUTION_RULES.length).toBeGreaterThan(0);
  });
});
