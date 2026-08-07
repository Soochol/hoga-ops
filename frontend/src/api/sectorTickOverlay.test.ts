/** 0J/0U 오버레이 — **폴링 캐시를 덮되 지우지 않는다**는 계약을 고정한다.
 *
 * 이 파일이 지키는 실패는 전부 "조용한" 종류다: 틱이 기존 값을 지워도 화면은
 * `—` 를 그릴 뿐 에러가 없고, 캐시 키가 어긋나도 그냥 실시간이 안 될 뿐이다.
 */
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { applySectorTick } from './sectorTickOverlay';
import type { MarketSectorsResponse } from './market';
import type { MarketIndexQuote } from './marketIndexQuotes';

function seedSectors(qc: QueryClient): void {
  const seed: MarketSectorsResponse = {
    markets: {
      '0': {
        index: {
          code: '001', name: '종합(KOSPI)', value: 6300, change_pct: 0.5,
          rising: 400, falling: 300, flat: 50, upper: 1, lower: 0,
          trade_value_eok: 80000, listed_count: 943,
        },
        sectors: [
          { code: '011', name: '금속', value: 6655, change_pct: -1.5, trade_value_eok: 100 },
        ],
      },
    },
    volatility: { code: '603', name: '변동성지수', value: 75.0, change_pct: -1.0 },
  };
  qc.setQueryData(['market', 'sectors'], seed);
}

function seedQuotes(qc: QueryClient): void {
  const seed: MarketIndexQuote[] = [
    { id: 'KOSPI', label: 'KOSPI', value: 6300, change: 30, changeRate: 0.5, tMs: 1 },
    { id: 'KRX100', label: 'KRX 100', value: 15400, change: -10, changeRate: -0.06, tMs: 1 },
  ];
  qc.setQueryData(['market-index-quotes'], seed);
}

function evt(sectors: Record<string, Record<string, number>>) {
  return { type: 'market_sector_tick' as const, sectors };
}

describe('applySectorTick', () => {
  it('종합지수 틱이 지수·등락종목수를 함께 갱신한다', () => {
    const qc = new QueryClient();
    seedSectors(qc);
    applySectorTick(qc, evt({ '001': { value: 6250.5, change_pct: -0.3, rising: 359, falling: 510 } }));

    const got = qc.getQueryData<MarketSectorsResponse>(['market', 'sectors'])!;
    expect(got.markets['0'].index!.value).toBe(6250.5);
    expect(got.markets['0'].index!.change_pct).toBe(-0.3);
    expect(got.markets['0'].index!.rising).toBe(359);
    expect(got.markets['0'].index!.falling).toBe(510);
  });

  it('0J 틱(등락종목수 없음)이 기존 등락종목수를 지우지 않는다', () => {
    // 0J 는 레벨만, 0U 는 등락종목수만 준다. 둘이 번갈아 오므로 "말 안 한 필드"를
    // undefined 로 덮으면 카드의 ▲▼ 가 매 틱 깜빡이며 사라진다.
    const qc = new QueryClient();
    seedSectors(qc);
    applySectorTick(qc, evt({ '001': { value: 6250.5 } }));

    const got = qc.getQueryData<MarketSectorsResponse>(['market', 'sectors'])!;
    expect(got.markets['0'].index!.rising).toBe(400);
    expect(got.markets['0'].index!.flat).toBe(50);
    expect(got.markets['0'].index!.listed_count).toBe(943); // 0J/0U 에 아예 없는 필드
  });

  it('업종 행과 변동성지수도 갱신된다', () => {
    const qc = new QueryClient();
    seedSectors(qc);
    applySectorTick(qc, evt({
      '011': { value: 6600.1, change_pct: -2.4 },
      '603': { value: 75.97, change_pct: -1.56 },
    }));

    const got = qc.getQueryData<MarketSectorsResponse>(['market', 'sectors'])!;
    expect(got.markets['0'].sectors[0].value).toBe(6600.1);
    expect(got.markets['0'].sectors[0].name).toBe('금속'); // 이름은 폴링만 준다
    expect(got.volatility!.value).toBe(75.97);
  });

  it('하단 지수 바 캐시도 같은 틱으로 갱신된다', () => {
    const qc = new QueryClient();
    seedQuotes(qc);
    applySectorTick(qc, evt({ '001': { value: 6250.5, change: -49.5, change_pct: -0.79 } }));

    const got = qc.getQueryData<MarketIndexQuote[]>(['market-index-quotes'])!;
    expect(got[0]).toMatchObject({ value: 6250.5, change: -49.5, changeRate: -0.79 });
  });

  it('KRX100 은 매핑이 없어 폴링 값 그대로 남는다', () => {
    // 0J 코드가 미확인이라 의도적으로 비워 둔 자리다 — 조용히 안 바뀌는 것이 정상이고,
    // 나중에 매핑이 생기면 이 테스트가 실패하며 알려 준다.
    const qc = new QueryClient();
    seedQuotes(qc);
    applySectorTick(qc, evt({ '001': { value: 6250.5 } }));

    const got = qc.getQueryData<MarketIndexQuote[]>(['market-index-quotes'])!;
    expect(got[1]).toMatchObject({ id: 'KRX100', value: 15400 });
  });

  it('캐시가 아직 없으면 아무것도 만들지 않는다', () => {
    // 첫 폴링 전에 틱이 오면 종목명·상장종목수 없는 반쪽 응답이 생길 수 있다.
    const qc = new QueryClient();
    applySectorTick(qc, evt({ '001': { value: 6250.5 } }));

    expect(qc.getQueryData(['market', 'sectors'])).toBeUndefined();
    expect(qc.getQueryData(['market-index-quotes'])).toBeUndefined();
  });

  it('모르는 코드만 온 틱은 캐시 객체를 바꾸지 않는다', () => {
    // 참조가 바뀌면 React Query 가 리렌더를 돌린다 — 매초 오는 이벤트라 헛돌면 비싸다.
    const qc = new QueryClient();
    seedSectors(qc);
    const before = qc.getQueryData(['market', 'sectors']);
    applySectorTick(qc, evt({ '999': { value: 1 } }));

    expect(qc.getQueryData(['market', 'sectors'])).toBe(before);
  });
});
