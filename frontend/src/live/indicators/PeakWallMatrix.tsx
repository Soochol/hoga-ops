import { useScopedChartPrefs, useChartPrefActions } from '../../state/chartPrefs';
import type { NumericPrefKey, ChartToggleKey } from '../../state/chartPrefs';
import { PEAK_WALL_FAMILIES, type PeakWallFamilyId } from '../../state/peakWallFamilyPrefs';
import { useWindowIndicator, useIndicatorActions } from '../workspace/windowView';
import { ToggleSwitch } from '../settings/SettingsRow';
import MAStylePicker from './MAStylePicker';

type Side = 'ask' | 'bid';
const SIDES: ReadonlyArray<{ id: Side; label: string }> = [
  { id: 'ask', label: '매도' },
  { id: 'bid', label: '매수' },
];

/** 계열 한 줄의 부제 — 셋의 **관계**(배타·포함)를 그 자리에서 말한다. */
const FAMILY_HINT: Record<PeakWallFamilyId, string> = {
  Traded: '체결이 그 가격을 쳤다',
  Unreached: '아직 안 닿았다 — 위와 배타',
  AllWall: '터치 무관 — 그날 최대 상위집합',
};

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

const RANK_OPTIONS = [1, 2, 3] as const;

/**
 * 1|2|3 세그먼트 — 트랙은 채우고 활성만 tint 로 든다.
 *
 * 종전 `PeakWallRankSelect` 는 테두리 + accent 채움이었는데, 2026-07-15 borderless
 * 통일 이후 이 앱의 세그먼트 정본은 `ui/PageShell` 의 `SegmentedControl`(트랙 배경 +
 * `tint-selection` 활성)이다. 매트릭스 셀 크기에 맞춘 소형판이고, 같은 시각 언어의
 * 소형 선례가 이미 있다(`market/marketCardBits`). 새 변종을 만들지 않는다.
 */
function RankSelect({
  familyName, value, onChange,
}: {
  familyName: string;
  value: number;
  onChange: (next: number) => void;
}) {
  return (
    <span
      role="group"
      aria-label={`${familyName} 표시 개수`}
      className="inline-flex shrink-0 overflow-hidden rounded-md bg-bg-subtle p-px"
    >
      {RANK_OPTIONS.map((option) => {
        const selected = value === option;
        return (
          <button
            key={option}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(option)}
            className={`w-[17px] rounded-[3px] py-0.5 text-2xs tabular-nums transition-colors ${
              selected ? 'bg-tint-selection font-semibold text-accent' : 'text-fg-dim hover:text-fg'
            }`}
          >
            {option}
          </button>
        );
      })}
    </span>
  );
}

/**
 * 당일 최대벽의 **방향 × 계열 매트릭스** — 열이 방향, 행이 계열.
 *
 * ## 왜 탭을 걷어냈나
 *
 * 매도|매수 서브탭은 **절반의 상태를 항상 숨겼다**. 두 방향이 완전한 미러라
 * (갈리는 것은 미도달 판정 기준과 MA 방향뿐) 나란히 두면 대칭이 그대로 보이고,
 * "매수 쪽은 지금 어떻더라" 를 확인하러 탭을 오갈 일이 없다.
 *
 * 그리고 그 탭이 **위치로 스코프를 말하는 규칙**을 계속 망가뜨렸다. 2026-08-25
 * 재구성은 "카드 안이면 그 계열, 밖이면 공통" 이라는 규칙을 세웠는데, 방향 공용
 * 항목(강도 pane)은 탭 **밖**이라는 또 다른 관례를 따로 만들어야 했다. 열/행/푸터
 * 세 자리가 있으면 그 관례들이 한 문법으로 합쳐진다:
 *
 * - **열 머리** = 그 방향 전체의 마스터
 * - **셀** = 그 방향 × 그 계열
 * - **푸터 행** = 방향별이지만 계열 공용(열 아래 정렬로 그 사실을 말한다)
 * - **매트릭스 밖** = 방향까지 공용(강도 pane — 여기가 아니라 상위가 그린다)
 */
