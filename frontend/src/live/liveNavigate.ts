import { useLivePageStore } from '../state/livePage';
import { instrumentToActiveCode, stockInstrument, type LiveInstrument } from './liveInstrument';

/** 활성 뷰의 종목/instrument를 제자리 교체한다 — 관심종목·헤더 검색·스크리너·히트맵·
 *  지수바 클릭·드롭의 공통 동작. `timeframe`은 유지(같은 봉으로 종목만 전환)하고,
 *  `historicalFromDate`(pan)·viewport는 새 종목의 기본 뷰로 초기화한다.
 *
 *  탭 제거(ADR-0113) 후 `useLivePageStore.activeCode`/`activeInstrument`의 단일 writer는
 *  `projectActiveView` 자신이다(옛 `setActiveTabCode`의 제자리-교체 의미를 계승 — 새 탭을
 *  만들지 않는다). 훅이 아니므로 이벤트 핸들러·비-React 경로 어디서든 호출 가능. */
export function activateLiveInstrument(instrument: LiveInstrument): void {
  const page = useLivePageStore.getState();
  page.projectActiveView({
    instrument,
    code: instrumentToActiveCode(instrument) ?? '',
    timeframe: page.candleTimeframe,
    historicalFromDate: null,
    lastMinuteHistoricalFromDate: null,
    viewport: null,
  });
}

export function activateLiveCode(code: string, label?: string): void {
  activateLiveInstrument(stockInstrument(code, label ?? code));
}
