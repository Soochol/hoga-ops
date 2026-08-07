/** 키움 0J/0U 업종·지수 실시간 오버레이 — **폴링 캐시에 직접 얹는다**.
 *
 * 소비처(지수 카드·하단 지수 바·업종 온도·시장 폭)를 **한 줄도 고치지 않는** 것이
 * 이 설계의 요점이다. WS 틱이 오면 `queryClient.setQueryData` 로 폴링 쿼리의 캐시를
 * 갱신하고, 나머지는 React Query 가 알아서 리렌더한다. 화면마다 "실시간 값 vs 폴링
 * 값" 분기를 심으면 네 군데가 각자 낡는다.
 *
 * ## 폴링을 지우지 않는다
 *
 * `ka20003`(30s)·`ka20001`(30s)이 baseline 으로 계속 돈다. 이유가 셋이다:
 *
 * 1. **조용한 실패 대비.** REG ACK 는 코드 유효성을 검사하지 않아서(쓰레기 코드도
 *    `rc=0`) 코드 하나가 틀리면 그 항목만 틱이 0 이다. baseline 이 없으면 그 카드만
 *    영원히 멎는데, 있으면 30초 갱신으로 강등될 뿐이다.
 * 2. **WS 는 "지금부터" 만 준다.** 페이지를 열자마자는 아직 틱이 없어 화면이 빈다.
 * 3. 종목명·상장종목수처럼 0J/0U 에 없는 필드는 폴링만 준다.
 *
 * 대가는 **강등이 무증상**이라는 것이다. 그래서 `/api/live/status` 의
 * `kiwoom.sector` 카운터가 짝으로 있다 — 화면만 봐서는 실시간인지 알 수 없다.
 *
 * ## KRX100 은 오지 않는다
 *
 * `ka20003` 업종 공간에 없고 0J 코드도 미확인이라 하단 바의 KRX100 만 30초 폴링으로
 * 남는다. 확인되면 백엔드 `sector_registry.INDEX_ID_TO_SECTOR_CODE` 에 한 줄이다.
 */
import type { QueryClient } from '@tanstack/react-query';
import type { MarketSectorsResponse } from './market';
import type { MarketIndexQuote } from './marketIndexQuotes';

/** 서버가 싣는 필드(= 화면이 쓰는 것만). 전 스냅샷을 보내지 않는 이유는 백엔드
 *  `_SECTOR_WIRE_FIELDS` 주석 참조. 전부 optional — 그 틱이 말한 것만 온다. */
export interface SectorTickWire {
  value?: number;
  change?: number;
  change_pct?: number;
  trade_value_eok?: number;
  rising?: number;
  falling?: number;
  flat?: number;
  upper?: number;
  lower?: number;
}

export interface SectorTickEvent {
  type: 'market_sector_tick';
  sectors: Record<string, SectorTickWire>;
}

/** 종합지수 업종코드 → 하단 바/카드의 지수 id. 백엔드
 *  `sector_registry.INDEX_ID_TO_SECTOR_CODE` 의 역방향이고, **양쪽이 어긋나면 카드가
 *  조용히 폴링으로 남는다**(틀린 값이 뜨는 게 아니라 안 뜬다). */
const SECTOR_CODE_TO_INDEX_ID: Record<string, string> = {
  '001': 'KOSPI',
  '101': 'KOSDAQ',
  '201': 'KOSPI200',
  '150': 'KOSDAQ150',
};

/** 시장 구분 — `ka20003` 은 코스피/코스닥을 따로 부르고 응답 키가 `'0'`/`'1'` 이다. */
const MARKET_KEY_BY_WHOLE_CODE: Record<string, string> = { '001': '0', '101': '1' };

/** VKOSPI. 업종 배열이 아니라 최상위 `volatility` 로 사는 코드다. */
const VOLATILITY_CODE = '603';

