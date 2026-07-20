import MAStylePicker from './MAStylePicker';
import { useWindowIndicator, useIndicatorActions } from '../workspace/windowView';

/** 단별 잔량 증감 상세 설정 — 유입/유출 색 + 최대 불투명도. */
export default function DepthDeltaConfig() {
  const inColor = useWindowIndicator((s) => s.depthDeltaInColor);
  const outColor = useWindowIndicator((s) => s.depthDeltaOutColor);
  const maxOpacity = useWindowIndicator((s) => s.depthDeltaMaxOpacity);
  const setStyle = useIndicatorActions().setDepthDeltaStyle;
  return (
    <div>
      <h3 className="text-fg text-base font-medium pb-1">
        단별 잔량 증감 <span aria-hidden="true" className="text-fg-dimmer text-sm">ⓘ</span>
      </h3>
      <p className="text-fg-dim text-xs mb-3">
        연속된 호가 스냅샷을 같은 가격끼리 비교해, 각 호가 단에 잔량이 얼마나 새로 들어오고
        빠졌는지를 캔들 뒤 색상으로 표시합니다. 매수·매도 구분이 아니라 증가(유입)·감소(유출)
        기준이며, 강도는 화면에 보이는 범위의 최대 증감 기준으로 정규화됩니다. 분봉 차트에서만
        표시됩니다.
      </p>
      <p className="text-fg-dim text-xs mb-3">
        지금 이 순간의 증감은 실시간 호가로, 과거 구간(오늘 이전 시간·지난 날짜)은 수집된
        스냅샷(약 10초 간격)으로 계산합니다. 과거 구간의 유입·유출은 표본 간격 안에서 생겼다
        사라진 물량이 빠진 하한값이고, 순증감은 간격과 무관하게 정확합니다. 잔량 감소에는
        체결 소진과 취소·정정이 함께 섞여 있습니다 — 유출이 곧 취소를 뜻하지는 않습니다.
      </p>
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <span className="text-sm text-fg">유입 색상</span>
          <MAStylePicker
            color={inColor}
            lineWidth={2}
            onChange={(p) => { if (p.color) setStyle({ inColor: p.color }); }}
            label="유입 색상"
          />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm text-fg">유출 색상</span>
          <MAStylePicker
            color={outColor}
            lineWidth={2}
            onChange={(p) => { if (p.color) setStyle({ outColor: p.color }); }}
            label="유출 색상"
          />
        </div>
      </div>
      <div className="border-b border-border my-3" />
      <div>
        {/* id 는 히트맵(dh-opacity)과 달라야 한다 — 두 섹션이 같은 DOM 에 있을 때
            htmlFor 연결이 깨진다. */}
        <label htmlFor="dd-opacity" className="text-sm text-fg mb-2 block">
          최대 불투명도 <span className="text-fg-dim text-xs">{Math.round(maxOpacity * 100)}%</span>
        </label>
        <input
          id="dd-opacity"
          type="range"
          min={0.2}
          max={1}
          step={0.05}
          value={maxOpacity}
          onChange={(e) => setStyle({ maxOpacity: Number(e.target.value) })}
          className="w-full"
        />
      </div>
    </div>
  );
}
