/**
 * 영속 정책 선언의 **양방향 가드**.
 *
 * 막는 방향 둘:
 *   - **선언 → 소스**: 표에 적힌 키·모듈이 소스에서 사라지면 빨강(죽은 선언이 쌓이면
 *     표가 문서가 아니라 소설이 된다).
 *   - **소스 → 선언**: 크로스탭 구독이 늘거나 줄면 빨강. `hydrate*FromStorage` 를
 *     정의했는데 표에도 예외 목록에도 없으면 빨강.
 *
 * **못 보는 것**: 이름 규칙(`hydrate*FromStorage`)을 벗어난 새 하이드레이션. 이름
 * 매칭을 전수 발견으로 확장하지 않는 것은 의도적이다 — 오탐과 누락이 둘 다 조용하다.
 * 기본 관례(localStorage · 탭 로컬 런타임)를 쓰는 33개 키도 여기서 안 센다.
 *
 * **등록 의존**: 새 키가 기본과 다르면 `NON_DEFAULT_PERSISTENCE` 에 추가해야 하고,
 * 새 하이드레이터를 배선하지 않기로 했으면 `INTENTIONALLY_UNSYNCED` 에 **사유와
 * 함께** 넣어야 한다. 둘 다 안 하면 아래 가드가 빨개진다.
 */
import { describe, expect, it } from 'vitest';
import { INTENTIONALLY_UNSYNCED, NON_DEFAULT_PERSISTENCE } from './persistencePolicy';

