/** PROTOTYPE 상품 선택기 시안 4종 — **버려질 코드다.**
 *
 *  질문: **9개 선택지(주식 2 + 파생 7)를 카드 헤더 폭 안에서 어떻게 고르게 할 것인가.**
 *
 *  1차 시안(T0)은 시스템 밖에서 지어낸 칩이었고 그래서 틀렸다 — 비활성 배경으로 쓴
 *  `bg-bg-elev` 는 **존재하지 않는 토큰**이라 Tailwind 가 조용히 버렸고, 활성색
 *  `bg-fg text-bg` 는 이 페이지의 선택 앵커(`--tint-selection` + `--accent`)가 아니다.
 *  T1~T3 는 전부 `SegmentedControl`(DESIGN.md "테두리 없는 세그먼트") 위에 세운다.
 *
 *  세 시안이 서로 다투는 지점은 **9를 어떻게 접느냐**다:
 *   - T1 은 계층으로 접는다 — 접는 축이 마침 API 파라미터 축(`fid_input_iscd` →
 *     `fid_input_iscd_2`)과 1:1 이라 화면이 곧 요청 구조다.
 *   - T2 는 안 접는다 — 클릭 1번을 지키고 폭을 낸다.
 *   - T3 는 통째로 접는다 — 트리거가 현재 값 + 맥락을 이고, 고르는 순간에만 펼친다
 *     (`/live` 거래소 선택기 판정 C 와 같은 형).
 */
import { useRef, useState } from 'react';
import { SegmentedControl } from '../../ui/PageShell';
import { useDismissablePopover } from '../../util/useDismissablePopover';
import { fmtSigned } from '../marketFormat';
import { PRODUCTS, STOCK_MARKETS, lastOf, type ProductKey } from './fixture';

export type Selection = ProductKey | 'KSP' | 'KSQ';

export const TAB_STYLES = ['T0', 'T1', 'T2', 'T3'] as const;
export type TabStyle = (typeof TAB_STYLES)[number];
export const TAB_STYLE_NAMES: Record<TabStyle, string> = {
  T0: '1차 칩 (시스템 밖 — 비교용)',
  T1: '2단 세그먼트 (API 축과 1:1)',
  T2: '단일 세그먼트 + 군 구분',
  T3: '요약 pill + 팝오버',
};

type Props = { value: Selection; onChange: (v: Selection) => void };

/** `fid_input_iscd` 군. T1 의 1단이자 T2·T3 의 그룹 경계다.
 *
 *  **`label` 과 `short` 를 둘 다 들고 다닌다.** 계층이 있는 T1 에서만 접두를 뗄 수 있다 —
 *  군 라벨이 이미 "미니" 라고 말했으니 2단에서 또 말하면 같은 낱말을 두 번 읽는다.
 *  평평한 T2 에서 같은 축약을 쓰면 K2I 와 MKI 가 **둘 다 "선물 콜옵션 풋옵션"** 이 되어
 *  구분이 사라진다(1차 렌더에서 실제로 그렇게 나왔다). 축약은 계층의 대가로만 얻는다. */
const memberOf = (iscd: string, strip?: string) =>
  PRODUCTS.filter((p) => p.iscd === iscd).map((p) => ({
    key: p.key as Selection,
    label: p.label,
    short: strip ? p.label.replace(strip, '') : p.label,
  }));

const GROUPS = [
  {
    iscd: 'KSP/KSQ',
    label: '주식',
    members: STOCK_MARKETS.map((m) => ({ key: m.key as Selection, label: m.label, short: m.label })),
  },
  { iscd: 'K2I', label: 'KOSPI200', members: memberOf('K2I') },
  { iscd: 'MKI', label: '미니', members: memberOf('MKI', '미니') },
  { iscd: '999', label: '주식선물', members: memberOf('999') },
] as const;

const SEG_BASE = 'whitespace-nowrap px-2 py-[2px] font-data text-2xs tabular-nums';
const SEG_ON = 'bg-tint-selection text-accent';
const SEG_OFF = 'text-fg-dim hover:bg-bg-input-hover';

