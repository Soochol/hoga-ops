/** PROTOTYPE 변형 B — **버려질 코드다.**
 *
 *  전제: **파생에서 알고 싶은 건 한 상품이 아니라 상품 사이의 관계다.** 선물은 사면서
 *  풋을 같이 사는지, 미니가 메인과 반대인지는 나란히 놔야만 보인다. 그래서 7상품을
 *  동시에 편다 — 셀 하나가 상품 하나, 스몰 멀티플.
 *
 *  축은 **계약수**다(A 의 억원과 대비하라는 것이 이 변형의 절반이다). 계약수면 옵션과
 *  선물이 같은 자릿수라 셀들이 서로 비교 가능해진다. 대신 "얼마나 큰 돈인가" 는 사라진다.
 *
 *  셀별로 스케일이 독립이다 — 상품 규모가 20배 갈리므로 공통 스케일이면 미니 계열이
 *  전부 평평한 선이 된다. 대신 셀 사이 높이 비교는 **의미가 없다**(모양만 비교).
 */
import { SessionLinesChart } from '../marketBits';
import { CardHeader, MarketCard } from '../marketCardBits';
import { SERIES_COLORS, fmtSigned } from '../marketFormat';
import {
  ACTORS,
  DERIV_FLOW,
  DERIV_SESSION_END_SEC,
  DERIV_SESSION_START_SEC,
  EXPECTED_COUNT,
  PRODUCTS,
  SAMPLE_COUNT,
  lastOf,
  upTo,
  type Product,
} from './fixture';

const TIER_BADGE: Record<Product['tier'], string | null> = {
  main: null,
  mini: '미니',
  stock: '주식',
};

function Cell({ product }: { product: Product }) {
  const points = upTo(DERIV_FLOW[product.key]);
  const last = points[points.length - 1];
  return (
    <div className="flex flex-col gap-[2px] border-l-2 border-border pl-2xs">
      <div className="flex items-baseline justify-between gap-2xs">
        <span className="whitespace-nowrap text-2xs font-semibold text-fg">{product.label}</span>
        {TIER_BADGE[product.tier] && (
          <span className="rounded-sm bg-bg-elev px-[3px] text-[9px] text-fg-dim">
            {TIER_BADGE[product.tier]}
          </span>
        )}
      </div>
      <SessionLinesChart
        series={ACTORS.map((a) => ({
          color: SERIES_COLORS[a.key],
          points: points.map((pt) => ({ sec: pt.sec, v: pt.contracts[a.key] })),
        }))}
        sessionStartSec={DERIV_SESSION_START_SEC}
        sessionEndSec={DERIV_SESSION_END_SEC}
        height={54}
      />
      <div className="flex justify-between font-data text-[10px] tabular-nums">
        {ACTORS.map((a) => (
          <span key={a.key} style={{ color: SERIES_COLORS[a.key] }}>
            {last ? fmtSigned(last.contracts[a.key]) : '—'}
          </span>
        ))}
      </div>
    </div>
  );
}

/** 마지막 칸 — 빈자리를 남기는 대신 상품 사이의 질문 하나를 세운다.
 *  외국인 콜 순매수 − 풋 순매수. 양수면 방향성 롱, 음수면 헤지·숏. */
function CallPutSkew() {
  const rows = [
    { label: '메인', call: lastOf('OC01'), put: lastOf('OP01') },
    { label: '미니', call: lastOf('OC02'), put: lastOf('OP02') },
  ];
  const max = Math.max(
    ...rows.map((r) =>
      Math.abs((r.call?.contracts.foreign ?? 0) - (r.put?.contracts.foreign ?? 0)),
    ),
    1,
  );
  return (
    <div className="flex flex-col gap-[2px] border-l-2 border-border-strong pl-2xs">
      <span className="whitespace-nowrap text-2xs font-semibold text-fg-dim">외국인 콜−풋</span>
      <div className="flex flex-1 flex-col justify-center gap-2xs">
        {rows.map((r) => {
          const v = (r.call?.contracts.foreign ?? 0) - (r.put?.contracts.foreign ?? 0);
          const w = (Math.abs(v) / max) * 50;
          return (
            <div key={r.label} className="flex items-center gap-2xs">
              <span className="w-6 shrink-0 text-[10px] text-fg-dim">{r.label}</span>
              <span className="relative flex h-2 flex-1 items-center">
                <span className="absolute left-1/2 h-full w-px bg-border-strong" />
                <span
                  className="absolute h-1.5"
                  style={{
                    background: v >= 0 ? SERIES_COLORS.foreign : SERIES_COLORS.institution,
                    left: v >= 0 ? '50%' : `${50 - w}%`,
                    width: `${w}%`,
                  }}
                />
              </span>
              <span className="w-12 shrink-0 text-right font-data text-[10px] tabular-nums text-fg-dim">
                {fmtSigned(v)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function VariantB() {
  return (
    <MarketCard className="flex flex-col gap-sm p-md">
      <CardHeader
        title="파생 투자자 수급"
        hint={`당일 누적 · 계약 · 잠정 · 표본 ${SAMPLE_COUNT}/${EXPECTED_COUNT} · 09:00–15:45`}
        right={
          <span className="flex items-center gap-sm font-data text-2xs text-fg-dim">
            {ACTORS.map((a) => (
              <span key={a.key} className="flex items-center gap-2xs">
                <span
                  className="inline-block h-[2px] w-[10px]"
                  style={{ background: SERIES_COLORS[a.key] }}
                />
                {a.label}
              </span>
            ))}
          </span>
        }
      />
      <div className="grid grid-cols-4 gap-x-md gap-y-sm">
        {PRODUCTS.map((p) => (
          <Cell key={p.key} product={p} />
        ))}
        <CallPutSkew />
      </div>
    </MarketCard>
  );
}