// vite 의 `?raw` 로 소스 텍스트를 인라인한다 — routeSplitting.test.ts · themePrefs.test.ts
// 와 같은 방식(`node:fs` 는 이 프로젝트의 타입 범위 밖이다: tsconfig.test.json 이 node
// types 를 의도적으로 뺐다).
// 패턴을 `/src/…` 로 적는 것이 load-bearing 이다. 상대 패턴(`../**/*`)을 쓰면 vite 가
// 키를 **이 테스트 파일 기준 최단 경로**로 정규화해(`./livePage.ts`) 같은 파일이
// 위치에 따라 다른 이름을 갖는다. 루트 기준이면 이름이 하나로 고정된다.
const RAW = import.meta.glob('/src/**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/**
 * 선언 파일 자신 — **스캔에서 반드시 뺀다.**
 *
 * 넣으면 아래 "선언된 키가 소스에 실재한다" 가 자기 자신을 읽어 **항상 통과한다**
 * (표에 키 문자열이 적혀 있으니까). 키를 오타 내도, 소스에서 그 키를 지워도 초록이다.
 * 리스너 계수도 docstring 안의 예시 문자열을 함께 세어 실제로 한 번 틀렸다.
 */
const POLICY_FILE = 'state/persistencePolicy.ts';

/** `/src/state/liveVenue.ts` → `state/liveVenue.ts`. 테스트 파일과 선언 파일은 제외. */
const PROD_SOURCES: ReadonlyArray<readonly [string, string]> = Object.entries(RAW)
  .map(([path, text]) => [path.replace(/^\/src\//, ''), text] as const)
  .filter(([path]) => !/\.test\.tsx?$/.test(path) && path !== POLICY_FILE);

const ALL_TEXT = PROD_SOURCES.map(([, text]) => text).join('\n');

/**
 * 크로스탭 구독의 유일한 형태 — 6곳이 전부 같은 모양이다. `window.` 를 요구하는 것은
 * 산문 속 예시(`` `addEventListener('storage'` ``)를 호출로 오인하지 않기 위해서다.
 */
const STORAGE_LISTENER = /window\.addEventListener\(\s*['"]storage['"]/g;

/** 스토어 메서드 **구현체**만. 인터페이스 선언(`: () => void;`)은 `{` 가 없어 안 잡힌다. */
const HYDRATOR_IMPL = /^\s*(hydrate\w*FromStorage)\s*:\s*\(\)\s*=>\s*\{/gm;

function countMatches(re: RegExp, text: string): number {
  return [...text.matchAll(re)].length;
}

describe('persistencePolicy — 스캔 자체', () => {
  // 루프형 단언은 0건을 순회하며 조용히 초록이 된다. 스캐너가 아무것도 못 읽었을 때
  // 아래 가드들이 전부 통과하는 상태를 여기서 먼저 막는다.
  it('glob 이 실제로 프로덕션 소스를 읽는다', () => {
    expect(PROD_SOURCES.length).toBeGreaterThan(100);
    const paths = PROD_SOURCES.map(([p]) => p);
    expect(paths).toContain('state/liveVenue.ts');
    expect(paths).toContain('api/liveSettings.ts');
    expect(paths).not.toContain('state/liveVenue.test.ts');
    // 자기 자신을 읽으면 아래 "키가 소스에 실재한다" 가 공허하게 통과한다.
    expect(paths).not.toContain(POLICY_FILE);
  });

  it('두 정규식이 실제로 무언가를 잡는다', () => {
    expect(countMatches(STORAGE_LISTENER, ALL_TEXT)).toBeGreaterThan(0);
    expect(countMatches(HYDRATOR_IMPL, ALL_TEXT)).toBeGreaterThan(0);
  });

  it('표가 비어 있지 않다', () => {
    expect(NON_DEFAULT_PERSISTENCE.length).toBeGreaterThan(0);
    expect(INTENTIONALLY_UNSYNCED.length).toBeGreaterThan(0);
  });
});

describe('persistencePolicy — 선언 → 소스', () => {
  it.each(NON_DEFAULT_PERSISTENCE)('$key 가 소스에 실재한다', ({ key, module }) => {
    expect(ALL_TEXT).toContain(`'${key}'`);
    expect(PROD_SOURCES.map(([p]) => p)).toContain(module);
  });

  it.each(NON_DEFAULT_PERSISTENCE)('$key 는 이탈 사유를 적었다', ({ note }) => {
    expect(note.trim().length).toBeGreaterThan(10);
  });

  it.each(INTENTIONALLY_UNSYNCED)('$module 의 $method 는 배선하지 않는 사유를 적었다', ({ module, reason }) => {
    expect(PROD_SOURCES.map(([p]) => p)).toContain(module);
    expect(reason.trim().length).toBeGreaterThan(10);
  });
});

describe('persistencePolicy — 소스 → 선언', () => {
  /**
   * 크로스탭 구독 수는 grep 한 줄로 재는 사실이라 파서가 조용히 틀릴 여지가 작다.
   * 형태가 바뀌면 개수가 줄어 **빨강 쪽으로** 실패한다(초록 위장이 아니다).
   */
  it('storage 리스너 수 == 크로스탭을 선언한 키 수', () => {
    const crossTab = NON_DEFAULT_PERSISTENCE.filter(
      (d) => d.policy === 'shared-synced' || d.policy === 'signal',
    );
    expect(countMatches(STORAGE_LISTENER, ALL_TEXT)).toBe(crossTab.length);
  });

  /**
   * ⚠ 이 가드가 이번 작업을 낳았다. `live.investorEstimateUnit.v1` 은
   * `hydrateFromStorage` 가 **정의돼 있는데 아무도 부르지 않아** 조용히 깨져 있었다
   * — 저장은 공유인데 읽는 시점이 모듈 로드 한 번뿐이라, 먼저 띄워 둔 탭만 옛 단위로
   * 남았고 화면은 정상으로 보였다. 「기계는 정의됐는데 배선이 없다」를 요구로 승격한다.
   */
  it('hydrate*FromStorage 구현체는 전부 배선되거나 사유와 함께 예외로 선언된다', () => {
    const found = PROD_SOURCES.flatMap(([path, text]) =>
      [...text.matchAll(HYDRATOR_IMPL)].map((m) => `${path}#${m[1]}`),
    ).sort();

    const declared = [
      ...NON_DEFAULT_PERSISTENCE.flatMap((d) =>
        d.hydrator ? [`${d.hydrator.module}#${d.hydrator.method}`] : [],
      ),
      ...INTENTIONALLY_UNSYNCED.map((u) => `${u.module}#${u.method}`),
    ].sort();

    expect(found).toEqual(declared);
  });

  it('선언된 하이드레이터는 그 모듈에 실제로 있다', () => {
    for (const d of NON_DEFAULT_PERSISTENCE) {
      if (!d.hydrator) continue;
      const source = PROD_SOURCES.find(([p]) => p === d.hydrator?.module)?.[1];
      expect(source, `${d.hydrator.module} 가 없다`).toBeDefined();
      expect(source).toContain(`${d.hydrator.method}: () => {`);
    }
  });
});
