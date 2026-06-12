import { ModalShell } from '../ui/ModalShell';
import LiveSettingsSections from './LiveSettingsSections';

type Props = {
  onClose: () => void;
};

/**
 * 차트/보조지표/총잔량 급증/데이터소스 설정 모달. `IndicatorPanel`과 동일한 2단
 * (왼쪽 카테고리 nav + 오른쪽 상세) 레이아웃을 `LiveSettingsSections`로 렌더하고,
 * ModalShell(백드롭·Escape·✕·title)로 감싼다.
 */
export default function LiveSettingsModal({ onClose }: Props) {
  return (
    <ModalShell ariaLabel="설정" title="설정" onClose={onClose}>
      <LiveSettingsSections />
      <div className="flex justify-end px-4 py-3 border-t border-border">
        <button
          type="button"
          onClick={onClose}
          className="px-3 py-1.5 text-sm bg-bg-input hover:bg-bg-input-hover text-fg rounded"
        >
          닫기
        </button>
      </div>
    </ModalShell>
  );
}
