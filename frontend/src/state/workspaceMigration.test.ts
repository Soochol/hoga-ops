import { describe, it, expect } from 'vitest';
import { buildWorkspaceSeed } from './workspaceMigration';

function counter() {
  let n = 0;
  return () => `id${n++}`;
}

describe('buildWorkspaceSeed', () => {
  it('레거시 상태가 전혀 없으면 null(→ 공장 기본 폴백)', () => {
    expect(buildWorkspaceSeed({}, counter())).toBeNull();
    expect(buildWorkspaceSeed({ page: {}, layout: {}, indicators: undefined }, counter())).toBeNull();
  });

  it('page.candleTimeframe·activeInstrument 를 차트 창 + 그룹1 종목으로 시드한다', () => {
    const seed = buildWorkspaceSeed(
      {
        page: {
          candleTimeframe: 'D',
          activeInstrument: { kind: 'stock', code: '005930', label: '삼성전자' },
          activeCode: '005930',
        },
      },
      counter(),
    );
    expect(seed).not.toBeNull();
    const chart = seed!.windows.find((w) => w.kind === 'chart')!;
    expect(chart.group).toBe(1);
    expect(chart.chart?.timeframe).toBe('D');
    expect(chart.chart?.indicators).toBeTruthy();
    expect(seed!.groupSymbols[1]).toEqual({ code: '005930', name: '삼성전자' });
  });

  it('layout 없으면 카드 5종을 canonical 순서 데이터 창으로 만든다', () => {
    const seed = buildWorkspaceSeed({ page: { candleTimeframe: '1m' } }, counter());
    const kinds = seed!.windows.map((w) => w.kind);
    expect(kinds).toEqual(['chart', 'book', 'broker', 'vdist', 'program', 'investor']);
  });

  it('저장된 카드 순서를 데이터 창 순서로 보존하고 숨긴 카드는 창을 안 만든다', () => {
    const seed = buildWorkspaceSeed(
      {
        page: { candleTimeframe: '1m' },
        layout: {
          rightCardOrder: ['program', 'orderbook', 'brokers', 'volumeDistribution', 'investor'],
          rightCardHidden: { volumeDistribution: true, investor: true },
        },
      },
      counter(),
    );
    const dataKinds = seed!.windows.filter((w) => w.kind !== 'chart').map((w) => w.kind);
    // program·orderbook·brokers 순, vdist·investor 는 숨김 → 제외
    expect(dataKinds).toEqual(['program', 'book', 'broker']);
  });

  it('지수(activeInstrument index)는 kind=index 로 그룹1 종목을 시드한다(C2c-2c)', () => {
    const seed = buildWorkspaceSeed(
      { page: { candleTimeframe: '1m', activeInstrument: { kind: 'index', id: 'KOSPI', label: '코스피' }, activeCode: null } },
      counter(),
    );
    expect(seed!.groupSymbols[1]).toEqual({ code: 'KOSPI', name: '코스피', kind: 'index' });
  });

  it('분봉 페이지는 lastMinuteTimeframe 을 함께 시드한다', () => {
    const seed = buildWorkspaceSeed(
      { page: { candleTimeframe: '5m', activeCode: '005930' } },
      counter(),
    );
    expect(seed!.windows[0].chart?.lastMinuteTimeframe).toBe('5m');
  });

  it('indicators 만 있어도 시드한다(page/layout 없음)', () => {
    const seed = buildWorkspaceSeed(
      { indicators: { paneOrder: [], paneStretch: {}, byTimeframe: {} } },
      counter(),
    );
    expect(seed).not.toBeNull();
    expect(seed!.windows[0].kind).toBe('chart');
    expect(seed!.windows[0].chart?.timeframe).toBe('1m'); // page 없음 → 기본 1m
  });

  it('데이터 창이 없으면(전부 숨김) 차트 창이 폭을 넓혀 채운다', () => {
    const seed = buildWorkspaceSeed(
      {
        page: { candleTimeframe: '1m' },
        layout: {
          rightCardHidden: { orderbook: true, brokers: true, volumeDistribution: true, program: true, investor: true },
        },
      },
      counter(),
    );
    expect(seed!.windows).toHaveLength(1);
    expect(seed!.windows[0].kind).toBe('chart');
    expect(seed!.windows[0].rect.w).toBe(720 + 12 + 236); // CHART_W + gap + DATA_W
  });

  it('모든 창 rect 가 최소 크기 이상이고 데이터 창은 우측 열에 스택된다', () => {
    const seed = buildWorkspaceSeed({ page: { candleTimeframe: '1m' } }, counter());
    const data = seed!.windows.filter((w) => w.kind !== 'chart');
    for (const w of data) {
      expect(w.rect.x).toBe(748); // DATA_X
      expect(w.rect.w).toBe(236);
      expect(w.rect.h).toBeGreaterThanOrEqual(120); // 760/5 = 152 ≥ MIN_H
    }
    // 스택: y 가 증가
    expect(data[1].rect.y).toBeGreaterThan(data[0].rect.y);
  });

  it('zOrder 가 windows 와 1:1 대응한다', () => {
    const seed = buildWorkspaceSeed({ page: { candleTimeframe: '1m' } }, counter());
    expect(seed!.zOrder).toEqual(seed!.windows.map((w) => w.id));
  });
});
