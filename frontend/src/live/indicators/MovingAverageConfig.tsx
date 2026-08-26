import { MA_SLOT_LIMIT } from '../../state/livePage';
import MovingAverageRow from './MovingAverageRow';
import { useWindowIndicator, useIndicatorActions } from '../workspace/windowView';

export default function MovingAverageConfig() {
  const configs = useWindowIndicator((s) => s.movingAverages);
  const setMA = useIndicatorActions().setMovingAverage;
  const addMA = useIndicatorActions().addMovingAverage;
  const removeMA = useIndicatorActions().removeMovingAverage;
  const atLimit = configs.length >= MA_SLOT_LIMIT;

  return (
    <div>
      <div>
        {configs.map((cfg, i) => (
          <MovingAverageRow
            key={cfg.id}
            index={i}
            config={cfg}
            canRemove
            onChange={(patch) => setMA(cfg.id, patch)}
            onRemove={() => removeMA(cfg.id)}
          />
        ))}
      </div>
      <button
        type="button"
        onClick={addMA}
        disabled={atLimit}
        className="mt-3 px-3 py-1.5 text-sm bg-bg-input hover:bg-bg-input-hover text-fg rounded disabled:opacity-50 disabled:cursor-not-allowed"
      >
        ⊕ 기간 추가
      </button>
    </div>
  );
}
