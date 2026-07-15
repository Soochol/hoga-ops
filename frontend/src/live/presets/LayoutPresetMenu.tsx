import { useCallback, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useDismissablePopover } from '../../util/useDismissablePopover';
import { useClampedFixedPosition } from '../../util/useClampedFixedPosition';
import { useLiveLayoutStore } from '../../state/liveLayout';
import { IconToolbarButton } from '../../ui/WorkspaceShell';
import { useLiveLayoutPresets, useLiveLayoutPresetMutations } from './useLiveLayoutPresets';
import {
  applyPresetPayload,
  capturePresetPayload,
  defaultPresetPayload,
} from './layoutPresetSnapshot';

/**
 * /live 레이아웃 프리셋 드롭다운 (ADR-0114 §4). LiveToolbar 전용(StudyPage 는
 * LiveChartActionButtons 만 import 하므로 자동으로 /live 스코프).
 */
export function LayoutPresetMenu() {
  const [open, setOpen] = useState(false);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const [saveAsName, setSaveAsName] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => {
    setOpen(false);
    setSaveAsName(null);
    setPendingDelete(null);
    setError(null);
  }, []);
  // 저장/이름변경/삭제 실패 시 메뉴를 닫지 않고 에러를 표면화 — study-views 패턴.
  const failWith = (fallback: string) => (e: unknown) =>
    setError(e instanceof Error ? e.message : fallback);
  useDismissablePopover(open, wrapRef, close);
  const { ref: menuPositionRef, left, top } = useClampedFixedPosition<HTMLDivElement>(
    anchorRect?.left ?? 0,
    anchorRect ? anchorRect.bottom + 4 : 0,
  );

  const { data } = useLiveLayoutPresets();
  const { create, update, remove } = useLiveLayoutPresetMutations();
  const lastAppliedPresetId = useLiveLayoutStore((s) => s.lastAppliedPresetId);
  const presets = data?.presets ?? [];
  const activePreset = presets.find((p) => p.id === lastAppliedPresetId) ?? null;

  const toggle = () => {
    setAnchorRect(wrapRef.current?.getBoundingClientRect() ?? null);
    setOpen((prev) => !prev);
  };

  const apply = (id: string) => {
    const preset = presets.find((p) => p.id === id);
    if (!preset) return;
    applyPresetPayload(preset.payload, preset.id);
    close();
  };

  const saveCurrent = () => {
    if (!activePreset) return;
    setError(null);
    update.mutate(
      { id: activePreset.id, body: { name: activePreset.name, payload: capturePresetPayload() } },
      { onSuccess: () => close(), onError: failWith('프리셋 저장에 실패했습니다.') },
    );
  };

  const confirmSaveAs = () => {
    const name = (saveAsName ?? '').trim();
    if (!name) return;
    setError(null);
    create.mutate(
      { name, payload: capturePresetPayload() },
      {
        onSuccess: (row) => {
          useLiveLayoutStore.getState().setLastAppliedPresetId(row.id);
          close();
        },
        onError: failWith('프리셋 저장에 실패했습니다.'),
      },
    );
  };

  const resetDefault = () => {
    applyPresetPayload(defaultPresetPayload(), null);
    close();
  };

  const menu = open && anchorRect ? (
    <div
      ref={menuPositionRef}
      role="menu"
      aria-label="레이아웃 프리셋"
      data-testid="layout-preset-menu"
      onMouseDown={(e) => e.stopPropagation()}
      className="min-w-56 rounded border border-border bg-bg-card py-1 shadow-overlay z-50"
      style={{ position: 'fixed', left, top }}
    >
      {error && (
        <div data-testid="layout-preset-error" role="alert" className="px-3 py-1.5 text-xs text-danger">
          {error}
        </div>
      )}
      {presets.length === 0 && (
        <div className="px-3 py-1.5 text-xs text-fg-dimmer">저장된 프리셋이 없습니다</div>
      )}
      {presets.map((preset) => (
        <div key={preset.id} className="flex items-center gap-1 px-1">
          <button
            type="button"
            role="menuitem"
            data-testid={`layout-preset-apply-${preset.id}`}
            onClick={() => apply(preset.id)}
            className={`flex-1 truncate rounded px-2 py-1.5 text-left text-xs hover:bg-bg-input-hover ${
              preset.id === lastAppliedPresetId ? 'text-accent' : 'text-fg-dim'
            }`}
          >
            {preset.name}
          </button>
          {pendingDelete === preset.id ? (
            <button
              type="button"
              data-testid={`layout-preset-confirm-delete-${preset.id}`}
              onClick={() => {
                setError(null);
                remove.mutate(preset.id, { onError: failWith('프리셋 삭제에 실패했습니다.') });
                setPendingDelete(null);
              }}
              className="rounded px-2 py-1 text-[11px] text-error hover:bg-tint-error"
            >
              삭제?
            </button>
          ) : (
            <button
              type="button"
              aria-label={`${preset.name} 삭제`}
              data-testid={`layout-preset-delete-${preset.id}`}
              onClick={() => setPendingDelete(preset.id)}
              className="flex h-6 w-6 items-center justify-center rounded text-fg-dimmer hover:bg-bg-input-hover hover:text-fg"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                <path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13" />
              </svg>
            </button>
          )}
        </div>
      ))}

      <div className="my-1 border-t border-border" />

      <button
        type="button"
        role="menuitem"
        data-testid="layout-preset-save-current"
        onClick={saveCurrent}
        disabled={!activePreset}
        className="block w-full px-3 py-1.5 text-left text-xs text-fg-dim hover:bg-bg-input-hover disabled:opacity-40 disabled:hover:bg-transparent"
      >
        현재 레이아웃 저장
      </button>

      {saveAsName === null ? (
        <button
          type="button"
          role="menuitem"
          data-testid="layout-preset-save-as-open"
          onClick={() => setSaveAsName('')}
          className="block w-full px-3 py-1.5 text-left text-xs text-fg-dim hover:bg-bg-input-hover"
        >
          새 프리셋으로 저장…
        </button>
      ) : (
        <div className="flex items-center gap-1 px-2 py-1">
          <input
            autoFocus
            value={saveAsName}
            data-testid="layout-preset-save-as-input"
            onChange={(e) => setSaveAsName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') confirmSaveAs(); }}
            placeholder="프리셋 이름"
            className="h-7 min-w-0 flex-1 rounded border border-border bg-bg-input px-2 text-xs text-fg outline-none focus:border-accent"
          />
          <button
            type="button"
            data-testid="layout-preset-save-as-confirm"
            onClick={confirmSaveAs}
            className="rounded px-2 py-1 text-[11px] text-accent hover:bg-bg-input-hover"
          >
            저장
          </button>
        </div>
      )}

      <button
        type="button"
        role="menuitem"
        data-testid="layout-preset-reset"
        onClick={resetDefault}
        className="block w-full px-3 py-1.5 text-left text-xs text-fg-dim hover:bg-bg-input-hover"
      >
        기본 레이아웃으로 초기화
      </button>
    </div>
  ) : null;

  return (
    <div ref={wrapRef} className="relative">
      <IconToolbarButton
        data-testid="layout-preset-button"
        onClick={toggle}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="레이아웃 프리셋"
        icon={(
          <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="7" height="7" rx="1" />
            <rect x="14" y="3" width="7" height="7" rx="1" />
            <rect x="3" y="14" width="7" height="7" rx="1" />
            <rect x="14" y="14" width="7" height="7" rx="1" />
          </svg>
        )}
      >
        <span>{activePreset ? activePreset.name : '레이아웃'}</span>
      </IconToolbarButton>
      {menu && createPortal(menu, document.body)}
    </div>
  );
}