export default function PeakWallMatrix({
  selected,
  onSelect,
}: {
  selected: { side: Side; family: PeakWallFamilyId };
  onSelect: (cell: { side: Side; family: PeakWallFamilyId }) => void;
}) {
  const ind = useWindowIndicator((s) => s);
  const actions = useIndicatorActions();
  const prefs = useScopedChartPrefs();
  const { setNumericPref, setToggle } = useChartPrefActions();

  const sideEnabled = (side: Side) => (side === 'ask' ? ind.askPeakEnabled : ind.bidPeakEnabled);
  const lineEnabled = (side: Side, family: PeakWallFamilyId): boolean => {
    if (family === 'Traded') return side === 'ask' ? ind.askPeakTradedLineEnabled : ind.bidPeakTradedLineEnabled;
    if (family === 'Unreached') return side === 'ask' ? ind.askPeakUnreachedLineEnabled : ind.bidPeakUnreachedLineEnabled;
    return side === 'ask' ? ind.askPeakAllWallLineEnabled : ind.bidPeakAllWallLineEnabled;
  };
  const setLineEnabled = (side: Side, family: PeakWallFamilyId, next: boolean) => {
    if (family === 'Traded') {
      if (side === 'ask') actions.setAskPeakTradedLineEnabled(next);
      else actions.setBidPeakTradedLineEnabled(next);
    } else if (family === 'Unreached') {
      if (side === 'ask') actions.setAskPeakUnreachedLineEnabled(next);
      else actions.setBidPeakUnreachedLineEnabled(next);
    } else if (side === 'ask') actions.setAskPeakAllWallLineEnabled(next);
    else actions.setBidPeakAllWallLineEnabled(next);
  };
  const styleOf = (side: Side, family: PeakWallFamilyId) => {
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
  };

  const hidden = (side: Side) => (side === 'ask' ? ind.askPeakHidden : ind.bidPeakHidden);
  const setHidden = (side: Side, next: boolean) => {
    if (side === 'ask') actions.setAskPeakHidden(next);
    else actions.setBidPeakHidden(next);
  };
  const intraMaxKey = (side: Side): ChartToggleKey => (side === 'ask' ? 'askPeakIntraMax' : 'bidPeakIntraMax');

  // 라벨 열은 부제("터치 무관 — 그날 최대 상위집합")가 두 줄을 넘지 않을 만큼만.
  const cols = 'grid grid-cols-[132px_minmax(0,1fr)_minmax(0,1fr)] gap-2 items-center';

  return (
    <div>
      {/* 열 머리 = 방향 마스터. 두 열을 다 끄면 지표 자체가 사라지므로(존재 판정이
          ask||bid) 그 전이에만 undo 토스트가 붙는다 — 매트릭스에서는 그 삭제가
          평범해 보이는 두 번의 클릭으로 도달한다. */}
      <div className={`${cols} pb-1.5`}>
        <span />
        {SIDES.map((side) => (
          <div key={side.id} className="flex items-center justify-between px-2">
            <span className="text-sm font-semibold text-fg">{side.label}</span>
            <ToggleSwitch
              size="sm"
              label={`${side.label} 최대벽 표시`}
              checked={sideEnabled(side.id)}
              onClick={() => actions.setPeakSideEnabledWithUndo(side.id, !sideEnabled(side.id))}
              data-testid={`settings-toggle-${side.id}PeakEnabled`}
            />
          </div>
        ))}
      </div>

      {PEAK_WALL_FAMILIES.map((family) => (
        <div key={family.id} className={`${cols} border-t border-border py-1`}>
          <div>
            <div className="text-sm font-medium text-fg">{family.name}</div>
            <div className="mt-px text-2xs text-fg-dim">{FAMILY_HINT[family.id]}</div>
          </div>
          {SIDES.map((side) => {
            const isSelected = selected.side === side.id && selected.family === family.id;
            const on = lineEnabled(side.id, family.id);
            const style = styleOf(side.id, family.id);
            return (
              // 셀 배경 클릭 = 선택. 안쪽 컨트롤은 각자 stopPropagation 없이도
              // 안전하다 — 선택은 **부가 효과가 없는** 표현 상태라, 스위치를 누르며
              // 함께 선택되는 것이 오히려 기대에 맞는다(그 칸을 만지고 있으니까).
              <div
                key={side.id}
                role="button"
                tabIndex={0}
                aria-pressed={isSelected}
                aria-label={`${side.label} ${family.name}`}
                onClick={() => onSelect({ side: side.id, family: family.id })}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' && event.key !== ' ') return;
                  event.preventDefault();
                  onSelect({ side: side.id, family: family.id });
                }}
                className={`flex cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1.5 transition-colors ${
                  isSelected ? 'bg-tint-selection' : 'hover:bg-bg-input-hover'
                } ${on ? '' : 'opacity-55'}`}
              >
                <ToggleSwitch
                  size="sm"
                  label={`${side.label} ${family.name}`}
                  checked={on}
                  onClick={() => setLineEnabled(side.id, family.id, !on)}
                  data-testid={`settings-toggle-${side.id}Peak${family.id}LineEnabled`}
                />
                <MAStylePicker
                  color={style.color}
                  lineWidth={style.lineWidth}
                  onChange={style.onChange}
                  label={`${side.label} ${family.name}`}
                />
                <RankSelect
                  familyName={`${side.label} ${family.name}`}
                  value={prefs[RANK_KEY[side.id][family.id]]}
                  onChange={(n) => setNumericPref(RANK_KEY[side.id][family.id], n)}
                />
              </div>
            );
          })}
        </div>
      ))}

      {/* ── 방향 공용 ────────────────────────────────────────────────────
          계열이 아니라 **방향**의 것이다. 열 아래에 정렬해 두면 그 스코프가 위치로
          읽힌다 — 카드 안/밖이라는 별도 관례가 필요 없다. */}
      <div className={`${cols} border-t border-border py-1.5`}>
        <div>
          <div className="text-sm font-medium text-fg">캔들 수평선</div>
          <div className="mt-px text-2xs text-fg-dim">레전드의 눈과 같은 설정</div>
        </div>
        {SIDES.map((side) => (
          <div key={side.id} className="px-2">
            <ToggleSwitch
              size="sm"
              label={`${side.label} 캔들 수평선`}
              checked={!hidden(side.id)}
              disabled={!sideEnabled(side.id)}
              onClick={() => setHidden(side.id, !hidden(side.id))}
              data-testid={`settings-toggle-${side.id}PeakCandleLine`}
            />
          </div>
        ))}
      </div>
      <div className={`${cols} border-t border-border py-1.5`}>
        <div>
          <div className="text-sm font-medium text-fg">분봉 내 최댓값 기준</div>
          <div className="mt-px text-2xs text-fg-dim">과거 거래일에만 효과</div>
        </div>
        {SIDES.map((side) => (
          <div key={side.id} className="px-2">
            <ToggleSwitch
              size="sm"
              label={`${side.label} 분봉 내 최댓값 기준`}
              checked={prefs[intraMaxKey(side.id)]}
              onClick={() => setToggle(intraMaxKey(side.id), !prefs[intraMaxKey(side.id)])}
              data-testid={`settings-toggle-${side.id}PeakIntraMax`}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
