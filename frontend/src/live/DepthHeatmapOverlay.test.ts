import { describe, it, expect } from 'vitest';
import { buildDepthHeatmapCells } from './DepthHeatmapOverlay';
import type { DepthHeatmapPoint } from './depthHeatmapWire';

const axis = { toVirtual: (ms: number) => ms } as never; // identity axis

describe('buildDepthHeatmapCells', () => {
  it('긴 이력에서도 화면 안 점만 읽어 셀을 생성한다', () => {
    let reads = 0;
    const history = new Proxy(Array.from({ length: 35_100 }, (_, tMs): DepthHeatmapPoint => ({
      tMs, asks: [{ price: 1010, qty: 900 }], bids: [], asksMax: [], bidsMax: [],
    })), {
      get(target, key, receiver) {
        if (typeof key === 'string' && /^\d+$/.test(key)) reads += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    const cells = buildDepthHeatmapCells(history, axis, 20_000, 20_009, {
      bidColor: '#F04452', askColor: '#3485FA', maxOpacity: 1,
    });
    expect(cells).toHaveLength(10);
    expect(reads).toBeLessThan(100);
  });
  const points: DepthHeatmapPoint[] = [
    { tMs: 60000, asks: [{ price: 1010, qty: 900 }], bids: [{ price: 1000, qty: 300 }], asksMax: [], bidsMax: [] },
  ];
  it('레벨당 셀 1개, 매도=askColor 매수=bidColor, α는 visibleMax 정규화', () => {
    const cells = buildDepthHeatmapCells(points, axis, 0, 120000, {
      bidColor: '#F04452', askColor: '#3485FA', maxOpacity: 1,
    });
    expect(cells.length).toBe(2);
    const ask = cells.find((c) => c.price === 1010)!;
    const bid = cells.find((c) => c.price === 1000)!;
    // visibleMax=900 → 매도(qty900)=full α, rgb=파랑(52,133,250)
    expect(ask.fillColor).toBe('rgba(52, 133, 250, 1)');
    // 매수(qty300) α=(300/900)^0.65≈0.487, rgb=빨강(240,68,82)
    expect(bid.fillColor).toMatch(/^rgba\(240, 68, 82, 0\.4[0-9]+\)$/);
  });
  it('빈 visible 범위면 셀 없음', () => {
    const cells = buildDepthHeatmapCells(points, axis, 0, 30000, {
      bidColor: '#F04452', askColor: '#3485FA', maxOpacity: 1,
    });
    expect(cells.length).toBe(0);  // tMs=60000 밖
  });
  it('qty=0 레벨은 스킵', () => {
    const pts: DepthHeatmapPoint[] = [{ tMs: 1000, asks: [{ price: 10, qty: 0 }], bids: [{ price: 9, qty: 5 }], asksMax: [], bidsMax: [] }];
    const cells = buildDepthHeatmapCells(pts, axis, 0, 2000, { bidColor: '#F04452', askColor: '#3485FA', maxOpacity: 1 });
    expect(cells.length).toBe(1);  // ask qty0 skipped
    expect(cells[0].price).toBe(9);
  });
  it('화면 밖 큰 벽은 정규화 천장을 잡지 않는다 — 화면 내 최대로 재정규화', () => {
    // tMs=60000 버킷의 벽(9000)이 화면 밖이면, 화면(tMs=180000) 안의 최대(600)가 천장.
    const pts: DepthHeatmapPoint[] = [
      { tMs: 60000, asks: [{ price: 1010, qty: 9000 }], bids: [], asksMax: [], bidsMax: [] },   // 화면 밖 거대 벽
      { tMs: 180000, asks: [{ price: 1010, qty: 600 }], bids: [{ price: 1000, qty: 600 }], asksMax: [], bidsMax: [] },
    ];
    // 화면 범위 [120000,240000] — tMs=60000 제외. 화면 내 max=600 → 두 셀 모두 full α.
    const visible = buildDepthHeatmapCells(pts, axis, 120000, 240000, {
      bidColor: '#F04452', askColor: '#3485FA', maxOpacity: 1,
    });
    expect(visible.length).toBe(2);
    expect(visible.every((c) => c.fillColor.endsWith(', 1)'))).toBe(true);
    // 대조: 전 범위면 화면 밖 9000이 천장이라 같은 600셀이 옅어진다((600/9000)^0.65 ≈ 0.15).
    const full = buildDepthHeatmapCells(pts, axis, -Infinity, Infinity, {
      bidColor: '#F04452', askColor: '#3485FA', maxOpacity: 1,
    });
    const visibleCell = full.find((c) => c.price === 1000)!;
    expect(visibleCell.fillColor).toMatch(/^rgba\(240, 68, 82, 0\.1[0-9]+\)$/);
  });
  it('intraMax=true면 asksMax/bidsMax를 소스로 셀 빌드 + max 기준 정규화', () => {
    const pts: DepthHeatmapPoint[] = [
      {
        tMs: 1000,
        asks: [{ price: 10, qty: 100 }],
        bids: [{ price: 9, qty: 100 }],
        asksMax: [{ price: 10, qty: 900 }],
        bidsMax: [{ price: 9, qty: 900 }],
      },
    ];
    const cells = buildDepthHeatmapCells(
      pts,
      axis,
      0,
      2000,
      { bidColor: '#F04452', askColor: '#3485FA', maxOpacity: 1 },
      { source: 'peakSnapshot' },
    );
    expect(cells.length).toBe(2);
    // visibleMax=900(max소스), qty=900 → full α
    expect(cells.every((c) => c.fillColor.endsWith(', 1)'))).toBe(true);
  });

  it("source='perPriceMax'는 가격대별 최댓값을 소스로 — 같은 봉에서 peakSnapshot 과 다른 셀", () => {
    // 세 소스가 **서로 다른 값**을 갖는 point. 같은 값이면 어느 소스를 골랐는지
    // 셀만 보고는 알 수 없어 테스트가 통과해도 아무것도 증명하지 못한다.
    const pt: DepthHeatmapPoint = {
      tMs: 1000,
      asks: [{ price: 10, qty: 100 }],
      bids: [{ price: 9, qty: 100 }],
      asksMax: [{ price: 10, qty: 610 }],
      bidsMax: [{ price: 9, qty: 610 }],
      // 가격대별은 더 크고, **가격 개수도 다르다**(10 고정이 아니라는 계약).
      asksPriceMax: [{ price: 10, qty: 935 }, { price: 11, qty: 200 }],
      bidsPriceMax: [{ price: 9, qty: 935 }],
    };
    const style = { bidColor: '#F04452', askColor: '#3485FA', maxOpacity: 1 };
    const peak = buildDepthHeatmapCells([pt], axis, 0, 2000, style, { source: 'peakSnapshot' });
    const perPrice = buildDepthHeatmapCells([pt], axis, 0, 2000, style, { source: 'perPriceMax' });
    expect(peak.map((c) => c.price).sort((a, b) => a - b)).toEqual([9, 10]);
    // 가격대별 소스에만 있는 11 호가가 셀로 나온다.
    expect(perPrice.map((c) => c.price).sort((a, b) => a - b)).toEqual([9, 10, 11]);
    // 정규화 천장도 같은 소스를 따른다(935) → 935 짜리 셀이 full α.
    const best = perPrice.find((c) => c.price === 10)!;
    expect(best.fillColor.endsWith(', 1)')).toBe(true);
    // peakSnapshot 천장은 610 이라 그쪽 셀도 full α — 즉 α 만으로는 구별되지 않고,
    // **가격 집합**이 두 소스를 가른다(위 단언이 실질적인 판별식이다).
    expect(peak.find((c) => c.price === 10)!.fillColor.endsWith(', 1)')).toBe(true);
  });

  it('halfTick=최소 양수 가격 gap/2 (불규칙 gap, point별 캐시)', () => {
    // 가격 gap: 1000→1010(10), 1010→1030(20) → 최소 10 → halfTick=5.
    const pt: DepthHeatmapPoint = {
      tMs: 1000,
      asks: [{ price: 1030, qty: 100 }, { price: 1010, qty: 100 }],
      bids: [{ price: 1000, qty: 100 }],
      asksMax: [], bidsMax: [],
    };
    const cells = buildDepthHeatmapCells([pt], axis, 0, 2000, {
      bidColor: '#F04452', askColor: '#3485FA', maxOpacity: 1,
    });
    expect(cells.every((c) => c.halfTick === 5)).toBe(true);
    // 같은 point 재빌드(캐시 히트) 결과 동일.
    const again = buildDepthHeatmapCells([pt], axis, 0, 2000, {
      bidColor: '#F04452', askColor: '#3485FA', maxOpacity: 1,
    });
    expect(again.every((c) => c.halfTick === 5)).toBe(true);
  });

  // ── topPerSide: 캔들당 「가장 많았던 가격대」만 남기는 가독성 옵션 ──────────
  //
  // 사다리 픽스처: 가격 gap 10 고정, 매도 5·매수 5 레벨. 사이드별 1·2위를 서로
  // 다른 값으로 두어 "상위 N 을 잔량순으로 골랐는가" 가 순서(호가 순)와 구별된다.
  const ASK_TOP = 1040;   // 매도 1위(700)
  const ASK_2ND = 1020;   // 매도 2위(400)
  const BID_TOP = 990;    // 매수 1위(900) = 전역 최대
  const BID_2ND = 970;    // 매수 2위(500)
  const ladder = (): DepthHeatmapPoint => ({
    tMs: 1000,
    asks: [
      { price: 1050, qty: 100 },
      { price: ASK_TOP, qty: 700 },
      { price: 1030, qty: 200 },
      { price: ASK_2ND, qty: 400 },
      { price: 1010, qty: 300 },
    ],
    bids: [
      { price: 1000, qty: 250 },
      { price: BID_TOP, qty: 900 },
      { price: 980, qty: 150 },
      { price: BID_2ND, qty: 500 },
      { price: 960, qty: 50 },
    ],
    asksMax: [], bidsMax: [],
  });
  const STYLE = { bidColor: '#F04452', askColor: '#3485FA', maxOpacity: 1 };

  it('topPerSide=1 이면 매수·매도 각 최대 잔량 레벨만 남는다(캔들당 2셀)', () => {
    const cells = buildDepthHeatmapCells([ladder()], axis, 0, 2000, STYLE, { topPerSide: 1 });
    expect(cells.map((c) => c.price).sort((a, b) => a - b)).toEqual([BID_TOP, ASK_TOP]);
  });

  it('topPerSide=2 는 사이드별 2위까지 — 호가 순이 아니라 잔량 순으로 고른다', () => {
    const cells = buildDepthHeatmapCells([ladder()], axis, 0, 2000, STYLE, { topPerSide: 2 });
    // 호가 순으로 위 2개(1050·1040)를 자르면 1050 이 들어온다 — 잔량 순이면 안 들어온다.
    expect(cells.map((c) => c.price).sort((a, b) => a - b))
      .toEqual([BID_2ND, BID_TOP, ASK_2ND, ASK_TOP].sort((a, b) => a - b));
  });

  it('topPerSide 미지정·null 이면 전 레벨(기존 동작)', () => {
    expect(buildDepthHeatmapCells([ladder()], axis, 0, 2000, STYLE).length).toBe(10);
    expect(buildDepthHeatmapCells([ladder()], axis, 0, 2000, STYLE, { topPerSide: null }).length).toBe(10);
    // 사이드 레벨 수보다 큰 N 도 전부(잘라낼 게 없다).
    expect(buildDepthHeatmapCells([ladder()], axis, 0, 2000, STYLE, { topPerSide: 99 }).length).toBe(10);
  });

  it('셀 높이(halfTick)는 걸러낸 뒤가 아니라 **전체 호가 사다리**로 계산한다', () => {
    // 남는 두 셀만으로 재계산하면 gap 이 1040-990=50 → halfTick 25 로 5배 부푼다.
    // 사다리 전체의 최소 gap 은 10 이므로 정답은 5 — 필터는 그리기 소스만 자른다.
    const cells = buildDepthHeatmapCells([ladder()], axis, 0, 2000, STYLE, { topPerSide: 1 });
    expect(cells.every((c) => c.halfTick === 5)).toBe(true);
  });

  it('남은 두 셀은 **서로 다른** α 를 갖는다 — 사이드별 재정규화 금지', () => {
    // 막는 방향: 매수·매도를 각자 사이드 최댓값으로 정규화하면 둘 다 full α 가 되어
    // "어느 쪽 벽이 더 두꺼운가" 라는 정보가 사라진다. 천장은 양쪽 공통(전역 최대)이다.
    // 전역 최대 = 매수 900 → 매수 full α. 매도 최대 700 → (700/900)^0.65 ≈ 0.849.
    //
    // 이 단언이 **절대값**인 이유: 필터 전/후를 비교하는 형태로는 이 실수를 못 잡는다.
    // 재정규화는 두 경로에 똑같이 적용되어 양쪽이 나란히 어긋나므로 비교가 통과한다
    // (실측 — 주입해 보고 초록인 것을 확인했다). 반대로 "천장이 필터에 오염된다" 는
    // 실패 모드는 애초에 없다: 사이드별 최댓값들의 최댓값 = 전 레벨 최댓값이라 구성상
    // 같은 값이다.
    const top = buildDepthHeatmapCells([ladder()], axis, 0, 2000, STYLE, { topPerSide: 1 });
    expect(top.find((c) => c.price === BID_TOP)!.fillColor).toBe('rgba(240, 68, 82, 1)');
    expect(top.find((c) => c.price === ASK_TOP)!.fillColor)
      .toMatch(/^rgba\(52, 133, 250, 0\.849[0-9]*\)$/);
  });

  it('intraMax 와 조합하면 분봉 내 최대 스냅샷에서 상위 N 을 고른다', () => {
    const pt: DepthHeatmapPoint = {
      tMs: 1000,
      asks: [{ price: 1010, qty: 900 }, { price: 1020, qty: 800 }],
      bids: [{ price: 1000, qty: 700 }],
      asksMax: [{ price: 1030, qty: 600 }, { price: 1040, qty: 500 }],
      bidsMax: [{ price: 990, qty: 400 }],
    };
    const cells = buildDepthHeatmapCells([pt], axis, 0, 2000, STYLE, { source: 'peakSnapshot', topPerSide: 1 });
    // close 소스(1010·1000)가 아니라 max 소스(1030·990)에서 골라야 한다.
    expect(cells.map((c) => c.price).sort((a, b) => a - b)).toEqual([990, 1030]);
  });

  it('한 사이드가 전부 qty=0 이면 그쪽은 셀이 없다', () => {
    const pt: DepthHeatmapPoint = {
      tMs: 1000,
      asks: [{ price: 1010, qty: 0 }, { price: 1020, qty: 0 }],
      bids: [{ price: 1000, qty: 500 }],
      asksMax: [], bidsMax: [],
    };
    const cells = buildDepthHeatmapCells([pt], axis, 0, 2000, STYLE, { topPerSide: 1 });
    expect(cells.map((c) => c.price)).toEqual([1000]);
  });

  it('halfTick close/max 변형은 서로 다른 소스 레벨로 분리 캐시', () => {
    // close 소스는 gap 10(→halfTick 5), max 소스는 gap 40(→halfTick 20).
    const pt: DepthHeatmapPoint = {
      tMs: 1000,
      asks: [{ price: 1010, qty: 100 }],
      bids: [{ price: 1000, qty: 100 }],
      asksMax: [{ price: 1040, qty: 100 }],
      bidsMax: [{ price: 1000, qty: 100 }],
    };
    const style = { bidColor: '#F04452', askColor: '#3485FA', maxOpacity: 1 };
    const closeCells = buildDepthHeatmapCells([pt], axis, 0, 2000, style, { source: 'close' });
    const maxCells = buildDepthHeatmapCells([pt], axis, 0, 2000, style, { source: 'peakSnapshot' });
    expect(closeCells.every((c) => c.halfTick === 5)).toBe(true);
    expect(maxCells.every((c) => c.halfTick === 20)).toBe(true);
  });
});
