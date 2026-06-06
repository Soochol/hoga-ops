import { useState } from 'react';
import { ModalShell } from '../ui/ModalShell';

/**
 * 그룹 이름 하나를 입력받는 소형 다이얼로그 — 추가("그룹 추가하기")와 이름 변경
 * ("그룹 이름 변경")이 공유한다. mutation은 소유하지 않고 onSubmit으로 위임;
 * 성공(resolve) 시에만 닫히고, 실패하면 열린 채로 남아 재시도할 수 있다.
 * UI 카피는 전부 "그룹" — 도메인/API 계층(folder_id, createFolder 등)만
 * "folder"를 유지한다.
 */
export function GroupNameModal({ title, submitLabel, initialName = '', busy = false, onSubmit, onClose }: {
  title: string;
  submitLabel: string;
  initialName?: string;
  busy?: boolean;
  onSubmit: (name: string) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState(initialName);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    try {
      await onSubmit(trimmed);
    } catch {
      // 실패 시 다이얼로그를 열어 둬 재시도 가능하게 하고, fire-and-forget 제출
      // 핸들러라 unhandled rejection으로 새지 않게 삼킨다(EntryPane.doMove 패턴).
      return;
    }
    onClose();
  };

  return (
    <ModalShell ariaLabel={title} title={title} width="w-[320px]" onClose={onClose}>
      <form onSubmit={submit}>
        <div className="px-4 py-4">
          <input autoFocus value={name} maxLength={40} placeholder="그룹 이름 입력"
            onChange={(e) => setName(e.target.value)}
            className="w-full px-3 py-2 rounded bg-bg-input text-sm border border-border placeholder:text-fg-dimmer" />
        </div>
        {/* footer — 다른 모달과 같은 border-t + 우측 버튼; 제출은 primary CTA(teal) */}
        <div className="flex justify-end gap-2 px-4 py-3 border-t border-border">
          <button type="button" onClick={onClose}
            className="px-3 py-1.5 text-sm bg-bg-input hover:bg-bg-input-hover text-fg rounded">
            닫기
          </button>
          <button type="submit" disabled={!name.trim() || busy}
            className="px-3 py-1.5 text-sm bg-accent text-accent-fg rounded hover:brightness-110 disabled:opacity-40">
            {submitLabel}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}
