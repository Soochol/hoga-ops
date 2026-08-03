import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { expect, it, vi } from 'vitest';

import type { OptionSentiment } from '../api/optionSentiment';
import Sentiment from './Sentiment';

const { mockHook } = vi.hoisted(() => ({ mockHook: vi.fn() }));
vi.mock('../api/optionSentiment', () => ({ useOptionSentiment: mockHook }));

function W({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

function ready(over: Partial<OptionSentiment> = {}): OptionSentiment {
  return {
    unavailable: null,
    expiry: '202608',
    chain_size: 780,
    underlying: 1007.83,
    full_as_of_ms: 1_700_000_000_000,
    atm_as_of_ms: 1_700_000_030_000,
    put_call: {
      volume_ratio: 0.62,
      oi_ratio: 0.905,
      call_volume: 23_235,
      put_volume: 14_413,
      call_oi: 110_191,
      put_oi: 99_738,
    },
    oi_distribution: {
      strikes: [
        // 700 은 도메인 검증용: 전체 뷰에서 플립(702.5)이 축 안에 들어오게 한다
        { strike: 700, call_oi: 10, put_oi: 10 },
        { strike: 1000, call_oi: 1651, put_oi: 6222 },
        { strike: 1100, call_oi: 3000, put_oi: 1000 },
        { strike: 1597.5, call_oi: 14_444, put_oi: 100 },
      ],
      max_pain: 1100,
    },
    gamma_exposure: {
      points: [
        { strike: 1000, gex: -36_401_420_268 },
        { strike: 1250, gex: 13_383_143_966 },
      ],
      total: -73_431_064_166,
      flip_strike: 702.5,
    },
    iv_skew: {
      points: [
        { strike: 1000, call_iv: 96.4, put_iv: 108.5 },
        { strike: 1100, call_iv: 92.1, put_iv: null },
      ],
      atm_iv: 108.51,
      risk_reversal_25d: 27.49,
    },
    ...over,
  };
}

function mount(data: OptionSentiment | undefined, extra: Record<string, unknown> = {}) {
  mockHook.mockReturnValue({ data, isLoading: false, error: null, ...extra });
  render(<Sentiment />, { wrapper: W });
}

it('자격증명 없음과 콜드스타트를 다르게 안내한다', () => {
  // 두 상태를 같은 문구로 묶으면 "설정이 잘못됐다"와 "기다리면 된다"가 뭉개진다.
  mount(ready({ unavailable: 'kis_credentials_missing' }));
  expect(screen.getByText(/KIS 자격증명이 설정되지 않았습니다/)).toBeInTheDocument();

  cleanup();
  mockHook.mockReset();
  mount(ready({ unavailable: 'warming' }));
  expect(screen.getByText(/체인을 수집하는 중입니다/)).toBeInTheDocument();
});

it('대기 문구의 종목 수는 만기 롤오버를 따라간다', () => {
  // 근월물 종목 수는 만기마다 다르다(실측 202608=780 · 202609=1012 · 202610=682).
  // 화면에 상수로 박으면 만기가 넘어가는 순간 조용히 틀린 안내가 된다.
  mount(ready({ unavailable: 'warming', expiry: '202608', chain_size: 780 }));
  expect(screen.getByText(/780종목/)).toBeInTheDocument();

  cleanup(); // 같은 it 안에서 두 번 렌더하면 앞 DOM 이 남아 단언이 무의미해진다
  mockHook.mockReset();
  mount(ready({ unavailable: 'warming', expiry: '202609', chain_size: 1012 }));
  expect(screen.getByText(/1,012종목/)).toBeInTheDocument();
  expect(screen.queryByText(/780종목/)).not.toBeInTheDocument();
});

it('마스터를 아직 못 받았으면 종목 수 없이 안내한다', () => {
  // chain_size 가 null 인데 숫자를 지어내면 안 된다.
  mount(ready({ unavailable: 'warming', chain_size: null }));
  expect(screen.getByText(/근월물 체인을 처음 훑는 중입니다/)).toBeInTheDocument();
});

it('지표 4종과 계층별 관측 시각을 함께 보여준다', () => {
  mount(ready());
  expect(screen.getByText('Put/Call 비율')).toBeInTheDocument();
  expect(screen.getByText(/행사가별 미결제약정/)).toBeInTheDocument();
  expect(screen.getByText(/감마 익스포저/)).toBeInTheDocument();
  expect(screen.getByText('내재변동성 스마일')).toBeInTheDocument();
  // 전수(5분)와 ATM(30초)은 관측 시각이 다르다 — 하나로 뭉치면 오독한다.
  expect(screen.getAllByText(/전수 /).length).toBeGreaterThan(0);
  expect(screen.getAllByText(/ATM /).length).toBeGreaterThan(0);
});

it('해석 한계 문구가 각 지표에 붙어 있다', () => {
  // 이 문구들은 장식이 아니라 설계 요구사항이다(ADR-0135). 조용히 사라지면
  // 화면이 지표를 예측 도구처럼 보이게 만든다.
  mount(ready());
  expect(screen.getByText(/헤지인지 구분하지 못합니다/)).toBeInTheDocument();
  expect(screen.getByText(/방향 지표가 아니라 변동성 체제 지표입니다/)).toBeInTheDocument();
  expect(screen.getByText(/가격 예측이 아닙니다/)).toBeInTheDocument();
  expect(screen.getByText(/투자 판단 도구가 아닙니다/)).toBeInTheDocument();
});

it('극외가 편중을 드러내는 기여 표를 보여준다', () => {
  // Max Pain·GEX 플립이 델타 0짜리 로또 물량에 끌려간 값일 수 있으므로,
  // 무엇이 그 값을 만들었는지 같이 보여야 한다(실측 근거는 ADR-0135).
  mount(ready());
  expect(screen.getByText(/미결제가 몰리는 특성/)).toBeInTheDocument();
  expect(screen.getByText('1597.5')).toBeInTheDocument();
  expect(screen.getByText('14,444')).toBeInTheDocument();
});

it('행사가 축은 기본 ATM 줌이고 전체 토글로 넓어진다', () => {
  // 극외가(1597.5)가 축을 지배하면 중앙 구조가 좁은 띠로 압축된다. 기본 ATM
  // 줌에서는 그 행사가가 차트 밖이고(기여 표에는 남는다), 전체로 바꾸면 눈금이
  // 넓어져 1,500 라벨이 생긴다.
  mount(ready());
  // ATM 줌(underlying 1007.83 ±15% → ~1000-1159): 1,500 눈금 없음
  expect(screen.queryByText('1,500')).not.toBeInTheDocument();
  // 기여 표는 줌과 무관하게 극외가를 계속 보여준다
  expect(screen.getByText('1597.5')).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: '전체' }));
  expect(screen.getAllByText('1,500').length).toBeGreaterThan(0);
});

it('도메인 밖 기준선은 사라지지 않고 가장자리 화살표로 남는다', () => {
  // ATM 줌에서 감마 플립(702.5)은 화면 밖이다. 선을 조용히 생략하면 "플립이
  // 없다" 로 오독되므로 가장자리 마커로 존재를 알린다.
  mount(ready());
  expect(screen.getByText(/◀ 플립 702.5/)).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: '전체' }));
  expect(screen.queryByText(/◀ 플립/)).not.toBeInTheDocument();
  expect(screen.getByText(/^플립 702.5$/)).toBeInTheDocument();
});

it('비율 분모가 0이면 0 이 아니라 — 로 표시한다', () => {
  mount(ready({
    put_call: {
      volume_ratio: null, oi_ratio: null,
      call_volume: 0, put_volume: 0, call_oi: 0, put_oi: 0,
    },
  }));
  expect(screen.getAllByText('—').length).toBeGreaterThan(0);
});
