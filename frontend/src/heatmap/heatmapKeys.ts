/** Single source of the heatmap query key — independent from WATCHLIST_KEY
 *  (ADR-0068). Heatmap mutations invalidate this key ONLY, never ['watchlist'],
 *  so the two lists stay fully decoupled. */
import type { QueryClient } from '@tanstack/react-query';
import { INDEX_SECTOR_RANKINGS_KEY } from '../api/indexSectorRankings';

export const HEATMAP_KEY = ['heatmap'] as const;

/** 히트맵 문서가 바뀌면 같이 스테일이 되는 쿼리 전부를 무효화한다.
 *
 *  소비처가 **둘**이라 여기(경량 키 모듈)에 단일 출처로 둔다: ① 이 창이 스스로
 *  바꿨을 때(useHeatmap 의 mutation) ② 다른 창·다른 브라우저의 변경이 WS 로
 *  도착했을 때(api/eventStream). 한쪽에만 키를 추가하면 **원격 창에서만 스테일**
 *  한 비대칭이 생기고, 그건 "가끔 안 맞는다" 로만 보인다.
 *
 *  index-sector-rankings 가 딸려 오는 이유: 그 응답이 히트맵 그룹 구성을 그대로
 *  투영한다(폴더·순서·멤버). 히트맵만 무효화하면 지수·업종 랭킹이 옛 그룹을 계속
 *  말한다.
 *
 *  useHeatmap.ts 가 아니라 이 파일에 두는 이유: eventStream 은 App 루트에서 항상
 *  로드되므로, 무거운 히트맵 피처 모듈을 끌어오면 `/live` 첫 페인트가 히트맵 코드를
 *  기다린다(main.tsx 의 lazy 경계 주석). 이 모듈은 키 상수 + 무효화만 들고 있다. */
export function invalidateHeatmapDependents(qc: QueryClient): void {
  void qc.invalidateQueries({ queryKey: HEATMAP_KEY });
  void qc.invalidateQueries({ queryKey: INDEX_SECTOR_RANKINGS_KEY });
}
