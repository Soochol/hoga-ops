import { useLivePageStore, MA_SLOT_LIMIT } from '../../state/livePage';
import MovingAverageRow from './MovingAverageRow';
import ToggleRow from '../settings/ToggleRow';

/** 일봉 이동평균선 설정 페이지. 현재봉 MovingAverageConfig를 미러링하되 daily
 *  슬라이스를 쓴다. MovingAverageRow(prop-driven)를 그대로 재사용. ADR-0073. */
export default function DailyMovingAverageConfig() {
  const configs = useLivePageStore((s) => s.dailyMovingAverages);
  const enabled = useLivePageStore((s) => s.dailyMovingAverageEnabled);
  const setEnabled = useLivePageStore((s) => s.setDailyMovingAverageEnabled);
  const setMA = useLivePageStore((s) => s.setDailyMovingAverage);
  const addMA = useLivePageStore((s) => s.addDailyMovingAverage);
  const removeMA = useLivePageStore((s) => s.removeDailyMovingAverage);
  const atLimit = configs.length >= MA_SLOT_LIMIT;
  const canRemove = configs.length > 1;

  return (
    <div>
      <h3 className="text-fg text-base font-medium pb-1">
        일봉 이동평균선 <span aria-hidden="true" className="text-fg-dimmer text-sm">ⓘ</span>
      </h3>
      <p className="text-fg-dim text-xs mb-3">
        일봉 종가 기준 이평선을 분봉 차트에 투영 · 분봉 차트에서만 표시됩니다
      </p>
      <div className="mb-3">
        <ToggleRow
          label="일봉 MA 표시"
          description="분봉 차트 위에 일봉 종가 기준 이평선을 표시합니다."
          checked={enabled}
          onToggle={() => setEnabled(!enabled)}
          testId="settings-toggle-dailyMovingAverage"
        />
      </div>
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
