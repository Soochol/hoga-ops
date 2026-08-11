/** 투자자 수급 카드 — 판정 A+T2 가 지키려던 계약을 고정한다.
 *
 * 이 카드의 어려운 부분은 레이아웃이 아니라 **주식과 파생이 서로 다른 데이터라는 것**이다:
 * 세션이 15분 다르고, 일별 경로가 한쪽에만 있고, 축(억원/계약)이 응답에 따라 갈린다.
 * 아래 테스트는 그 세 갈림이 화면에서 정직하게 드러나는지를 잰다.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as client from '../api/client';
import { InvestorCard } from './InvestorFlowCard';

const T0 = Date.UTC(2026, 7, 7, 4, 0); // 13:00 KST
/** 15:35 KST — **정규장 밖이지만 수집 창 안**이다. 종가 단일가 체결분이 붙는 자리라
 *  이 표본 하나가 그날 수급의 마지막 모양을 정한다. */
const T_AFTER_CLOSE = Date.UTC(2026, 7, 7, 6, 35);

const STOCK = {
  date: '20260807',
  unit: 'amt_eok',
  confirmed: false,
  // 주식 수집 창은 09:00–16:30 이다(`session_gate.INVESTOR_FLOW_CLOSE_MIN`) — 정규장
  // 15:30 이 아니다. 화면은 이 값에서 x축과 눈금을 **둘 다** 파생시킨다.
  session_start_sec: 9 * 3600,
  session_end_sec: 16 * 3600 + 30 * 60,
  coverage: {
    first_sample_ms: T0,
    last_sample_ms: T0 + 60_000,
    sample_count: 42,
    expected_count: 390,
    gap_ranges: [],
  },
  daily: [
    { date: '20260806', markets: { KOSPI: { individual: 100, foreign: -200, institution: 90 } } },
  ],
  markets: {
    KOSPI: [
      { t_ms: T0, individual: 100, foreign: -300, institution: 210 },
      { t_ms: T0 + 60_000, individual: 140, foreign: -420, institution: 300 },
    ],
    KOSDAQ: [
      { t_ms: T0, individual: -50, foreign: 30, institution: 25 },
      { t_ms: T0 + 60_000, individual: -80, foreign: 55, institution: 30 },
    ],
  },
};

function derivPoint(t: number, scale: number) {
  return {
    t_ms: t,
    individual: -1200 * scale,
    foreign: 3400 * scale,
    institution: -2100 * scale,
    individual_qty: -480 * scale,
    foreign_qty: 1360 * scale,
    institution_qty: -840 * scale,
  };
}

/** 단위 미확정 응답 — 억원 축이 통째로 null 이고 계약만 산다. */
function unresolvedPoint(t: number) {
  return {
    t_ms: t,
    individual: null,
    foreign: null,
    institution: null,
    individual_qty: -480,
    foreign_qty: 1360,
    institution_qty: -840,
  };
}

const PRODUCT_META: Record<string, { label: string; iscd: string; family: string }> = {
  F001: { label: '선물', iscd: 'K2I', family: 'futures' },
  OC01: { label: '콜옵션', iscd: 'K2I', family: 'call' },
  OP01: { label: '풋옵션', iscd: 'K2I', family: 'put' },
  F004: { label: '미니선물', iscd: 'MKI', family: 'futures' },
  OC02: { label: '미니콜옵션', iscd: 'MKI', family: 'call' },
  OP02: { label: '미니풋옵션', iscd: 'MKI', family: 'put' },
  S001: { label: '주식선물', iscd: '999', family: 'futures' },
};

function derivResponse({ resolved = true, points = true }: { resolved?: boolean; points?: boolean } = {}) {
  const mk = (i: number) =>
    points
      ? [resolved ? derivPoint(T0, 1) : unresolvedPoint(T0), resolved ? derivPoint(T0 + 60_000, 1 + i / 10) : unresolvedPoint(T0 + 60_000)]
      : [];
  return {
    date: '20260807',
    unit: resolved ? 'amt_eok' : null,
    units: {
      quantity: resolved ? 'contract' : null,
      amount: resolved ? 'million_won' : null,
      resolved,
      reason: resolved ? '거래량 260000 → 계약 축' : '거래량 260 < 임계 2000 — 판정 보류',
    },
    session_start_sec: 9 * 3600,
    session_end_sec: 15 * 3600 + 45 * 60,
    products: Object.fromEntries(
      Object.entries(PRODUCT_META).map(([key, meta], i) => [
        key,
        {
          ...meta,
          points: mk(i),
          coverage: {
            first_sample_ms: points ? T0 : null,
            last_sample_ms: points ? T0 + 60_000 : null,
            sample_count: points ? 2 : 0,
            expected_count: 405,
            gap_ranges: [],
          },
        },
      ]),
    ),
  };
}

function mockApi(deriv: unknown = derivResponse(), stock: unknown = STOCK) {
  vi.spyOn(client, 'apiCall').mockImplementation((async (url: string) => {
    if (url.startsWith('/api/market/investor-flow')) return stock;
    if (url.startsWith('/api/market/deriv-flow')) return deriv;
    return {};
  }) as unknown as typeof client.apiCall);
}

function renderCard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <InvestorCard />
    </QueryClientProvider>,
  );
}

