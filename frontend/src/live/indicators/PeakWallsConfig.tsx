import { useState, type ReactNode } from 'react';
import {
  PEAK_WALL_FAMILIES,
  peakWallFamilyToggleKeys,
  type PeakWallFamilyId,
} from '../../state/peakWallFamilyPrefs';
import {
  useScopedChartPrefs,
  useChartPrefActions,
  type NumericPrefKey,
  type ChartToggleKey,
} from '../../state/chartPrefs';
import { SettingsRow, ToggleSwitch } from '../settings/SettingsRow';
import IndicatorPrefRows from '../settings/IndicatorPrefRows';
import { useWindowIndicator, useIndicatorActions } from '../workspace/windowView';
import type { IndicatorSettings } from '../../state/indicatorSettingsV2';
import EyeGlyph from '../EyeGlyph';
import MAStylePicker from './MAStylePicker';
import PeakWallRelationSchema from './PeakWallRelationSchema';
import { usePeakWallFilterState } from './usePeakWallFilterState';

type Side = 'ask' | 'bid';

/**
 * 당일 최대벽 설정 — **파이프라인**. 방향 → 계열 → 후보 기준 → 표현 → 강도 pane.
 *
 * ## 왜 표가 아니라 흐름인가 (2026-08-26)
 *
 * 종전의 방향×계열 매트릭스는 **상태 조회**에 최적화돼 있었다(여섯 칸이 한눈에).
 * 그런데 이 패널에서 실제로 반복된 질문은 조회가 아니라 진단이었다 —
 * **「당일 최대벽이 왜 안 보이지」**. 표 구조에서는 후보가 어디서 잘렸는지가 화면에
 * 없어서, 그걸 말해 주려고 셀마다 깔때기 배지를 따로 발명해야 했다.
 *
 * 단계로 세우면 그 답이 **레이아웃 자체**가 된다: ③ 이 「필터로 제외 −M → 그려짐 N개」
 * 를 들고 있으므로 위에서 아래로 한 번 읽으면 어느 단계에서 끊겼는지가 나온다.
 *
 * **버린 것**은 매도·매수를 나란히 보는 것이다. 대신 ① 의 두 카드가 각자 개수를 들어,
 * 반대쪽이 통째로 숨지는 않는다. 이 교환은 프로토타입 세 안(교정된 매트릭스 · 표면 우선
 * 스프레드시트 · 파이프라인)을 실화면에서 비교해 사용자가 고른 것이다.
 *
 * ## 위치가 스코프를 말한다
 *
 * 단계 번호가 곧 스코프의 깊이다 — ① 방향 · ② 그 방향의 계열 · ③④ 고른 칸(방향×계열) ·
 * ⑤ 지표 전체(양방향 공용). 종전 매트릭스가 자리 넷으로 하던 일을 순서가 한다.
 *
 * 2026-08-27 에 그 규칙이 **마지막 예외를 흡수했다**. ⑤ 가 들고 있던 pane 슬롯 6칸
 * (방향 2 × 계열 3)은 ① 에서 방향을 이미 골랐는데도 저 혼자 방향을 다시 물었다 —
 * 패널 안에 남은 유일한 매트릭스였다. 그 칸을 ② 의 계열 행으로 내리면 방향은 ① 이
 * 답한 그대로 상속되고, 계열의 두 표면(캔들 선 · 강도 pane)이 같은 줄에서 마주 본다.
 * ⑤ 에 남는 것은 pane 자체(있다/없다)와 지금 들어 있는 것의 요약뿐이다.
 *
 * ## 「눈」은 그 방향 **전부**를 숨긴다
 *
 * 종전 이 자리의 라벨은 「캔들 수평선」이었는데 **거짓이었다** — `{side}PeakHidden` 은
 * `usePeakWallRender` 에서 `drawn` 으로 접혀 선·도킹 라벨·발생 시점 화살표·순위 화살표를
 * 함께 끈다(2026-08-26 실측). 계열마다 따로 있는 「수평선 표시」와 이름이 충돌하기까지
 * 했다. 배선은 그대로 두고 **이름과 어포던스를 레전드의 눈으로 통일**한다 — 같은 키를
 * 쓰는 두 표면이 같은 그림을 갖는다(`EyeGlyph`).
 */
