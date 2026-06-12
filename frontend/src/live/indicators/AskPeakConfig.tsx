import { useLivePageStore } from '../../state/livePage';
import MAStylePicker from './MAStylePicker';

/** 당일 매도 최대벽 상세 설정 — 선 색·두께(MAStylePicker 재활용). */
export default function AskPeakConfig() {
  const color = useLivePageStore((s) => s.askPeakColor);
  const lineWidth = useLivePageStore((s) => s.askPeakLineWidth);
  const setStyle = useLivePageStore((s) => s.setAskPeakStyle);
  return (
    <div>
      <h3 className="text-fg text-base font-medium pb-1">
        당일 매도 최대벽 <span aria-hidden="true" className="text-fg-dimmer text-sm">ⓘ</span>
      </h3>
      <p className="text-fg-dim text-xs mb-3">
        오늘 매도 10호가 중 한 단계에 가장 크게 걸렸던 물량의 가격에 수평선을 그립니다(연속거래 기준).
      </p>
      <div className="flex items-center gap-2">
        <span className="text-sm text-fg">선 스타일</span>
        <MAStylePicker color={color} lineWidth={lineWidth} onChange={setStyle} label="매도벽" />
      </div>
    </div>
  );
}
