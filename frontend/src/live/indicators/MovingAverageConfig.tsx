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
      <h4 className="mb-3 text-sm font-medium text-fg">계산 · 선 스타일</h4>
      {/* 열 헤더 — 행과 **같은 트랙 문자열**을 써서 열이 맞는다. 슬롯이 넷씩
          쌓이면 가운데 셀렉트가 무엇을 고르는 것인지(기준가) 행만 봐서는 알 수
          없었다. 슬롯이 하나도 없으면 헤더도 뜨지 않는다 — 빈 표의 머리만 남는
          것은 설명이 아니라 잔해다. */}
      {configs.length > 0 && (
        <div className="ma-config-grid ma-config-heading"><span>표시</span><span>기간</span><span>기준가</span><span>색상 · 두께</span><span /></div>
      )}
      <div>
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
        className="ma-config-add mt-3 px-3 py-1.5 text-sm bg-bg-input hover:bg-bg-input-hover text-fg rounded disabled:opacity-50 disabled:cursor-not-allowed"
      >
        ⊕ 기간 추가
      </button>
    </div>
  );
}
