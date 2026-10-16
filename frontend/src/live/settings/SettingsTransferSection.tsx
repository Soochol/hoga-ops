import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiCall } from '../../api/client';
import { ToolbarButton } from '../../ui/PageShell';
import { WORKSPACE_STORAGE_KEY } from '../../state/workspaceKeys';
import { SETTINGS_FILE_LIMIT, applySettings, exportSettings, parseSettingsArchive, type SettingsArchive } from '../../state/settingsTransfer';

function download(archive: SettingsArchive, label: string): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(archive, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url;
  link.download = `hoga-settings-${label}-${Date.now()}.json`; link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export default function SettingsTransferSection() {
  const file = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<SettingsArchive | null>(null);
  const [closedOthers, setClosedOthers] = useState(false);
  const [backupSaved, setBackupSaved] = useState(false);
  const [message, setMessage] = useState('');
  const health = useQuery({ queryKey: ['health'], queryFn: () => apiCall<{ version: string }>('/health'), staleTime: Infinity });
  const backup = () => exportSettings(localStorage, window.location.origin, health.data?.version ?? 'unknown');
  return <section className="space-y-3">
    <p className="text-xs text-fg-dim">이 브라우저의 창 배치·지표·차트 설정·그리기·테마를 다른 브라우저나 Electron으로 옮깁니다. 서버 데이터와 주문 상태는 포함하지 않습니다.</p>
    <div className="flex gap-2">
      <ToolbarButton onClick={() => { try { download(backup(), 'export'); setMessage('설정 파일을 저장하세요.'); } catch (error) { setMessage(String(error)); } }}>화면 설정 내보내기</ToolbarButton>
      <ToolbarButton onClick={() => file.current?.click()}>화면 설정 가져오기</ToolbarButton>
    </div>
    <input ref={file} type="file" accept="application/json,.json" className="hidden" aria-label="화면 설정 파일" onChange={async event => {
      const selected = event.target.files?.[0]; event.target.value = ''; setPending(null); setBackupSaved(false); setClosedOthers(false);
      if (!selected) return;
      try {
        if (selected.size > SETTINGS_FILE_LIMIT) throw new Error('설정 파일은 4MB 이하여야 합니다.');
        setPending(parseSettingsArchive(await selected.text())); setMessage('파일을 확인했습니다. 현재 설정의 백업을 저장한 뒤 적용하세요.');
      } catch (error) { setMessage(error instanceof Error ? error.message : '설정 파일을 읽지 못했습니다.'); }
    }} />
    {pending && <div className="space-y-2 text-xs">
      <p>원본: {pending.origin} · 버전 {pending.appVersion} · {Object.keys(pending.entries).length}개 항목</p>
      <p>적용 대상: {window.location.origin}. 같은 항목을 덮어쓰고 화면을 새로고침합니다.</p>
      <label className="flex gap-2 items-center"><input type="checkbox" checked={closedOthers} onChange={event => setClosedOthers(event.target.checked)} />이 서버의 다른 작업 창과 탭을 모두 닫았습니다.</label>
      <ToolbarButton onClick={() => { try { download(backup(), 'backup'); setMessage('다운로드가 완료된 뒤 백업 저장 확인을 선택하세요.'); } catch (error) { setMessage(String(error)); } }}>현재 설정 백업</ToolbarButton>
      <label className="flex gap-2 items-center"><input type="checkbox" checked={backupSaved} onChange={event => setBackupSaved(event.target.checked)} />백업 파일을 저장했습니다.</label>
      <ToolbarButton disabled={!closedOthers || !backupSaved} onClick={() => {
        try {
          const previous = sessionStorage.getItem(WORKSPACE_STORAGE_KEY);
          sessionStorage.removeItem(WORKSPACE_STORAGE_KEY);
          try { applySettings(localStorage, pending); }
          catch (error) { if (previous !== null) sessionStorage.setItem(WORKSPACE_STORAGE_KEY, previous); throw error; }
          window.location.reload();
        } catch (error) { setMessage(error instanceof Error ? error.message : '설정을 적용하지 못했습니다.'); }
      }}>설정 적용 후 새로고침</ToolbarButton>
    </div>}
    {message && <p role="status" className="text-xs text-fg-dim">{message}</p>}
  </section>;
}