export default function PeakWallsConfig() {
  // 어느 칸을 보고 있는가. **저장되는 설정이 아니라 표현 상태**라 창을 다시 열면
  // 매도·체결된 벽으로 돌아온다(패널이 `key={windowId}` 로 재마운트).
  const [side, setSide] = useState<Side>('ask');
  const [family, setFamily] = useState<PeakWallFamilyId>('Traded');

  return (
    <div>
      <Stage n={1} title="방향" hint="두 방향은 완전한 미러입니다">
        <div className="flex gap-2">
          {SIDES.map((s) => (
            <SideCard key={s.id} side={s.id} active={side === s.id} onPick={() => setSide(s.id)} />
          ))}
        </div>
      </Stage>

      <Stage n={2} title="계열" hint="앞 둘은 배타 · 전체는 상위집합">
        <FamilySchema side={side} />
        <div className="mt-1">
          <FamilyHeader />
          {PEAK_WALL_FAMILIES.map((f) => (
            <FamilyRow
              key={f.id}
              side={side}
              family={f.id}
              name={f.name}
              active={family === f.id}
              onPick={() => setFamily(f.id)}
            />
          ))}
        </div>
      </Stage>

      {/* ③④ 는 **고른 칸 하나**의 것이다. 그 사실을 testid 로도 못 박는다 —
          「기준 이동평균 기간」 이라는 이름의 노브가 방향당 셋이라, 스코프 없이
          집으면 하나만 배선돼 있어도 테스트가 통과한다. */}
      <div data-testid={`peak-wall-detail-zone-${side}-${family}`}>
        <FilterStage side={side} family={family} />
        <SurfaceStage side={side} family={family} />
      </div>

      <PaneStage />
    </div>
  );
}

/** 단계 하나. 번호가 스코프의 깊이이므로 제목보다 번호가 먼저 온다. */
function Stage({ n, title, hint, right, children }: {
  n: number;
  title: string;
  hint?: string;
  right?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="border-t border-border py-2.5 first:border-t-0 first:pt-0">
      <header className="mb-1.5 flex items-baseline gap-2">
        <span className="shrink-0 text-xs font-semibold tabular-nums text-fg-dim">{n}</span>
        <h4 className="shrink-0 text-sm font-semibold text-fg">{title}</h4>
        {hint && <span className="truncate text-2xs text-fg-dim">{hint}</span>}
        {right && <span className="ml-auto shrink-0">{right}</span>}
      </header>
      {children}
    </section>
  );
}

// ── ① 방향 ────────────────────────────────────────────────────────────────

const SIDE_LABEL: Record<Side, string> = { ask: '매도', bid: '매수' };

/** 방향 두 개의 렌더 순서 — 단계 ① 의 카드와 ⑤ 의 열이 **같은 배열**을 쓴다.
 *  두 곳에 손으로 적으면 언젠가 순서가 갈리고, 그때 ⑤ 의 열 라벨이 거짓말을 한다. */
const SIDES: ReadonlyArray<{ id: Side; label: string }> = [
  { id: 'ask', label: SIDE_LABEL.ask },
  { id: 'bid', label: SIDE_LABEL.bid },
];

/**
 * 방향 카드 — 마스터 스위치와 눈이 **나란히** 앉는다.
 *
 * 둘이 붙어 있어야 하는 이유가 하나 더 있다: `set{Side}PeakEnabled(true)` 는
 * `{side}PeakHidden: false` 를 함께 쓴다(`indicatorOps`). 마스터를 껐다 켜면 눈이
 * 되살아나는데, 종전엔 그 둘이 매트릭스의 머리와 푸터로 갈라져 있어 그 결합이 화면
 * 밖이었다. 여기서는 같은 카드 안이라 눈앞에서 일어난다.
 *
 * 카드가 `<button>` 이 아니라 `role="button"` 인 div 인 이유: 안쪽에 스위치와 눈
 * 버튼이 들어가는데 버튼 중첩은 유효하지 않은 HTML 이다. 선택은 **부가 효과가 없는**
 * 표현 상태라 안쪽 컨트롤이 `stopPropagation` 없이도 안전하다 — 스위치를 누르며 그
 * 방향이 함께 선택되는 것이 오히려 기대에 맞는다(그 카드를 만지고 있으니까).
 */
