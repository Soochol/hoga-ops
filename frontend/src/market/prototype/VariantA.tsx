/** PROTOTYPE 변형 A — **버려질 코드다.**
 *
 *  전제: **한 번에 궁금한 상품은 하나다.** 그러니 카드를 늘리지 말고 현행 카드에
 *  상품 선택기를 달아 주식·파생을 같은 자리에서 갈아 끼운다. 현행 2패널 그리드는
 *  선택 하나짜리 전폭 차트로 바뀐다.
 *
 *  축은 **억원 그대로**(현행 `unit: "amt_eok"`). 이게 A 의 진짜 시험이다 — 선물에서
 *  콜옵션으로 넘기면 같은 축에서 값이 두 자릿수 작아진다(계약 단가 115백만 vs 0.75백만).
 *  "억원 단일 축으로 7상품을 다 볼 수 있는가" 를 눈으로 답하게 하는 것이 목적이다.
 */
import { useState } from 'react';
import { LegendItem, SessionLinesChart } from '../marketBits';
import { CardHeader, MarketCard } from '../marketCardBits';
import { SERIES_COLORS } from '../marketFormat';
import { TABS, type Selection } from './ProductTabs';
import { useTabStyle } from './PrototypeSwitcher';
import {
  ACTORS,
  DERIV_FLOW,
  DERIV_SESSION_END_SEC,
  DERIV_SESSION_START_SEC,
  EXPECTED_COUNT,
  PRODUCTS,
  SAMPLE_COUNT,
  toEok,
  upTo,
  type ProductKey,
} from './fixture';

export function VariantA() {
  const [sel, setSel] = useState<Selection>('F001');
  const Tabs = TABS[useTabStyle()];
  const isStock = sel === 'KSP' || sel === 'KSQ';
  const product = PRODUCTS.find((p) => p.key === sel);

  // 주식은 이 프로토타입의 관심 밖이라 픽스처를 따로 만들지 않았다 — 선택기가
  // 주식·파생을 같은 줄에 세운다는 **구조**만 보이면 이 변형의 질문은 답해진다.
  const points = isStock ? [] : upTo(DERIV_FLOW[sel as ProductKey]);
  const last = points[points.length - 1];

  return (
    <MarketCard className="flex flex-col gap-sm p-md">
      <CardHeader
        title="투자자 수급"
        hint={`당일 누적 · 억원 · 잠정 · 표본 ${isStock ? '549/390' : `${SAMPLE_COUNT}/${EXPECTED_COUNT}`}`}
        right={
          <span className="font-data text-2xs text-fg-dim">
            {isStock ? 'ka10051' : `FHPTJ04030000 · ${product?.iscd}/${product?.key}`}
          </span>
        }
      />

      {/* 선택기 — 시안 4종을 ↑/↓ 로 갈아 끼운다(`?tabs=T0|T1|T2|T3`). */}
      <div>
        <Tabs value={sel} onChange={setSel} />
      </div>

      {isStock ? (
        <div className="flex h-[150px] items-center justify-center text-2xs text-fg-dim">
          주식은 현행 ka10051 경로 그대로 — 이 변형의 픽스처 밖입니다.
        </div>
      ) : (
        <div className="flex flex-col gap-2xs">
          <div className="flex flex-wrap items-baseline justify-between gap-x-sm">
            <span className="text-xs font-semibold text-fg-dim">{product?.label}</span>
            <span className="flex items-center gap-md font-data text-2xs tabular-nums">
              {ACTORS.map((a) => (
                <LegendItem
                  key={a.key}
                  color={SERIES_COLORS[a.key]}
                  label={a.label}
                  value={last ? toEok(last.millionWon[a.key]) : null}
                />
              ))}
            </span>
          </div>
          <SessionLinesChart
            series={ACTORS.map((a) => ({
              color: SERIES_COLORS[a.key],
              points: points.map((pt) => ({ sec: pt.sec, v: toEok(pt.millionWon[a.key]) })),
            }))}
            sessionStartSec={DERIV_SESSION_START_SEC}
            sessionEndSec={DERIV_SESSION_END_SEC}
            height={128}
          />
          {/* 파생 세션은 15:45 다 — 주식(15:30)용 SessionAxisLabels 를 그대로 못 쓴다. */}
          <div className="flex justify-between font-data text-2xs text-fg-dim tabular-nums">
            <span>09:00</span>
            <span>12:00</span>
            <span>15:45</span>
          </div>
        </div>
      )}
    </MarketCard>
  );
}
