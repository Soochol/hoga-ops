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
    <div className="grid grid-cols-[56px_36px_1fr_1fr_72px_24px] items-center gap-2 py-1.5">
      <div className="text-sm text-fg tabular-nums">{`기간${index + 1}`}</div>
      <button
        type="button"
        role="switch"
        aria-checked={config.enabled}
        aria-label={`기간${index + 1} 토글`}
        onClick={() => onChange({ enabled: !config.enabled })}
        className={
          config.enabled
            ? 'relative inline-flex h-5 w-9 items-center rounded-full bg-accent transition-colors'
            : 'relative inline-flex h-5 w-9 items-center rounded-full bg-bg-input-hover transition-colors'
        }
      >
        <span
          className={
            config.enabled
              ? 'inline-block h-4 w-4 rounded-full bg-accent-fg translate-x-[18px] transition-transform'
              : 'inline-block h-4 w-4 rounded-full bg-fg-dim translate-x-[2px] transition-transform'
          }
        />
      </button>
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
