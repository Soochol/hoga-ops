import {
  BROKER_LATE_ENTRY_SLOT_LIMIT,
  type BrokerLateEntryConfig as Instance,
  type BrokerLateEntrySideMode,
} from '../../state/livePage';
import ColorSwatchPicker from './ColorSwatchPicker';
import TimeOfDayInput from '../settings/TimeOfDayInput';
import { formatHhmm } from '../../util/tradingTime';
import { useWindowIndicator, useIndicatorActions } from '../workspace/windowView';

const SIDE_OPTIONS: Array<{ value: BrokerLateEntrySideMode; label: string }> = [
  { value: 'both', label: '둘다' },
  { value: 'buy', label: '매수만' },
  { value: 'sell', label: '매도만' },
];

function ColorRow({
  label,
  color,
  onChange,
}: {
  label: string;
  color: string;
  onChange: (color: string) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-16 text-sm text-fg">{label}</span>
      <ColorSwatchPicker label={label} color={color} onChange={onChange} />
    </div>
  );
}

/** 인스턴스 하나의 설정 블록 — 기준 시각·방향·색. 여러 개가 세로로 쌓인다. */
function InstanceBlock({
  instance,
  index,
  onChange,
  onRemove,
}: {
  instance: Instance;
  index: number;
  onChange: (patch: Partial<Omit<Instance, 'id'>>) => void;
  onRemove: () => void;
}) {
  // 여러 개일 때만 시각을 제목에 실어 구별한다 — 하나뿐이면 중복 정보다.
  const heading = `세트 ${index + 1} · ${formatHhmm(instance.startHHMM)}`;
  return (
    <div className="rounded-lg border border-border p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-medium text-fg">{heading}</span>
        <button
          type="button"
          aria-label={`${heading} 삭제`}
          onClick={onRemove}
          className="px-1 text-sm leading-none text-fg-dim transition-colors hover:text-fg"
        >
          ✕
        </button>
      </div>
      <div className="mb-3">
        <label className="flex items-center justify-between gap-3 text-sm text-fg">
          <span>기준 시각</span>
          <TimeOfDayInput
            hhmm={instance.startHHMM}
            onCommit={(startHHMM) => onChange({ startHHMM })}
            ariaLabel={`${heading} 기준 시각`}
          />
        </label>
      </div>
      <div className="mb-3">
        <div className="mb-1.5 text-xs text-fg-dim">표시 방향</div>
        <div className="inline-flex overflow-hidden rounded border border-border">
          {SIDE_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={instance.sideMode === option.value}
              className={`px-3 py-1 text-sm ${instance.sideMode === option.value ? 'bg-bg-input text-fg' : 'text-fg-dim hover:bg-bg-input'}`}
              onClick={() => onChange({ sideMode: option.value })}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <ColorRow
          label="매수 색상"
          color={instance.buyColor}
          onChange={(buyColor) => onChange({ buyColor })}
        />
        <ColorRow
          label="매도 색상"
          color={instance.sellColor}
          onChange={(sellColor) => onChange({ sellColor })}
        />
      </div>
    </div>
  );
}

/**
 * 신규 거래원 등장 설정 — **인스턴스 목록**이다(Phase 3 의 첫 배열 승격).
 *
 * 기준 시각을 달리한 두 세트(예: 09:30 · 14:00)를 동시에 띄우는 것이 이 지표의
 * 실사용 시나리오다. 시각을 바꿔도 재조회가 없어(#1595) 인스턴스를 늘려도 요청은
 * 하나 그대로다.
 */
export default function BrokerLateEntryConfig() {
  const instances = useWindowIndicator((s) => s.brokerLateEntries);
  const actions = useIndicatorActions();
  const atLimit = instances.length >= BROKER_LATE_ENTRY_SLOT_LIMIT;

  return (
    <div>
      <div className="flex flex-col gap-3">
        {instances.map((instance, i) => (
          <InstanceBlock
            key={instance.id}
            instance={instance}
            index={i}
            onChange={(patch) => actions.setBrokerLateEntry(instance.id, patch)}
            onRemove={() => actions.removeBrokerLateEntry(instance.id)}
          />
        ))}
      </div>
      <button
        type="button"
        onClick={actions.addBrokerLateEntry}
        disabled={atLimit}
        className="mt-3 rounded bg-bg-input px-3 py-1.5 text-sm text-fg hover:bg-bg-input-hover disabled:cursor-not-allowed disabled:opacity-50"
      >
        ⊕ 세트 추가
      </button>
    </div>
  );
}