function SideCard({ side, active, onPick }: { side: Side; active: boolean; onPick: () => void }) {
  const ind = useWindowIndicator((s) => s);
  const actions = useIndicatorActions();
  const enabled = side === 'ask' ? ind.askPeakEnabled : ind.bidPeakEnabled;
  const hidden = side === 'ask' ? ind.askPeakHidden : ind.bidPeakHidden;
  const label = SIDE_LABEL[side];

  // 세 계열의 개수를 합친다. 훅은 계열마다 **고정 호출**이어야 하므로(조건부 훅 금지)
  // 셋을 다 부르고 꺼진 계열만 0 으로 접는다. 차트가 발행하지 않았으면(일·주·월봉)
  // `counts` 가 `undefined` 이고, 그때는 0 이 아니라 **모름**이라 개수 줄을 생략한다.
  const traded = usePeakWallFilterState(side, 'Traded');
  const unreached = usePeakWallFilterState(side, 'Unreached');
  const allWall = usePeakWallFilterState(side, 'AllWall');
  const published = traded.counts !== undefined;
  const shown = ([['Traded', traded], ['Unreached', unreached], ['AllWall', allWall]] as const)
    .reduce((sum, [id, cell]) => (
      familyLineEnabled(ind, side, id) ? sum + (cell.counts?.shown ?? 0) : sum
    ), 0);

  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={active}
      aria-label={`${label} 설정 열기`}
      onClick={onPick}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        onPick();
      }}
      className={`flex-1 cursor-pointer rounded-lg border px-2.5 py-2 transition-colors ${
        active ? 'border-accent bg-tint-selection' : 'border-border hover:border-border-strong'
      } ${enabled ? '' : 'opacity-60'}`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-semibold text-fg">{label}</span>
        <span className="flex items-center gap-1.5">
          <ToggleSwitch
            size="sm"
            label={`${label} 최대벽 표시`}
            checked={enabled}
            onClick={() => actions.setPeakSideEnabledWithUndo(side, !enabled)}
            data-testid={`settings-toggle-${side}PeakEnabled`}
          />
          <button
            type="button"
            aria-label={`${label} 최대벽 숨김`}
            aria-pressed={hidden}
            disabled={!enabled}
            title="이 방향의 선 · 라벨 · 화살표를 모두 숨깁니다 (레전드 값은 남습니다)"
            onClick={() => (side === 'ask'
              ? actions.setAskPeakHidden(!hidden)
              : actions.setBidPeakHidden(!hidden))}
            data-testid={`peak-wall-eye-${side}`}
            className={`transition-colors disabled:opacity-40 ${
              hidden ? 'text-fg-dimmer' : 'text-fg-dim hover:text-fg'
            }`}
          >
            <EyeGlyph hidden={hidden} />
          </button>
        </span>
      </div>
      {/* 반대쪽이 통째로 숨지 않게 하는 줄 — 카드가 자기 방향의 현재 개수를 든다.
          단계 ① 이 방향 선택을 겸하므로, 이 줄이 없으면 고르지 않은 쪽이 완전히 침묵한다. */}
      <div className="mt-0.5 text-2xs tabular-nums text-fg-dim">
        {!enabled
          ? '꺼짐'
          : !published
            ? '분봉 전용'
            : hidden
              ? `숨김 · 후보 ${shown}개`
              : `지금 ${shown}개 표시`}
      </div>
    </div>
  );
}

// ── ② 계열 ────────────────────────────────────────────────────────────────

/** 계열 한 줄의 부제 — 셋의 **관계**(배타·포함)를 그 자리에서 말한다. */
const FAMILY_HINT: Record<PeakWallFamilyId, string> = {
  Traded: '체결이 그 가격을 쳤다',
  Unreached: '아직 안 닿았다 — 위와 배타',
  AllWall: '터치 무관 — 그날 최대 상위집합',
};

/** pane 슬롯 6칸의 상태 키 — `PEAK_WALL_STEP_SLOTS` 와 1:1. 문자열로 조립하지 않는다.
 *  계열 행(②)이 고른 방향의 셋을 쓰고, ⑤ 가 여섯 전체를 요약에 쓴다. */
const PANE_SLOT_KEY = {
  ask: {
    Traded: 'askPeakTradedPaneEnabled',
    Unreached: 'askPeakUnreachedPaneEnabled',
    AllWall: 'askPeakAllWallPaneEnabled',
  },
  bid: {
    Traded: 'bidPeakTradedPaneEnabled',
    Unreached: 'bidPeakUnreachedPaneEnabled',
    AllWall: 'bidPeakAllWallPaneEnabled',
  },
} as const;

/** 계열별 계단이 무엇을 뜻하는지 — 셋의 성질이 실제로 다르다(단조 / 비단조).
 *  종전엔 ⑤ 매트릭스의 행 설명이었고, 슬롯이 계열 행으로 이사하면서 그 토글의
 *  `title` 이 됐다. 설명을 버리지 않되 행 높이를 두 배로 만들지도 않는 자리다. */
const PANE_FAMILY_HINT: Record<PeakWallFamilyId, string> = {
  Traded: '그 시점까지 체결된 벽 중 최대. 기록 갱신 시퀀스라 계단이 내려가지 않습니다.',
  Unreached: '아직 안 닿은 벽 중 최대. 고가가 벽을 넘으면 계단이 내려갑니다(단조 아님).',
  AllWall: '터치 무관 그날 최대. 벽이 빠져나가지 않아 계단이 내려가지 않습니다.',
};

/**
 * 계열 한 줄의 트랙 — 헤더 라벨과 컨트롤이 **같은 격자**라 어긋날 수 없다.
 *
 * 두 스위치가 양 끝에 앉는 것이 배치의 요점이다: 왼쪽은 **캔들 위의 선**, 오른쪽은
 * **차트 아래 강도 pane**. 둘을 나란히 붙이면 어느 쪽이 무엇인지 스위치 모양만으로는
 * 구별되지 않는다 — 화면상의 거리가 두 표면의 거리를 흉내 낸다.
 */
const FAMILY_GRID = 'grid grid-cols-[auto_auto_minmax(0,1fr)_24px_40px] items-center gap-x-2';

function FamilySchema({ side }: { side: Side }) {
  const ind = useWindowIndicator((s) => s);
  const actions = useIndicatorActions();
  return (
    <PeakWallRelationSchema
      side={side}
      tradedColor={familyStyle(ind, actions, side, 'Traded').color}
      unreachedColor={familyStyle(ind, actions, side, 'Unreached').color}
      allWallColor={familyStyle(ind, actions, side, 'AllWall').color}
    />
  );
}

