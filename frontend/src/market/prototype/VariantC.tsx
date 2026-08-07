/** PROTOTYPE 변형 C — **버려질 코드다.**
 *
 *  전제: **파생 수급이 답하는 질문은 "얼마"가 아니라 "어느 쪽"이다.** 외국인이 선물을
 *  사면서 풋을 같이 담았다면 그건 상승 베팅이 아니라 헤지다. 그 판단에 장중 곡선은
 *  필요 없다 — 지금의 부호와 상대 크기면 된다. 그래서 **시계열을 통째로 버리고**
 *  주체 × 상품 매트릭스로 간다.
 *
 *  콜 계열과 풋 계열을 굵은 구분선으로 마주 세운다. 오른쪽 끝의 합성 배지는
 *  (선물 방향) + (콜 − 풋) 을 한 낱말로 접은 것이다 — 이 배지가 쓸모 있는지가
 *  이 변형의 진짜 시험이다. 쓸모없으면 매트릭스는 그냥 숫자표다.
 *
 *  열마다 스케일이 독립이다(상품 규모가 20배 갈린다). 막대 길이는 **열 안에서만**
 *  비교할 수 있다.
 */
import { CardHeader, MarketCard } from '../marketCardBits';
import { SERIES_COLORS, fmtSigned } from '../marketFormat';
import {
  ACTORS,
  EXPECTED_COUNT,
  PRODUCTS,
  SAMPLE_COUNT,
  lastOf,
  type ActorKey,
  type ProductKey,
} from './fixture';

/** 열 순서 — 선물 계열 · 콜 계열 · 풋 계열. 사이에 굵은 선이 들어간다. */
const COLUMNS: { key: ProductKey; label: string; groupStart?: boolean }[] = [
  { key: 'F001', label: '선물' },
  { key: 'F004', label: '미니선물' },
  { key: 'S001', label: '주식선물' },
  { key: 'OC01', label: '콜', groupStart: true },
  { key: 'OC02', label: '미니콜' },
  { key: 'OP01', label: '풋', groupStart: true },
  { key: 'OP02', label: '미니풋' },
];

const NET: Record<ProductKey, Record<ActorKey, number>> = Object.fromEntries(
  PRODUCTS.map((p) => [p.key, lastOf(p.key)?.contracts ?? { individual: 0, foreign: 0, institution: 0 }]),
) as Record<ProductKey, Record<ActorKey, number>>;

/** 열 정규화 기준 — 그 상품에서 가장 크게 움직인 주체. */
const COL_MAX: Record<ProductKey, number> = Object.fromEntries(
  PRODUCTS.map((p) => [
    p.key,
    Math.max(...ACTORS.map((a) => Math.abs(NET[p.key][a.key])), 1),
  ]),
) as Record<ProductKey, number>;

function DivergingCell({ value, max, color }: { value: number; max: number; color: string }) {
  const w = (Math.abs(value) / max) * 50;
  return (
    <div className="flex flex-col items-stretch gap-[1px]">
      <span className="relative flex h-2.5 items-center">
        <span className="absolute left-1/2 h-full w-px bg-border-strong" />
        <span
          className="absolute h-2"
          style={{
            background: color,
            opacity: 0.85,
            left: value >= 0 ? '50%' : `${50 - w}%`,
            width: `${w}%`,
          }}
        />
      </span>
      <span className="text-right font-data text-[10px] tabular-nums text-fg-dim">
        {fmtSigned(value)}
      </span>
    </div>
  );
}

/** 선물 방향 + (콜 − 풋) 을 한 낱말로. 두 신호가 어긋나면 그것 자체가 정보다. */
function stance(actor: ActorKey): { text: string; tone: string } {
  const fut = NET.F001[actor] + NET.F004[actor];
  const skew = NET.OC01[actor] + NET.OC02[actor] - (NET.OP01[actor] + NET.OP02[actor]);
  const futUp = fut > 0;
  const skewUp = skew > 0;
  if (futUp && skewUp) return { text: '상승 베팅', tone: 'text-price-up' };
  if (!futUp && !skewUp) return { text: '하락 베팅', tone: 'text-price-down' };
  return { text: futUp ? '롱 + 풋 헤지' : '숏 + 콜 헤지', tone: 'text-fg-dim' };
}

export function VariantC() {
  return (
    <MarketCard className="flex flex-col gap-sm p-md">
      <CardHeader
        title="파생 포지션 보드"
        hint={`당일 순매수 · 계약 · 잠정 · 표본 ${SAMPLE_COUNT}/${EXPECTED_COUNT} · 막대는 열 안에서만 비교`}
      />
      <div className="flex flex-col gap-2xs">
        {/* 헤더 행 */}
        <div className="grid grid-cols-[3.5rem_repeat(7,1fr)_5.5rem] items-end gap-x-2xs">
          <span />
          {COLUMNS.map((c) => (
            <span
              key={c.key}
              className={`whitespace-nowrap text-[10px] text-fg-dim ${
                c.groupStart ? 'border-l border-border-strong pl-2xs' : ''
              }`}
            >
              {c.label}
            </span>
          ))}
          <span className="text-right text-[10px] text-fg-dim">종합</span>
        </div>

        {ACTORS.map((a) => {
          const st = stance(a.key);
          return (
            <div
              key={a.key}
              className="grid grid-cols-[3.5rem_repeat(7,1fr)_5.5rem] items-center gap-x-2xs border-t border-border pt-2xs"
            >
              <span className="flex items-center gap-2xs text-2xs font-semibold text-fg">
                <span
                  className="inline-block h-[2px] w-[10px]"
                  style={{ background: SERIES_COLORS[a.key] }}
                />
                {a.label}
              </span>
              {COLUMNS.map((c) => (
                <span
                  key={c.key}
                  className={c.groupStart ? 'border-l border-border-strong pl-2xs' : ''}
                >
                  <DivergingCell
                    value={NET[c.key][a.key]}
                    max={COL_MAX[c.key]}
                    color={SERIES_COLORS[a.key]}
                  />
                </span>
              ))}
              <span className={`whitespace-nowrap text-right text-2xs ${st.tone}`}>{st.text}</span>
            </div>
          );
        })}
      </div>
    </MarketCard>
  );
}