function applyToRow<T extends { value: number | null; change_pct: number | null }>(
  row: T,
  tick: SectorTickWire,
): T {
  // `undefined` 는 "이 틱이 말하지 않았다" 이므로 기존 값을 지키고, 말한 것만 덮는다.
  return {
    ...row,
    value: tick.value ?? row.value,
    change_pct: tick.change_pct ?? row.change_pct,
  };
}

/** `['market','sectors']` 캐시에 틱을 얹는다. 캐시가 아직 없으면(첫 폴링 전) 아무것도
 *  하지 않는다 — 빈 캐시를 지어내면 종목명·상장종목수 없는 반쪽 응답이 생긴다. */
function patchSectors(qc: QueryClient, sectors: Record<string, SectorTickWire>): void {
  qc.setQueryData<MarketSectorsResponse>(['market', 'sectors'], (prev) => {
    if (!prev) return prev;
    let touched = false;
    const markets = { ...prev.markets };
    let volatility = prev.volatility;

    for (const [code, tick] of Object.entries(sectors)) {
      if (code === VOLATILITY_CODE) {
        if (volatility) {
          volatility = applyToRow(volatility, tick);
          touched = true;
        }
        continue;
      }
      const wholeKey = MARKET_KEY_BY_WHOLE_CODE[code];
      if (wholeKey !== undefined) {
        const m = markets[wholeKey];
        if (m?.index) {
          markets[wholeKey] = {
            ...m,
            index: {
              ...applyToRow(m.index, tick),
              // 등락종목수는 0U 만 준다 — 0J 틱에는 없으므로 기존 값을 지킨다.
              rising: tick.rising ?? m.index.rising,
              falling: tick.falling ?? m.index.falling,
              flat: tick.flat ?? m.index.flat,
              upper: tick.upper ?? m.index.upper,
              lower: tick.lower ?? m.index.lower,
              trade_value_eok: tick.trade_value_eok ?? m.index.trade_value_eok,
            },
          };
          touched = true;
        }
        continue;
      }
      // 업종 행 — 어느 시장에 있는지 모르므로 양쪽을 훑는다(코스피 31 + 코스닥 34).
      for (const [mk, m] of Object.entries(markets)) {
        const i = m.sectors.findIndex((s) => s.code === code);
        if (i < 0) continue;
        const next = [...m.sectors];
        next[i] = {
          ...applyToRow(next[i], tick),
          trade_value_eok: tick.trade_value_eok ?? next[i].trade_value_eok,
        };
        markets[mk] = { ...m, sectors: next };
        touched = true;
        break;
      }
    }
    return touched ? { ...prev, markets, volatility } : prev;
  });
}

/** `['market-index-quotes']` 캐시(하단 지수 바 + 지수 카드 주 숫자)에 얹는다. */
function patchIndexQuotes(qc: QueryClient, sectors: Record<string, SectorTickWire>): void {
  qc.setQueryData<MarketIndexQuote[]>(['market-index-quotes'], (prev) => {
    if (!prev) return prev;
    let touched = false;
    const next = prev.map((q) => {
      const code = Object.keys(SECTOR_CODE_TO_INDEX_ID).find(
        (c) => SECTOR_CODE_TO_INDEX_ID[c] === q.id,
      );
      const tick = code ? sectors[code] : undefined;
      if (!tick) return q;
      touched = true;
      return {
        ...q,
        value: tick.value ?? q.value,
        change: tick.change ?? q.change,
        changeRate: tick.change_pct ?? q.changeRate,
      };
    });
    return touched ? next : prev;
  });
}

/** 이벤트 1건을 두 캐시에 반영. 앱 루트의 WS 구독이 호출한다 —
 *  `/market` 에만 걸면 하단 지수 바(전 페이지)가 실시간이 되지 않는다. */
export function applySectorTick(qc: QueryClient, evt: SectorTickEvent): void {
  if (!evt.sectors || Object.keys(evt.sectors).length === 0) return;
  patchSectors(qc, evt.sectors);
  patchIndexQuotes(qc, evt.sectors);
}