function groupOf(value: Selection) {
  return GROUPS.find((g) => g.members.some((m) => m.key === value)) ?? GROUPS[0];
}

function labelOf(value: Selection): string {
  return (
    STOCK_MARKETS.find((m) => m.key === value)?.label ??
    PRODUCTS.find((p) => p.key === value)?.label ??
    String(value)
  );
}

// ── T0 — 1차 칩. 죽은 토큰까지 그대로 둔 비교용 원본 ─────────────────────────
export function TabsT0({ value, onChange }: Props) {
  const all = [
    ...STOCK_MARKETS.map((m) => ({ key: m.key as Selection, label: m.label, group: '주식' })),
    ...PRODUCTS.map((p) => ({ key: p.key as Selection, label: p.label, group: '파생' })),
  ];
  return (
    <div className="flex flex-wrap gap-2xs">
      {all.map((c, i) => (
        <span key={c.key} className="flex items-center gap-2xs">
          {all[i - 1] && all[i - 1].group !== c.group && (
            <span className="mx-2xs h-3 w-px bg-border-strong" aria-hidden="true" />
          )}
          <button
            type="button"
            onClick={() => onChange(c.key)}
            className={`whitespace-nowrap rounded-sm px-2xs py-[1px] text-2xs ${
              value === c.key ? 'bg-fg text-bg' : 'bg-bg-elev text-fg-dim hover:text-fg'
            }`}
          >
            {c.label}
          </button>
        </span>
      ))}
    </div>
  );
}

// ── T1 — 2단 세그먼트 ────────────────────────────────────────────────────────
/** 1단이 `fid_input_iscd`, 2단이 `fid_input_iscd_2` 다. 접는 축을 발명하지 않고
 *  벤더가 이미 그어 둔 선을 쓴다 — 그래서 "왜 이렇게 묶였나" 를 설명할 필요가 없다.
 *
 *  2단이 1개뿐인 군(주식선물)에서도 **줄을 비우지 않는다** — 군을 옮길 때마다 카드
 *  높이가 널뛰면 그 자체가 소음이다. 대신 그 줄이 상품 코드를 말한다. */
export function TabsT1({ value, onChange }: Props) {
  const g = groupOf(value);
  const product = PRODUCTS.find((p) => p.key === value);
  return (
    // `items-start` 가 없으면 flex column 의 stretch 가 세그먼트 트랙을 카드 폭까지
    // 늘린다 — `SegmentedControl` 이 `inline-flex` 여도 소용없다(교차축 stretch 가 이긴다).
    <div className="flex flex-col items-start gap-2xs">
      <SegmentedControl aria-label="시장 구분">
        {GROUPS.map((grp) => {
          const on = grp.iscd === g.iscd;
          return (
            <button
              key={grp.iscd}
              type="button"
              aria-pressed={on}
              onClick={() => {
                if (!on) onChange(grp.members[0].key);
              }}
              className={`${SEG_BASE} ${on ? SEG_ON : SEG_OFF}`}
            >
              {grp.label}
            </button>
          );
        })}
      </SegmentedControl>
      <div className="flex h-[19px] items-center gap-sm">
        {g.members.length > 1 ? (
          <SegmentedControl aria-label="상품 구분">
            {g.members.map((m) => {
              const on = m.key === value;
              return (
                <button
                  key={m.key}
                  type="button"
                  aria-pressed={on}
                  onClick={() => onChange(m.key)}
                  className={`${SEG_BASE} ${on ? SEG_ON : SEG_OFF}`}
                >
                  {m.short}
                </button>
              );
            })}
          </SegmentedControl>
        ) : (
          <span className="font-data text-2xs text-fg-dim">단일 상품</span>
        )}
        {product && (
          <span className="font-data text-2xs text-fg-dimmer">
            {product.iscd} / {product.key}
          </span>
        )}
      </div>
    </div>
  );
}