describe('InvestorCard', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('주식 2 + 파생 7 이 한 선택기에 선다', async () => {
    mockApi();
    renderCard();
    const picker = await screen.findByRole('group', { name: '수급 대상' });
    const labels = Array.from(picker.querySelectorAll('button')).map((b) => b.textContent);
    expect(labels).toEqual([
      '코스피',
      '코스닥',
      '선물',
      '콜옵션',
      '풋옵션',
      '미니선물',
      '미니콜옵션',
      '미니풋옵션',
      '주식선물',
    ]);
  });

  it('미니 계열 라벨에서 접두를 떼지 않는다 — 평평한 선택기라 K2I 와 구분이 사라진다', async () => {
    mockApi();
    renderCard();
    const picker = await screen.findByRole('group', { name: '수급 대상' });
    const labels = Array.from(picker.querySelectorAll('button')).map((b) => b.textContent);
    // "선물"·"콜옵션"·"풋옵션" 이 각각 정확히 한 번씩만 나온다(미니는 접두가 붙어 별개).
    for (const l of ['선물', '콜옵션', '풋옵션']) {
      expect(labels.filter((x) => x === l)).toHaveLength(1);
    }
  });

  it('주식을 고르면 당일/일별 토글이 있고, 파생을 고르면 사라진다', async () => {
    // 파생엔 일별 확정 경로가 아예 없다(FHPTJ04040000 의 시장구분은 KSP/KSQ 뿐).
    // 있지도 않은 경로를 버튼으로 두면 눌러 보고 나서야 빈 화면을 만난다.
    mockApi();
    renderCard();
    expect(await screen.findByRole('group', { name: '수급 표시 구간' })).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: '선물' }));
    expect(screen.queryByRole('group', { name: '수급 표시 구간' })).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: '코스피' }));
    expect(screen.getByRole('group', { name: '수급 표시 구간' })).toBeTruthy();
  });

  it('세션축 눈금은 응답이 정한다 — 주식 16:30, 파생 15:45', async () => {
    // 눈금을 하드코딩하면 선은 창 끝까지 그려지는데 눈금만 다른 시각을 말한다
    // (`SessionAxisLabels` 주석의 그 함정). 두 축이 서로 다른 값이라 한쪽을 고정값으로
    // 되돌리면 반드시 여기가 깨진다.
    mockApi();
    renderCard();
    expect(await screen.findByText('16:30')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '선물' }));
    expect(screen.getByText('15:45')).toBeTruthy();
    expect(screen.queryByText('16:30')).toBeNull();
  });

  it('마감 후 표본이 x축 끝에 클램프되지 않는다 — 종가 단일가 체결분이 붙는 점이다', async () => {
    // **막는 것**: 창만 넓히고 화면 축을 15:30 에 두는 반쪽 수정. 그러면 15:35 표본이
    // `Math.min(sec, sessionEndSec)` 에 걸려 오른쪽 끝(x=299)에 못박히고, 하필 그날
    // 가장 중요한 점(동시호가 반영분)이 직전 표본과 겹쳐 사라진다.
    //
    // 판정을 픽셀로 한다: 09:00–16:30 축에서 15:35 는 x≈262 여야 하고, 축이 15:30 이면
    // 클램프되어 정확히 299 가 된다. **눈금 라벨만 보는 검사로는 이걸 못 잡는다** —
    // 라벨과 스케일은 각각 다른 prop 이라 한쪽만 고쳐도 라벨은 통과한다.
    mockApi(derivResponse(), {
      ...STOCK,
      markets: {
        ...STOCK.markets,
        KOSPI: [
          ...STOCK.markets.KOSPI,
          { t_ms: T_AFTER_CLOSE, individual: 200, foreign: -600, institution: 410 },
        ],
      },
    });
    const { container } = renderCard();
    await screen.findByText('16:30');
    const d = container.querySelector('svg path[stroke]')?.getAttribute('d') ?? '';
    const lastX = Number(d.trim().split(/[ML]/).filter(Boolean).pop()?.split(',')[0]);
    expect(lastX).toBeGreaterThan(255);
    expect(lastX).toBeLessThan(270);
  });

  it('단위가 확정되면 억원 축을 쓴다', async () => {
    mockApi();
    renderCard();
    await userEvent.click(await screen.findByRole('button', { name: '선물' }));
    expect(screen.getByText(/억원/)).toBeTruthy();
    expect(screen.queryByText(/단위 미확정/)).toBeNull();
  });

  it('단위 미확정이면 계약 축으로 그리고 이유를 밝힌다', async () => {
    // 억원이 null 이라고 화면이 비면 안 된다 — 값이 없는 게 아니라 환산을 못 하는 것이다.
    mockApi(derivResponse({ resolved: false }));
    renderCard();
    await userEvent.click(await screen.findByRole('button', { name: '선물' }));
    expect(screen.getByText(/계약/)).toBeTruthy();
    expect(screen.getByText(/판정 보류/)).toBeTruthy();
    // 계약 값이 범례에 실제로 실린다.
    expect(screen.getByText('+1,360')).toBeTruthy();
  });

  it('파생 표본이 없으면 빈 상태다 — 실패가 아니다(KIS 무자격이 정상 경로)', async () => {
    mockApi(derivResponse({ points: false }));
    renderCard();
    await userEvent.click(await screen.findByRole('button', { name: '선물' }));
    expect(screen.getByText(/표본이 아직 없습니다/)).toBeTruthy();
  });

  it('선택한 시장 하나만 그린다 — 두 시장을 동시에 펴지 않는다', async () => {
    mockApi();
    renderCard();
    // 코스피 마지막 표본의 외국인 값(-420)이 보이고, 코스닥의 것(+55)은 안 보인다.
    expect(await screen.findByText('-420')).toBeTruthy();
    expect(screen.queryByText('+55')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: '코스닥' }));
    expect(screen.getByText('+55')).toBeTruthy();
    expect(screen.queryByText('-420')).toBeNull();
  });
});
