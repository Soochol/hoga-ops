/**
 * WorkspacePreviewPage — dev 전용 워크스페이스 프리뷰 셸 (ADR-0119 C2c-2c).
 *
 * 플립(C2c-2d) 전에 통합 툴바 + 캔버스 + 포커스 창 지표 드로어의 결합을
 * `/workspace-preview` 에서 도그푸딩하기 위한 조립. 플립 시 LivePage 가 같은
 * 조립을 셸로 갖게 되고 이 페이지·라우트는 제거된다.
 */
import { useState } from 'react';
import { WorkspaceCanvas } from './WorkspaceCanvas';
import { WorkspaceLiveToolbar } from './WorkspaceLiveToolbar';
import { WorkspaceIndicatorDrawer } from './WorkspaceIndicatorDrawer';
import LiveSettingsModal from '../LiveSettingsModal';

export function WorkspacePreviewPage() {
  const [indicatorsOpen, setIndicatorsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <div className="grid h-full" style={{ gridTemplateRows: 'auto minmax(0, 1fr)' }}>
      <WorkspaceLiveToolbar
        onOpenIndicators={() => setIndicatorsOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <WorkspaceCanvas />
      {indicatorsOpen && <WorkspaceIndicatorDrawer onClose={() => setIndicatorsOpen(false)} />}
      {settingsOpen && <LiveSettingsModal onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
