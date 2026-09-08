/**
 * SectorRankingWindow — 지수 섹터 랭킹 데이터 창 (ADR-0119 PR-D).
 *
 * 멀티창 플립(C2c-2d)으로 구 LiveWorkarea 의 하단 도킹 랭킹 pane 이 화면에서
 * 빠졌다. 여기서 워크스페이스 **데이터 창 kind `'sector-ranking'`**(지수 그룹 전용)
 * 으로 재부착한다. 지수는 호가/거래원/투자자 데이터가 없어 DataWindow 에서
 * "지원하지 않습니다"로 게이트되지만, 섹터 랭킹은 지수 그룹에서 의미 있는
 * 유일한 데이터 kind 다.
 *
 * **basis date**: 구 pane 은 차트 캔들 마지막 봉 + 캔들 hover 로 basis 를 잡았다.
 * 독립 데이터 창엔 캔들·hover 가 없으므로, 그룹 지수의 **일봉**(`useLiveIndexCandles`,
 * 짧은 룩백·캐시)에서 최신 거래일을 도출해 항상 **latest** 모드로 랭킹을 조회한다
 * (마지막 봉 기준 = 비거래일에도 마지막 거래일로 우아하게 degrade, 구 의미론 재현).
 *
 * **종목 클릭**: 지수 그룹을 보존하고 별도 그룹 차트를 열어 재사용한다.
 * 빈 그룹이 없거나 ctrl/⌘+클릭이면 새 브라우저 탭을 사용한다.
 */
import { useMemo, useRef } from 'react';
import { IndexSectorRankingPane } from '../IndexSectorRankingPane';
import { useLiveIndexCandles } from '../../api/liveIndices';
import { useIndexSectorRankings } from '../../api/indexSectorRankings';
import { wantsNewTab, type JumpModifiers } from '../useJumpToLive';
import { openLiveInNewTab } from '../liveNavigate';
import { stockInstrument } from '../liveInstrument';
import type { GroupId } from '../../state/workspace';
import { openSectorStock } from './sectorStockNavigation';
import { realMsToYyyymmdd, subtractDaysKst, todayKstYyyymmdd } from '../liveDateTime';
import type { LiveIndexId } from '../liveInstrument';

/** 최신 거래일 도출용 일봉 룩백(달력 기준) — 최장 연휴+주말도 덮는 넉넉한 창. */
const LATEST_LOOKBACK_DAYS = 15;

export function SectorRankingWindow({ indexId, group }: { indexId: LiveIndexId; group: GroupId }) {
  const resultId = useRef<string | null>(null);
  const jump = (code: string, name: string, e?: JumpModifiers) => {
    if (wantsNewTab(e)) { openLiveInNewTab(stockInstrument(code, name)); return; }
    resultId.current = openSectorStock(code, name, group, resultId.current);
  };
  const today = todayKstYyyymmdd();
  const from = subtractDaysKst(today, LATEST_LOOKBACK_DAYS);
  const candles = useLiveIndexCandles(indexId, 'D', from, today);

  const latestDate = useMemo(() => {
    const list = candles.data?.candles ?? [];
    return list.length > 0 ? realMsToYyyymmdd(list[list.length - 1].t_ms) : null;
  }, [candles.data]);

  const ranking = useIndexSectorRankings(latestDate, !!latestDate, today);

  return (
    <IndexSectorRankingPane
      variant="fill"
      basisDate={latestDate}
      basisMode="latest"
      ranking={ranking.data}
      // basis 를 아직 못 잡은 동안(일봉 로딩)은 랭킹 쿼리가 disabled 라 로딩으로 표시.
      isLoading={candles.isLoading || ranking.isLoading}
      error={ranking.error}
      onClearDatePin={() => {}} // latest 전용 — 고정 상태가 없어 no-op.
      onOpenStock={jump}
      destinationHint="종목 → 별도 차트 (빈 그룹이 없으면 새 탭)"
    />
  );
}
