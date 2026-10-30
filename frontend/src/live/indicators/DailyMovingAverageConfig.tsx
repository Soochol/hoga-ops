import { MA_SLOT_LIMIT } from '../../state/livePage';
import { AppIcon } from '../../ui/AppIcon';
import MovingAverageRow from './MovingAverageRow';
import ToggleRow from '../settings/ToggleRow';
import { useWindowIndicator, useIndicatorActions } from '../workspace/windowView';

/** 일봉 이동평균선 설정 페이지. 현재봉 MovingAverageConfig를 미러링하되 daily
 *  슬라이스를 쓴다. MovingAverageRow(prop-driven)를 그대로 재사용. ADR-0073. */
export default function DailyMovingAverageConfig() {
  const configs = useWindowIndicator((s) => s.dailyMovingAverages);
  // 전체 눈과 개별 행은 같은 hidden 상태를 공유한다.
  const enabled = configs.some((c) => c.enabled && !c.hidden);
  const setAllEnabled = useIndicatorActions().setAllDailyMovingAveragesVisible;
  const setMA = useIndicatorActions().setDailyMovingAverage;
  const addMA = useIndicatorActions().addDailyMovingAverage;
  const removeMA = useIndicatorActions().removeDailyMovingAverage;
  const atLimit = configs.length >= MA_SLOT_LIMIT;

  return (
    <div>
      <div className="mb-3">
        <ToggleRow
          label="일봉 MA 표시"
          description="일봉 종가의 이동평균선을 분봉에 표시합니다."
          checked={enabled}
          onToggle={() => setAllEnabled(!enabled)}
          testId="settings-toggle-dailyMovingAverage"
        />
      </div>
      <div>
        {configs.length > 0 && <div className="ma-config-grid ma-config-heading"><span>표시</span><span>기간</span><span>기준가</span><span>색상 · 두께</span><span /></div>}
        {configs.map((cfg, i) => (
          <MovingAverageRow editorLayout
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
        className="ma-config-add inline-flex items-center gap-1 mt-3 px-3 py-1.5 text-sm bg-bg-input hover:bg-bg-input-hover text-fg rounded disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <AppIcon name="plus" size={12} />기간 추가
      </button>
    </div>
  );
}
