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
};

export default function MovingAverageRow({ index, config, canRemove, onChange, onRemove }: Props) {
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
    <div className="grid grid-cols-[56px_auto_1fr_72px_24px] items-center gap-2 py-1.5">
      <div className="text-sm text-fg tabular-nums">{`기간${index + 1}`}</div>
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
        aria-label={`기간${index + 1} 길이`}
        className="w-[72px] text-right text-sm bg-bg-input border border-border rounded-[4px] px-2 py-1 tabular-nums"
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