/** 계열 표의 열 머리 — 두 스위치가 각자 어느 표면의 것인지 **한 번만** 적는다.
 *  행마다 텍스트 라벨을 붙이면 세 번 반복되고, 안 붙이면 오른쪽 스위치의 정체가
 *  `title` 안에만 남는다. */
function FamilyHeader() {
  return (
    <div className={`${FAMILY_GRID} px-2 pb-0.5`} aria-hidden="true">
      <span className="col-span-3 text-2xs font-semibold uppercase text-fg-dim">캔들 선</span>
      <span className="text-right text-2xs font-semibold text-fg-dim">개수</span>
      <span className="text-center text-2xs font-semibold text-fg-dim">pane</span>
    </div>
  );
}

function FamilyRow({ side, family, name, active, onPick }: {
  side: Side;
  family: PeakWallFamilyId;
  name: string;
  active: boolean;
  onPick: () => void;
}) {
  const ind = useWindowIndicator((s) => s);
  const actions = useIndicatorActions();
  const { counts } = usePeakWallFilterState(side, family);
  const on = familyLineEnabled(ind, side, family);
  const style = familyStyle(ind, actions, side, family);

  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={active}
      aria-label={`${SIDE_LABEL[side]} ${name}`}
      onClick={onPick}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        onPick();
      }}
      className={`${FAMILY_GRID} cursor-pointer rounded-md px-2 py-1.5 transition-colors ${
        active ? 'bg-tint-selection' : 'hover:bg-bg-input-hover'
      }`}
    >
      <ToggleSwitch
        size="sm"
        label={`${SIDE_LABEL[side]} ${name}`}
        checked={on}
        onClick={() => setFamilyLineEnabled(actions, side, family, !on)}
        data-testid={`settings-toggle-${side}Peak${family}LineEnabled`}
      />
      <span aria-hidden="true" className="h-0.5 w-5 shrink-0 rounded-sm" style={{ backgroundColor: style.color }} />
      {/* 선이 꺼져 있어도 **이름과 pane 스위치는 흐려지지 않는다** — 두 표면이
          독립이라 선을 끈 채 계단만 보는 조합이 정상이다. dim 은 선 쪽 묶음
          (스위치·색·이름)에만 건다. */}
      <span className={`min-w-0 ${on ? '' : 'opacity-55'}`}>
        <span className="block truncate text-sm font-medium text-fg">{name}</span>
        <span className="block truncate text-2xs text-fg-dim">{FAMILY_HINT[family]}</span>
      </span>
      {/* 계열이 꺼져 있거나 차트가 발행하지 않았으면(일·주·월봉) 숫자를 주장하지
          않는다 — 그 0 은 필터 탓이 아니다. */}
      <span className={`text-right text-2xs tabular-nums text-fg-dim ${on ? '' : 'opacity-55'}`}>
        {on && counts ? `${counts.shown}` : '—'}
      </span>
      <PaneSlotSwitch side={side} family={family} name={name} />
    </div>
  );
}

/**
 * 이 계열의 계단을 강도 pane 에 넣는 스위치 — **켜면 pane 이 함께 열린다**
 * (`setPeakWallPaneSlotEnabled` 의 결합). 사용자에게 이 스위치의 이름은 「pane 에
 * 추가」이므로, 켰는데 pane 이 없어서 아무 일도 안 일어나는 상태가 있으면 안 된다.
 *
 * ## 표시는 저장값이 아니라 **지금 pane 에 있는가** 다
 *
 * 슬롯 키와 마스터(`peakWallPaneEnabled`)는 별개 상태이고, 공장값이 서로 어긋난다 —
 * 체결된 벽 슬롯은 켜짐, 마스터는 꺼짐. 저장값을 그대로 그리면 **켜져 있는데 pane 이
 * 없는** 스위치가 첫 화면에 뜬다(2026-08-27 실측). 종전 ⑤ 매트릭스에서는 그 여섯이
 * dim + `disabled` 라 「미리 정해 둔 값」으로 읽혔는데, 계열 행으로 내려오며 그 맥락을
 * 잃었다.
 *
 * 그래서 `checked` 를 `마스터 && 슬롯` 으로 접는다. 그러면 스위치의 뜻이 이름과
 * 같아진다 — **표시 = 지금 pane 에 그려지고 있는가**, 클릭 = 그걸 뒤집는다. 마스터가
 * 닫혀 있으면 저장값이 무엇이든 「없다」이므로 클릭은 언제나 **추가**이고, `!inPane`
 * 이 `true` 라 `setPeakWallPaneSlotEnabled` 의 결합이 마스터를 연다.
 *
 * 이 접힘은 **렌더 경로의 실효 조건과 같은 식**이다 — `LiveChartRoot` 가
 * `needStepSegments: peakWallPaneEnabled` 로 계단 계산을 게이트하고 `usePeakWallRender`
 * 가 그 안에서 슬롯 키를 본다. 즉 화면이 새 규칙을 발명하는 것이 아니라, 이미 참이던
 * 곱을 그리기 시작한 것이다.
 *
 * 접힌 저장값이 화면에서 완전히 사라지지는 않는다 — ⑤ 의 요약 줄이 dim 으로 계속
 * 들고 있어, 마스터를 되켰을 때 무엇이 돌아오는지가 거기서 보인다.
 *
 * 종전의 `disabled` 는 없앤다 — 잠금은 「먼저 저 위 스위치를 켜라」는 뜻인데, 그
 * 스위치를 이제 이 행이 대신 켠다.
 *
 * 스코프는 **고른 방향 × 이 계열** 하나다. 반대 방향의 슬롯은 ① 에서 방향을 바꿔
 * 닿는다 — 패널 전체가 쓰는 문법(위치가 스코프를 말한다)을 pane 만 예외로 두지 않는다.
 */
