import { ModalShell } from '../ui/ModalShell';
import SettingsSections from './SettingsSections';
import { WORKSPACE_DRAWER_WIDTH_CLASS } from './workspaceDrawer';

type Props = {
  onClose: () => void;
  /** 'study'는 복기뷰 컨텍스트 — 「체결창」 nav 를 숨긴다(/live 워크스페이스 전용 창).
   *  데이터소스가 쓰던 분기는 삭제됐다(`DataSourceDetail` 헤더 주석). */
  variant?: 'live' | 'study';
};

// 지표 드로어와 통일된 우측 드로어(side='right', ADR-0116): 왼쪽에 차트가 딤 너머로
// 남아 즉시 적용이 실시간 반영된다(예: 날짜 구분선 토글). 폭·앵커를 지표 드로어(760px)와
// 맞춰 툴바에서 보조지표↔설정을 오가도 패널이 흔들리지 않는다. 섹션 제목·닫기 X는
// SettingsSections의 콘텐츠 헤더가 담당(title 미전달 → ModalShell 헤더 없음).
//
// 이름에서 `Live` 가 빠진 이유: 설정 표면이 하나로 합쳐지면서 전 라우트의 TopNav ⚙ 도
// 같은 크롬을 연다(App.tsx 가 ModalShell 을 직접 세운다). 이 컴포넌트는 이제 툴바
// 진입점(`/live`·`/study`)의 래퍼이지 「라이브 전용 설정」이 아니다.
export default function SettingsDrawer({ onClose, variant = 'live' }: Props) {
  return (
    <ModalShell
      ariaLabel="설정"
      side="right"
      width={WORKSPACE_DRAWER_WIDTH_CLASS}
      onClose={onClose}
    >
      <SettingsSections variant={variant} onClose={onClose} />
    </ModalShell>
  );
}
