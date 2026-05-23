import { useEffect, useState } from 'react';
import { useTabsStore } from '../state/tabs';

type Props = {
  onClose: () => void;
};

type Category = 'chart';

/**
 * Centered modal overlay for chart settings. First category "차트" hosts the
 * Auction Window masking toggle; future categories slot in alongside without
 * a layout rewrite (sidebar + content split).
 *
 * Close paths: Escape key, backdrop click, header ✕, footer 닫기.
 * Toggle changes persist immediately to the per-tab prefs (no save button) —
 * mirrors CursorSidebar's volumeProfileMode live-write pattern.
 */
export default function SettingsModal({ onClose }: Props) {
  const [category, setCategory] = useState<Category>('chart');
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const auctionWindowMask = useTabsStore(
    (s) => s.getPrefs(activeTabId).auctionWindowMask,
  );
  const setAuctionWindowMask = useTabsStore((s) => s.setAuctionWindowMask);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="설정"
      onClick={onClose}
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60]"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-bg-card border border-border-strong rounded-[6px] shadow-[0_8px_24px_rgba(0,0,0,0.4)] w-[640px] max-w-[90vw] flex flex-col"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h2 className="text-fg text-base font-medium">설정</h2>
          <button
            type="button"
            aria-label="닫기"
            onClick={onClose}
            className="text-fg-dim hover:text-fg text-lg leading-none"
          >
            ✕
          </button>
        </div>

        {/* Body: sidebar + content */}
        <div className="flex">
          <nav className="w-[180px] py-2 border-r border-border" aria-label="설정 카테고리">
            <button
              type="button"
              onClick={() => setCategory('chart')}
              aria-pressed={category === 'chart'}
              className={
                category === 'chart'
                  ? 'block w-full text-left px-4 py-2 text-sm bg-bg-input text-fg font-medium border-l-2 border-accent'
                  : 'block w-full text-left px-4 py-2 text-sm text-fg-dim hover:bg-bg-input-hover hover:text-fg'
              }
            >
              차트
            </button>
          </nav>

          <div className="flex-1 px-5 py-4">
            {category === 'chart' && (
              <>
                <h3 className="text-fg text-base font-medium pb-2 mb-2 border-b border-border">
                  차트
                </h3>
                <div className="flex items-center justify-between py-2">
                  <div className="flex-1 pr-4">
                    <div className="text-fg text-sm">호가비 동시호가 마스킹</div>
                    <div className="text-fg-dim text-xs mt-0.5">
                      15:20–15:30 KST 동시호가 구간의 호가비를 0 으로 처리합니다.
                    </div>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={auctionWindowMask}
                    aria-label="호가비 동시호가 마스킹"
                    onClick={() => setAuctionWindowMask(activeTabId, !auctionWindowMask)}
                    className={
                      auctionWindowMask
                        ? 'relative inline-flex h-5 w-9 items-center rounded-full bg-accent transition-colors'
                        : 'relative inline-flex h-5 w-9 items-center rounded-full bg-bg-input-hover transition-colors'
                    }
                  >
                    <span
                      className={
                        auctionWindowMask
                          ? 'inline-block h-4 w-4 transform rounded-full bg-accent-fg translate-x-[18px] transition-transform'
                          : 'inline-block h-4 w-4 transform rounded-full bg-fg-dim translate-x-[2px] transition-transform'
                      }
                    />
                  </button>
                </div>
              </>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-end px-4 py-3 border-t border-border">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-sm bg-bg-input hover:bg-bg-input-hover text-fg rounded"
          >
            닫기
          </button>
        </div>
      </div>
    </div>
  );
}
