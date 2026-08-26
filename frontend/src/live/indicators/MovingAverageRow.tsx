import { useEffect, useState } from 'react';
import type { LiveMAConfig } from '../../state/livePage';
import { MA_PERIOD_MIN, MA_PERIOD_MAX } from '../../state/livePage';
import MAStylePicker from './MAStylePicker';
import MASourceSelect from './MASourceSelect';

type Props = {
  index: number;
  config: LiveMAConfig;
  canRemove: boolean;
  onChange: (patch: Partial<LiveMAConfig>) => void;
  onRemove: () => void;
  /** 좌측 라벨 override. 기본은 목록 안의 순번(`기간1`)이고, 인스턴스 하나만 편집하는
   *  팝오버는 순번이 의미가 없어 `길이` 같은 이름을 넘긴다.
   *
   *  aria-label 도 이 값을 따른다 — 설정 패널과 팝오버가 동시에 열려 있을 때 라벨이
   *  같으면 `getByRole('spinbutton', { name })` 이 둘을 잡아 테스트가 모호해진다. */
  periodLabel?: string;
};

/** 인스턴스 행의 열 트랙 — 라벨 / 색·선 / 기준가 / 기간 / 삭제.
 *
 *  **그리드는 행이 계속 소유한다.** 부모로 끌어올려 열 헤더와 한 그리드로 합치고
 *  싶겠지만, 이 행은 목록 밖에서도 단독으로 산다(`MaInstancePopover` 가 인스턴스
 *  하나만 편집할 때 그렇고, 그 팝오버의 폭 상수도 이 트랙의 최소폭에서 나왔다).
 *  합치는 순간 그 소비처가 트랙 없는 행을 그린다.
 *
 *  대신 **헤더가 같은 문자열을 import** 해서 열을 맞춘다 — 복사하면 갈린다. */
export const MA_ROW_GRID = 'grid grid-cols-[56px_auto_1fr_72px_24px] items-center gap-2';

export default function MovingAverageRow({
  index, config, canRemove, onChange, onRemove, periodLabel,
}: Props) {
  const label = periodLabel ?? `기간${index + 1}`;
  const [draft, setDraft] = useState<string>(String(config.period));
  useEffect(() => { setDraft(String(config.period)); }, [config.period]);

  const commit = () => {
    const t = draft.trim();
    const n = Number(t);
    if (
      t !== '' && Number.isFinite(n) && Number.isInteger(n)
      && n >= MA_PERIOD_MIN && n <= MA_PERIOD_MAX && n !== config.period
    ) {
      onChange({ period: n });
    } else {
      setDraft(String(config.period));
    }
  };

  return (
    // The per-slot enable toggle was removed in favour of the master
    // category checkbox in IndicatorPanel — see useLivePageStore.movingAverageEnabled.
    // Slot visibility is now controlled by add/remove, not per-slot toggle.
    <div className={`${MA_ROW_GRID} py-1.5`}>
      <div className="text-sm text-fg tabular-nums">{label}</div>
      <div className="flex items-center">
        <MAStylePicker
          color={config.color}
          lineWidth={config.lineWidth}
          onChange={(patch) => onChange(patch)}
        />
      </div>
      <MASourceSelect value={config.source} onChange={(s) => onChange({ source: s })} />
      <input
        type="number"
        role="spinbutton"
        min={MA_PERIOD_MIN}
        max={MA_PERIOD_MAX}
        step={1}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }}
        aria-label={`${label} 길이`}
        className="w-[72px] text-right text-sm bg-bg-input border border-border rounded-md px-2 py-1 tabular-nums"
      />
      {canRemove ? (
        <button
          type="button"
          aria-label="슬롯 삭제"
          onClick={onRemove}
          className="text-fg-dim hover:text-fg text-base leading-none"
        >
          ✕
        </button>
      ) : (
        <span aria-hidden="true" />
      )}
    </div>
  );
}
