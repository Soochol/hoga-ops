import { useEffect } from 'react';
import MovingAverageConfig from './MovingAverageConfig';

type CategoryId = 'moving-average' | 'ichimoku' | 'bollinger' | 'supertrend' | 'volume-profile' | 'envelope' | 'williams';

const CATEGORIES: ReadonlyArray<{ id: CategoryId; label: string; active: boolean }> = [
  { id: 'moving-average', label: '이동평균선',  active: true  },
  { id: 'ichimoku',       label: '일목균형표',  active: false },
  { id: 'bollinger',      label: '볼린저밴드',  active: false },
  { id: 'supertrend',     label: '슈퍼트렌드',  active: false },
  { id: 'volume-profile', label: '매물대분석',  active: false },
  { id: 'envelope',       label: '엔벨로프',    active: false },
  { id: 'williams',       label: '윌리엄스 프랙탈', active: false },
];

type Props = {
  onClose: () => void;
};

export default function IndicatorPanel({ onClose }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="지표"
      onClick={onClose}
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60]"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-bg-card border border-border-strong rounded-[6px] shadow-[0_8px_24px_rgba(0,0,0,0.4)] w-[640px] max-w-[90vw] flex flex-col"
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h2 className="text-fg text-base font-medium">지표</h2>
          <button
            type="button"
            aria-label="닫기"
            onClick={onClose}
            className="text-fg-dim hover:text-fg text-lg leading-none"
          >
            ✕
          </button>
        </div>
        <div className="flex">
          <nav className="w-[180px] py-2 border-r border-border" aria-label="지표 카테고리">
            <div className="text-fg-dimmer text-xs uppercase tracking-wider px-4 pb-2">상단 지표</div>
            {CATEGORIES.map((c) => (
              <button
                key={c.id}
                type="button"
                disabled={!c.active}
                aria-pressed={c.active}
                className={
                  c.active
                    ? 'block w-full text-left px-4 py-2 text-sm bg-bg-input text-fg font-medium border-l-2 border-accent'
                    : 'block w-full text-left px-4 py-2 text-sm text-fg-dimmer opacity-50 cursor-not-allowed'
                }
                title={c.active ? undefined : '추후 지원 예정'}
              >
                {c.label}
              </button>
            ))}
          </nav>
          <div className="flex-1 px-5 py-4">
            <MovingAverageConfig />
          </div>
        </div>
        {/* Footer — mirrors SettingsModal pattern for cross-modal visual
            consistency. Top-right ✕ alone is not sufficient: users trained
            on the /replay 설정 modal expect a footer-anchored 닫기 button. */}
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