function PaneSlotSwitch({ side, family, name }: {
  side: Side;
  family: PeakWallFamilyId;
  name: string;
}) {
  const key = PANE_SLOT_KEY[side][family];
  const slotOn = useWindowIndicator((s) => s[key]);
  const paneOn = useWindowIndicator((s) => s.peakWallPaneEnabled);
  const inPane = paneOn && slotOn;
  const setSlot = useIndicatorActions().setPeakWallPaneSlotEnabled;
  return (
    <span className="flex justify-center">
      <ToggleSwitch
        size="sm"
        label={`강도 pane ${SIDE_LABEL[side]} ${name}`}
        title={PANE_FAMILY_HINT[family]}
        checked={inPane}
        onClick={() => setSlot(side, family, !inPane)}
        data-testid={`settings-toggle-${key}`}
      />
    </span>
  );
}

// ── ③ 후보 기준 ───────────────────────────────────────────────────────────

/** 표시 개수 pref 키 — `AllPrice` 가 체결된 벽이다(ADR-0084 화석 이름, 개명 금지). */
const RANK_KEY: Record<Side, Record<PeakWallFamilyId, NumericPrefKey>> = {
  ask: {
    Traded: 'askPeakAllPriceRankLimit',
    Unreached: 'askPeakUnreachedRankLimit',
    AllWall: 'askPeakAllWallRankLimit',
  },
  bid: {
    Traded: 'bidPeakAllPriceRankLimit',
    Unreached: 'bidPeakUnreachedRankLimit',
    AllWall: 'bidPeakAllWallRankLimit',
  },
};

const INTRA_MAX_KEY: Record<Side, ChartToggleKey> = {
  ask: 'askPeakIntraMax',
  bid: 'bidPeakIntraMax',
};

const RANK_OPTIONS = [1, 2, 3] as const;

/**
 * 흐름 리드아웃 — 이 단계가 **실제로 무엇을 하고 있는지**.
 *
 * ## 언제 뜨지 않는가 (셋 다 이유가 다르다)
 *
 * - **계열이 꺼져 있으면**: 개수가 0인 게 당연하다. 그 0을 보여 주면 "필터가 다
 *   걸렀다" 와 구별되지 않는다 — 애초에 안 그리기로 한 것이다.
 * - **엔트리가 없으면**: 차트가 발행하지 않았다는 뜻이다(일·주·월봉은 이 지표가
 *   적용되지 않는다). 부재가 신호이므로 0으로 대체하지 않는다.
 * - **눈이 꺼져 있으면**: 문구를 바꾼다. 세그먼트 계산은 눈(hidden)을 보지 않으므로
 *   (`usePeakWallRender` 의 불변식) "표시" 라고 쓰면 거짓말이 된다 — 세어 둔 것은
 *   후보이지 화면에 있는 것이 아니다.
 *
 * ## 합이 총수가 아니다
 *
 * `N + M ≠ 후보 총수` 가 정상이다 — 필터 뒤에 세그먼트 매핑에서 더 빠지는 것이
 * 있다(`buildPeakWallOverlayResult` 참조). 그래서 총수를 주장하지 않는다.
 */
function FlowReadout({ side, family }: { side: Side; family: PeakWallFamilyId }) {
  const ind = useWindowIndicator((s) => s);
  const { counts } = usePeakWallFilterState(side, family);
  const sideEnabled = side === 'ask' ? ind.askPeakEnabled : ind.bidPeakEnabled;
  const hidden = side === 'ask' ? ind.askPeakHidden : ind.bidPeakHidden;

  if (!sideEnabled || !familyLineEnabled(ind, side, family) || counts === undefined) return null;

  const alarming = counts.shown === 0 && counts.hiddenByFilter > 0;
  return (
    <div
      data-testid={`peak-wall-readout-${side}-${family}`}
      className={`mb-1.5 rounded-md px-2.5 py-1.5 text-2xs tabular-nums ${
        alarming ? 'bg-tint-warn text-warn' : 'bg-bg-subtle text-fg-dim'
      }`}
    >
      {hidden
        ? `숨김 — 후보 ${counts.shown}개 · ${counts.hiddenByFilter}개 필터로 제외`
        : `지금 ${counts.shown}개 표시 · ${counts.hiddenByFilter}개 필터로 숨김`}
      {/* 경보는 **줄을 바꾼다** — 같은 줄에 이으면 두 문장이 붙어 하나로 읽힌다(실측). */}
      {alarming && <span className="mt-0.5 block font-semibold">후보가 전부 필터에 걸렸습니다</span>}
    </div>
  );
}

