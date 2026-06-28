import { useEffect } from 'react';
import LiveSettingsSections from './LiveSettingsSections';

type Props = {
  onClose: () => void;
};

export default function LiveSettingsModal({ onClose }: Props) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="설정"
      onClick={onClose}
      className="fixed inset-0 z-[60] grid place-items-center bg-black/45"
    >
      <div
        data-testid="live-settings-modal-shell"
        onClick={(event) => event.stopPropagation()}
        className="grid h-[min(820px,calc(100vh-48px))] w-[min(1040px,calc(100vw-48px))] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden rounded-lg border border-border bg-bg-card shadow-[0_24px_80px_rgba(0,0,0,0.45)]"
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-base font-medium text-fg">설정</h2>
          <button type="button" aria-label="닫기" onClick={onClose} className="text-lg leading-none text-fg-dim hover:text-fg">
            ✕
          </button>
        </div>
        <LiveSettingsSections />
        <div className="flex justify-end border-t border-border px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-border bg-bg-input px-3 py-1.5 text-sm text-fg hover:bg-bg-input-hover"
          >
            닫기
          </button>
        </div>
      </div>
    </div>
  );
}
