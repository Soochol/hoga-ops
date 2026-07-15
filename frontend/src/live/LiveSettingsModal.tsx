import { ModalShell } from '../ui/ModalShell';
import LiveSettingsSections from './LiveSettingsSections';

type Props = {
  onClose: () => void;
  /** 'study'는 복기뷰 컨텍스트 — 캔들 소스가 디스크 온리로 고정이라 캔들 기준 라디오를 안내문으로 대체. */
  variant?: 'live' | 'study';
};

// Settings 모달과 동일한 크롬(2026-07-15): ModalShell로 백드롭·Escape·다이얼로그 토큰을
// 공유하고, 전폭 헤더 바·푸터를 없앤다. 섹션 제목·닫기 X는 LiveSettingsSections의 콘텐츠
// 헤더가 담당한다(title 미전달 → ModalShell 헤더 없음).
export default function LiveSettingsModal({ onClose, variant = 'live' }: Props) {
  return (
    <ModalShell
      ariaLabel="설정"
      width="w-[min(1040px,calc(100vw-48px))]"
      height="h-[min(820px,calc(100vh-48px))]"
      onClose={onClose}
    >
      <LiveSettingsSections variant={variant} onClose={onClose} />
    </ModalShell>
  );
}