/**
 * 켜져 있는 후보 필터 수 — **`N/2` 로 적는다**.
 *
 * 필터 둘의 공장값이 **둘 다 켜짐**이라 손대지 않은 칸은 2로 시작한다. 종전 깔때기는
 * 맨숫자 `2` 였는데, 그러면 "내가 뭘 많이 켜 뒀나" 로 읽힌다 — 실제 뜻은 **기본이
 * 최대**다. 분모를 함께 적으면 그 극성이 숫자 안에 들어온다.
 */
function FilterCount({ side, family }: { side: Side; family: PeakWallFamilyId }) {
  const { activeFilterCount } = usePeakWallFilterState(side, family);
  const total = peakWallFamilyToggleKeys(side, family, 'filter').length;
  return (
    <span
      title={`후보 필터 ${activeFilterCount}개 작동 중 (전체 ${total}개 — 기본이 최대)`}
      className="text-2xs tabular-nums text-fg-dim"
    >
      필터 {activeFilterCount}/{total}
    </span>
  );
}

function FilterStage({ side, family }: { side: Side; family: PeakWallFamilyId }) {
  const prefs = useScopedChartPrefs();
  const { setNumericPref, setToggle } = useChartPrefActions();
  const familyName = PEAK_WALL_FAMILIES.find((f) => f.id === family)?.name ?? family;
  const rankKey = RANK_KEY[side][family];
  const intraMaxKey = INTRA_MAX_KEY[side];

  return (
    <Stage n={3} title="후보 기준" hint={familyName} right={<FilterCount side={side} family={family} />}>
      <FlowReadout side={side} family={family} />

      <div className="flex items-center justify-between gap-3 py-1">
        <span className="text-sm text-fg">표시 개수 상한</span>
        <span
          role="group"
          aria-label={`${SIDE_LABEL[side]} ${familyName} 표시 개수`}
          className="inline-flex shrink-0 overflow-hidden rounded-md bg-bg-subtle p-px"
        >
          {RANK_OPTIONS.map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={prefs[rankKey] === option}
              onClick={() => setNumericPref(rankKey, option)}
              className={`w-5 rounded-sm py-0.5 text-2xs tabular-nums transition-colors ${
                prefs[rankKey] === option
                  ? 'bg-tint-selection font-semibold text-accent'
                  : 'text-fg-dim hover:text-fg'
              }`}
            >
              {option}
            </button>
          ))}
        </span>
      </div>

      {/* 라벨·설명·기본값은 레지스트리가 그리고, MA 기간 입력은 `enabledBy` 로 각 필터
          토글 아래에 자동으로 따라붙는다. 손으로 배치하면 레지스트리와 갈린다. */}
      <IndicatorPrefRows toggleKeys={peakWallFamilyToggleKeys(side, family, 'filter')} />
      {/* 두 필터가 순차 적용이라 교집합이라는 사실이 화면에 없으면, 하나만 풀고서
          "왜 아직도 안 보이지" 가 된다. */}
      <p className="py-1.5 text-2xs text-fg-dim">
        두 기준은 교집합으로 걸립니다 — 둘 다 통과한 벽만 그려집니다.
      </p>

      {/* 방향 공용 — 계열이 아니라 **방향**의 것이다. 배지가 그 스코프를 말한다
          (단계 안에 있으니 위치만으로는 계열의 것으로 읽힌다). */}
      <SettingsRow
        testId="peak-wall-intra-max-row"
        label={(
          <span className="flex items-center gap-1.5">
            분봉 내 최댓값 기준
            <span className="rounded-full border border-border-strong px-1 py-px text-2xs text-fg-dim">
              계열 공용
            </span>
          </span>
        )}
        description="과거 거래일에만 효과 · 「미도달 벽」에는 무효(양 carrier 가 같은 값)"
      >
        <ToggleSwitch
          label={`${SIDE_LABEL[side]} 분봉 내 최댓값 기준`}
          checked={prefs[intraMaxKey]}
          onClick={() => setToggle(intraMaxKey, !prefs[intraMaxKey])}
          data-testid={`settings-toggle-${intraMaxKey}`}
        />
      </SettingsRow>
    </Stage>
  );
}

// ── ④ 표현 ────────────────────────────────────────────────────────────────

/** 표면 다섯의 두 갈래 — 캔들 위에 그리는 것과 랭킹에 참여하는 것. 종전엔 「어디에」
 *  아래 평평한 다섯 형제라 성격이 다른 둘이 섞여 있었다. */
const ON_CANDLE_AXES = ['HorizontalLine', 'TimeMarker', 'Label'] as const;

