import 'pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css';
import '../../../src/styles/global.css';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { Banner } from '../../../src/ui/Banner';
import { InlineState } from '../../../src/ui/DataSurface';
import { RailState } from '../../../src/ui/RailShell';
import { StatusChip } from '../../../src/ui/StatusChip';
import { ToastAction, ToastCard } from '../../../src/ui/toast/ToastCard';
import { useToastTimer } from '../../../src/ui/toast/useToastTimer';

// Isolated browser entry point using the production components and clock.
// eslint-disable-next-line react-refresh/only-export-components
function Notices() {
  const [visible, setVisible] = useState(true);
  const [undone, setUndone] = useState(false);
  const timer = useToastTimer({ visible, durationMs: 5000, onExpire: () => setVisible(false) });
  return <div className="space-y-3 p-3">
    <Banner kind="error">이미 이 그룹에 있습니다</Banner>
    <InlineState tone="warn">시드 필요 · 초기 데이터를 준비하세요</InlineState>
    <RailState tone="error">관심종목을 불러올 수 없습니다</RailState>
    <div className="flex flex-wrap gap-2"><StatusChip tone="warn">실시간 설정 반영 중</StatusChip><StatusChip tone="error" size="compact">차단</StatusChip></div>
    <ToastCard visible role="status" ariaLabel="부분 성공 알림" variant="warn" title="저장은 완료했지만 수집 요청에 실패했습니다"
      actions={<ToastAction>수집 다시 시도</ToastAction>}>관심 종목에 저장됨 · 빠진 기간 수집 필요</ToastCard>
    <ToastCard visible={visible} role="status" ariaLabel="실행 취소 알림" progress={timer.progress} {...timer.interactionProps}
      onDismiss={() => setVisible(false)} action={{ label: '실행 취소', onClick: () => { setUndone(true); setVisible(false); } }}>
      <span className="text-sm">그림 5개 삭제됨</span>
    </ToastCard>
    {undone && <p role="status">그림을 복원했습니다</p>}
    <button type="button" onClick={() => setVisible(true)}>알림 표시</button>
  </div>;
}
export function mount() {
  const host = document.createElement('div');
  document.body.append(host);
  flushSync(() => createRoot(host).render(<Notices />));
}
