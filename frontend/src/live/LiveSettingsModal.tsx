import { ModalShell } from '../ui/ModalShell';
import LiveSettingsSections from './LiveSettingsSections';
import { WORKSPACE_DRAWER_WIDTH_CLASS } from './workspaceDrawer';

type Props = {
  onClose: () => void;
  /** 'study'는 복기뷰 컨텍스트 — 캔들 소스가 디스크 온리로 고정이라 캔들 기준 라디오를 안내문으로 대체. */
  variant?: 'live' | 'study';
};

// 지표 드로어와 통일된 우측 드로어(side='right', ADR-0116): 왼쪽에 차트가 딤 너머로
// 남아 즉시 적용이 실시간 반영된다(예: 날짜 구분선 토글). 폭·앵커를 지표 드로어(760px)와
// 맞춰 툴바에서 보조지표↔설정을 오가도 패널이 흔들리지 않는다. 섹션 제목·닫기 X는
// LiveSettingsSections의 콘텐츠 헤더가 담당(title 미전달 → ModalShell 헤더 없음).
export default function LiveSettingsModal({ onClose, variant = 'live' }: Props) {
  return (
    <ModalShell
      ariaLabel="설정"
      side="right"
      width={WORKSPACE_DRAWER_WIDTH_CLASS}
      onClose={onClose}
    >
      <LiveSettingsSections variant={variant} onClose={onClose} />
    </ModalShell>
  );
}
