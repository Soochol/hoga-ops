import { useLivePageStore, MA_SLOT_LIMIT } from '../../state/livePage';
import MovingAverageRow from './MovingAverageRow';

export default function MovingAverageConfig() {
  const configs = useLivePageStore((s) => s.movingAverages);
  const setMA = useLivePageStore((s) => s.setMovingAverage);
  const addMA = useLivePageStore((s) => s.addMovingAverage);
  const removeMA = useLivePageStore((s) => s.removeMovingAverage);
  const atLimit = configs.length >= MA_SLOT_LIMIT;
  const canRemove = configs.length > 1;

  return (
    <div>
      <h3 className="text-fg text-base font-medium pb-1">
        이동평균선 <span aria-hidden="true" className="text-fg-dimmer text-sm">ⓘ</span>
      </h3>
      <p className="text-fg-dim text-xs mb-3">
        지난 n일 동안 주가 평균값을 이은 선
      </p>
      <div>
        {configs.map((cfg, i) => (
          <MovingAverageRow
            key={cfg.id}
            index={i}
            config={cfg}
            canRemove={canRemove}
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