function SurfaceStage({ side, family }: { side: Side; family: PeakWallFamilyId }) {
  const ind = useWindowIndicator((s) => s);
  const actions = useIndicatorActions();
  const familyName = PEAK_WALL_FAMILIES.find((f) => f.id === family)?.name ?? family;
  const style = familyStyle(ind, actions, side, family);
  const surfaces = peakWallFamilyToggleKeys(side, family, 'surface');
  const onCandle = surfaces.filter((key) => ON_CANDLE_AXES.some((axis) => key.endsWith(`${axis}Enabled`)));
  const ranking = surfaces.filter((key) => !onCandle.includes(key));

  return (
    <Stage n={4} title="표현" hint={`${familyName}을 어디에 그리나`}>
      <div className="flex items-center gap-2 py-1">
        <span className="text-sm text-fg">선</span>
        <MAStylePicker
          color={style.color}
          lineWidth={style.lineWidth}
          onChange={style.onChange}
          label={`${SIDE_LABEL[side]} ${familyName}`}
        />
      </div>

      <div className="mt-2 text-xs font-semibold uppercase text-fg-dim">캔들 위</div>
      <IndicatorPrefRows toggleKeys={onCandle} />

      <div className="mt-3 text-xs font-semibold uppercase text-fg-dim">랭킹 참여</div>
      <IndicatorPrefRows toggleKeys={ranking} />
    </Stage>
  );
}

// ── ⑤ 강도 pane ───────────────────────────────────────────────────────────

/**
 * 방향까지 공용 — 한 pane 을 양방향 계단이 함께 쓰므로 pane 자체의 상태는 하나뿐이다.
 * 그 사실을 배지와 **마지막 단계**라는 위치로 함께 말한다.
 *
 * ## 슬롯 6칸은 여기 없다 (2026-08-27)
 *
 * 종전엔 이 단계가 마스터 아래 **방향 2 × 계열 3 매트릭스**를 들고 있었다. 그 표는
 * 두 방향을 한눈에 보여 주는 대신, 패널의 나머지가 쓰는 문법(단계 번호 = 스코프 깊이)
 * 을 저 혼자 어겼다 — ① 에서 방향을 이미 골랐는데 ⑤ 만 다시 방향을 물었다.
 *
 * 칸을 계열 행(②)으로 내리면 그 물음이 사라진다: 고른 방향의 세 계열이 각자 「pane 에
 * 추가」 스위치를 들고, 반대 방향은 ① 에서 방향을 바꿔 닿는다. 계열의 두 표면(캔들 선 ·
 * 강도 pane)이 **같은 줄에서 마주 보는** 것이 덤으로 따라온다.
 *
 * **버린 것**은 여섯 칸의 동시 조망이다. 그 대가로 이 단계가 요약 줄을 든다 — 지금
 * pane 에 무엇이 들어 있는지를 방향 구분 없이 한 줄로 적는다.
 *
 * ## pane 을 쪼개지 않는다
 *
 * 계열마다 스위치가 생겨도 pane 은 여전히 하나다(`PEAK_WALL_SPEC` 도 하나).
 * 계단이 전부 같은 y 축(잔량)이라 겹쳐 읽는 것이 의미가 있고, pane 을 늘리면 화면
 * 부동산만 먹는다.
 *
 * ## 캔들 선 토글과 독립이다
 *
 * 종전엔 pane 이 `{side}Peak{Family}LineEnabled` 를 따라갔다. 두 표면이 답하는 질문이
 * 다른데(캔들 = 「그날 어디에 벽이 있었나」, pane = 「그 벽이 언제 얼마나 자랐나」)
 * 스위치가 하나라, 한쪽만 보는 조합이 원리적으로 불가능했다. 한 줄에 나란히 앉은
 * 지금도 두 스위치는 서로를 건드리지 않는다.
 */
function PaneStage() {
  const paneEnabled = useWindowIndicator((s) => s.peakWallPaneEnabled);
  const actions = useIndicatorActions();
  return (
    <Stage n={5} title="강도 pane">
      {/* `ToggleRow` 대신 직접 조립하는 이유: 저쪽은 라벨 하나를 표시 텍스트와 스위치
          aria-label 로 겸해 쓰므로 문자열이어야 한다. 여기는 배지가 붙은 노드라,
          보이는 라벨과 읽히는 이름을 갈라 준다. */}
      <SettingsRow
        testId="peak-wall-pane-row"
        label={(
          <span className="flex items-center gap-2">
            최대벽 강도 pane
            <span className="rounded-full border border-border-strong px-1.5 py-px text-2xs font-semibold uppercase text-fg-dim">
              매도 · 매수 공용
            </span>
          </span>
        )}
        description="② 계열에서 「pane」 스위치를 켠 계단을 차트 아래 별도 pane 하나에 그립니다. 매도·매수가 그 pane 을 공유합니다."
      >
        <ToggleSwitch
          label="최대벽 강도 pane"
          checked={paneEnabled}
          onClick={() => actions.setPeakWallPaneEnabled(!paneEnabled)}
          data-testid="settings-toggle-peakWallPaneEnabled"
        />
      </SettingsRow>

      <PaneSlotSummary gateOpen={paneEnabled} />
    </Stage>
  );
}