// ── T2 — 단일 세그먼트 + 군 구분선 ───────────────────────────────────────────
/** 접지 않는 쪽. 클릭 1번이 유지되고 전체 선택지가 늘 보이는 대신 트랙이 길다.
 *  군 경계는 트랙 **안쪽** 1px 선이다 — 밖에 두면 세그먼트가 세 덩어리로 쪼개져
 *  "그룹이 셋" 이 아니라 "컨트롤이 셋" 으로 읽힌다. */
export function TabsT2({ value, onChange }: Props) {
  return (
    <SegmentedControl aria-label="상품 구분">
      {GROUPS.flatMap((grp, gi) => [
        ...(gi > 0
          ? [<span key={`d${gi}`} className="my-[3px] w-px shrink-0 bg-border" aria-hidden="true" />]
          : []),
        ...grp.members.map((m) => {
          const on = m.key === value;
          return (
            <button
              key={m.key}
              type="button"
              aria-pressed={on}
              onClick={() => onChange(m.key)}
              className={`${SEG_BASE} ${on ? SEG_ON : SEG_OFF}`}
            >
              {m.label}
            </button>
          );
        }),
      ])}
    </SegmentedControl>
  );
}

// ── T3 — 요약 pill + 팝오버 ──────────────────────────────────────────────────
/** 통째로 접는 쪽. `/live` 거래소 선택기 판정 C 와 같은 형이고, 그 판정이 세운
 *  기준을 그대로 가져온다 — **트리거가 현재 값과 함께 맥락을 이고 있어야 한다.**
 *  여기서 맥락은 벤더 코드 쌍이고, 목록 항목마다 지금 순매수를 병기해 "고르기 전에
 *  어디가 움직였는지" 를 보여준다. 팝오버는 카드 안이라 포털이 필요 없다
 *  (툴바 `backdrop-blur` 가 만드는 컨테이닝 블록 문제와 다른 자리다). */
export function TabsT3({ value, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  useDismissablePopover(open, anchor, () => setOpen(false));
  const product = PRODUCTS.find((p) => p.key === value);

  return (
    <div ref={anchor} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-center gap-2xs rounded-lg bg-bg-subtle px-2 py-[2px] font-data text-2xs tabular-nums text-fg hover:bg-bg-input-hover"
      >
        <span>{labelOf(value)}</span>
        <span className="text-fg-dimmer">
          {product ? `${product.iscd}/${product.key}` : 'ka10051'}
        </span>
        <span className="text-fg-dim">▾</span>
      </button>
      {open && (
        <div className="absolute left-0 top-[calc(100%+4px)] z-30 min-w-[15rem] rounded-lg bg-bg-card p-2xs shadow-overlay">
          {GROUPS.map((grp) => (
            <div key={grp.iscd} className="flex flex-col">
              <span className="px-2xs pb-[1px] pt-2xs text-[10px] text-fg-dimmer">
                {grp.label}
              </span>
              {grp.members.map((m) => {
                const on = m.key === value;
                const net = PRODUCTS.some((p) => p.key === m.key)
                  ? lastOf(m.key as ProductKey)?.contracts.foreign
                  : undefined;
                return (
                  <button
                    key={m.key}
                    type="button"
                    onClick={() => {
                      onChange(m.key);
                      setOpen(false);
                    }}
                    className={`flex items-center justify-between gap-md rounded-sm px-2xs py-[2px] text-2xs ${
                      on ? 'bg-tint-selection text-accent' : 'text-fg-dim hover:bg-bg-input-hover'
                    }`}
                  >
                    <span className="whitespace-nowrap">{m.label}</span>
                    {/* 고르기 전에 맥락 — 외국인 순매수(계약). 판정 C 가 세운 기준이다. */}
                    <span className="font-data text-[10px] tabular-nums text-fg-dimmer">
                      {net === undefined ? '—' : `외 ${fmtSigned(net)}`}
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export const TABS: Record<TabStyle, (p: Props) => React.ReactNode> = {
  T0: TabsT0,
  T1: TabsT1,
  T2: TabsT2,
  T3: TabsT3,
};
