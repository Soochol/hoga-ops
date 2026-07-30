/**
 * 초기 번들 회귀 가드.
 *
 * `/live` 첫 페인트가 기다려야 하는 코드는 정적 import 그래프로 결정된다. 정적
 * import 하나가 되돌아오면 lazy 이득이 **전부** 사라지므로(vite 의 manualChunks 는
 * 파일만 쪼개고 페치 시점은 안 바꾼다) 소스 수준에서 못박는다.
 *
 * 실측 2026-07-30: 초기 로드 1303KB → 1071KB (dist/index.html 의 modulepreload 집합
 * 합계). 두 곳이 함께여야 성립한다 —
 *   - main.tsx: 비-`/live` 라우트
 *   - App.tsx: 드로어·설정 모달 (App 은 레이아웃 라우트라 항상 로드된다)
 */
import { describe, expect, it } from 'vitest';

// vite 의 `?raw` 로 소스 텍스트를 인라인한다 — `node:fs` 는 이 프로젝트의 타입
// 범위 밖이다(tsconfig.test.json 이 node types 를 의도적으로 뺐다: src 의
// setTimeout 반환형이 바뀌는 부작용). useLiveCursor.invariant.test.ts 와 같은 방식.
import APP from './App.tsx?raw';
import MAIN from './main.tsx?raw';

/** 정적 import 문만 추출 — `import(...)`(동적)과 구분한다. */
function staticImportSources(src: string): string[] {
  return [...src.matchAll(/^import\s[^;]*?from\s+'([^']+)'/gm)].map((m) => m[1]);
}

describe('초기 번들 코드 분할', () => {
  it('main.tsx 는 비-/live 라우트를 정적 import 하지 않는다', () => {
    const lazyOnly = [
      './studyViews/StudyPage',
      './pages/Heatmap',
      './pages/Inventory',
      './pages/Screener',
      './pages/Capture',
      './pages/Settings',
    ];
    const statics = staticImportSources(MAIN);
    expect(statics.filter((s) => lazyOnly.includes(s))).toEqual([]);
  });

  it('main.tsx 는 /live 를 정적 유지한다 — 기본 라우트에 왕복을 추가하지 않는다', () => {
    expect(staticImportSources(MAIN)).toContain('./live/LivePage');
  });

  it('App.tsx 는 드로어·설정 패널을 정적 import 하지 않는다', () => {
    // App 은 레이아웃 라우트라 항상 로드된다 — 여기서 정적 import 하면 라우트만
    // lazy 로 내려도 heatmap·studyViews 모듈 트리가 초기 그래프에 남는다.
    const lazyOnly = [
      './heatmap/HeatmapDrawer',
      './screener/ScreenerDrawer',
      './rightrail/RankingDrawer',
      './studyViews/StudyViewsDrawer',
      './signalAlerts/SignalAlertsDrawer',
      './pages/Settings',
    ];
    const statics = staticImportSources(APP);
    expect(statics.filter((s) => lazyOnly.includes(s))).toEqual([]);
  });

  it('App.tsx 는 기본 활성 패널(관심종목)만 정적 유지한다', () => {
    expect(staticImportSources(APP)).toContain('./watchlist/WatchlistDrawer');
  });

  it('두 파일 모두 lazy 를 실제로 쓴다 — 가드가 빈 목록을 훑고 통과하지 않게', () => {
    expect(MAIN).toContain('lazy(');
    expect(APP).toContain('lazy(');
  });
});