/**
 * 지금 pane 에 들어 있는 것 — 매트릭스가 사라지며 잃은 **조망**을 대신한다.
 *
 * 방향을 함께 적는 이유가 여기에 있다: ② 의 스위치는 고른 방향의 것이라, 반대 방향에
 * 켜 둔 칸이 화면에서 완전히 침묵하면 「분명 껐는데 계단이 남아 있다」가 된다. 이
 * 줄이 그 반대쪽을 계속 말해 준다(① 의 카드가 각자 개수를 드는 것과 같은 장치).
 *
 * 마스터가 꺼져 있으면 dim 하되 **문구는 그대로** 둔다 — 슬롯 값은 보존되므로
 * 다시 켰을 때 무엇이 돌아오는지가 미리 보인다. 그때 ② 의 스위치들은 전부 꺼진 것으로
 * 접히므로(`PaneSlotSwitch` 참조) 이 줄이 **보존된 값의 유일한 창구**다.
 */
function PaneSlotSummary({ gateOpen }: { gateOpen: boolean }) {
  const ind = useWindowIndicator((s) => s);
  const on = SIDES.flatMap((side) => PEAK_WALL_FAMILIES
    .filter((family) => ind[PANE_SLOT_KEY[side.id][family.id]])
    .map((family) => `${side.label} ${family.name}`));

  return (
    <p
      data-testid="peak-wall-pane-summary"
      className={`ml-4 mt-1 text-2xs text-fg-dim ${gateOpen ? '' : 'opacity-50'}`}
    >
      {on.length === 0
        ? '넣은 계단이 없습니다 — ② 계열의 「pane」 스위치로 넣습니다.'
        : `${on.length}칸: ${on.join(' · ')}`}
    </p>
  );
}

// ── 계열 좌표 접근자 ───────────────────────────────────────────────────────
//
// 키를 문자열로 조립(`` `${side}Peak${family}...` ``)하지 않는다 — 오타가 타입을
// 통과하고, 「그 상태가 어디서 읽히는가」를 grep 으로 못 찾게 된다. 종전
// `PeakWallMatrix` 의 표를 그대로 옮긴 것이다.

type IndicatorActions = ReturnType<typeof useIndicatorActions>;

function familyLineEnabled(ind: IndicatorSettings, side: Side, family: PeakWallFamilyId): boolean {
  if (family === 'Traded') return side === 'ask' ? ind.askPeakTradedLineEnabled : ind.bidPeakTradedLineEnabled;
  if (family === 'Unreached') return side === 'ask' ? ind.askPeakUnreachedLineEnabled : ind.bidPeakUnreachedLineEnabled;
  return side === 'ask' ? ind.askPeakAllWallLineEnabled : ind.bidPeakAllWallLineEnabled;
}

function setFamilyLineEnabled(
  actions: IndicatorActions,
  side: Side,
  family: PeakWallFamilyId,
  next: boolean,
): void {
  if (family === 'Traded') {
    if (side === 'ask') actions.setAskPeakTradedLineEnabled(next);
    else actions.setBidPeakTradedLineEnabled(next);
  } else if (family === 'Unreached') {
    if (side === 'ask') actions.setAskPeakUnreachedLineEnabled(next);
    else actions.setBidPeakUnreachedLineEnabled(next);
  } else if (side === 'ask') actions.setAskPeakAllWallLineEnabled(next);
  else actions.setBidPeakAllWallLineEnabled(next);
}

type FamilyStyle = {
  color: string;
  lineWidth: 1 | 2 | 3 | 4;
  onChange: (patch: { color?: string; lineWidth?: 1 | 2 | 3 | 4 }) => void;
};

function familyStyle(
  ind: IndicatorSettings,
  actions: IndicatorActions,
  side: Side,
  family: PeakWallFamilyId,
): FamilyStyle {
  if (family === 'Traded') {
    return side === 'ask'
      ? { color: ind.askPeakColor, lineWidth: ind.askPeakLineWidth, onChange: actions.setAskPeakStyle }
      : { color: ind.bidPeakColor, lineWidth: ind.bidPeakLineWidth, onChange: actions.setBidPeakStyle };
  }
  if (family === 'Unreached') {
    return side === 'ask'
      ? { color: ind.askPeakUnreachedColor, lineWidth: ind.askPeakUnreachedLineWidth, onChange: actions.setAskPeakUnreachedStyle }
      : { color: ind.bidPeakUnreachedColor, lineWidth: ind.bidPeakUnreachedLineWidth, onChange: actions.setBidPeakUnreachedStyle };
  }
  return side === 'ask'
    ? { color: ind.askPeakAllWallColor, lineWidth: ind.askPeakAllWallLineWidth, onChange: actions.setAskPeakAllWallStyle }
    : { color: ind.bidPeakAllWallColor, lineWidth: ind.bidPeakAllWallLineWidth, onChange: actions.setBidPeakAllWallStyle };
}
