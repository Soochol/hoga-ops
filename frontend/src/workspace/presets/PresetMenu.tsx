import { useCallback, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useDismissablePopover } from '../../util/useDismissablePopover';
import { useClampedFixedPosition } from '../../util/useClampedFixedPosition';
import { IconToolbarButton } from '../../ui/WorkspaceShell';

/**
 * 레이아웃 프리셋 드롭다운 — `/live`·`/study` 공용 **표현 컴포넌트**.
 *
 * 페이지가 다른 것은 세 갈래뿐이다: 목록·뮤테이션(어느 API 인가), 활성 프리셋 id(어느
 * 스토어인가), 캡처/적용(어느 워크스페이스인가). 그 셋만 어댑터로 주입받고 팝오버·에러
 * 배너·2단 삭제 확인·인라인 이름입력·열 때 재조회·409 처리는 여기 한 벌만 둔다.
 *
 * 뮤테이션을 객체째 받지 않고 콜백으로 받는 이유: 어댑터가 자기 react-query 훅을 원래
 * 모양 그대로 호출하게 두면 페이지별 테스트가 뮤테이션 인자를 그대로 검증할 수 있다.
 */

export type PresetRow<P> = {
  id: string;
  name: string;
  payload: P;
  updated_at_ms: number;
};

/** 성공/실패만 알면 되는 최소 핸들러 — react-query 의 mutate options 를 어댑터가 감싼다. */
export type PresetHandlers<T> = {
  onSuccess: (result: T) => void;
  onError: (e: unknown) => void;
};

export type PresetMenuLabels = {
  /** 툴바 버튼에 프리셋 미적용 시 보일 글자. */
  buttonFallback: string;
  ariaLabel: string;
  /** 목록 위 안내 — 적용이 무엇을 갈아치우는지 페이지마다 다르다. */
  applyHint: string;
  /** 목록 항목 title. */
  applyTitle: string;
  saveCurrent: string;
  reset: string;
};

export type PresetMenuProps<P> = {
  presets: PresetRow<P>[];
  /** 메뉴를 열 때 목록을 다시 읽는다(staleTime 우회). */
  refetchPresets: () => void;
  activePresetId: string | null;
  capture: () => P;
  apply: (payload: P, presetId: string | null) => void;
  defaultPayload: () => P;
  /** 활성 프리셋 덮어쓰기. 낙관적 동시성 값은 어댑터가 preset 에서 꺼내 실어 보낸다. */
  saveExisting: (preset: PresetRow<P>, payload: P, handlers: PresetHandlers<void>) => void;
  saveNew: (name: string, payload: P, handlers: PresetHandlers<{ id: string }>) => void;
  removePreset: (id: string, handlers: PresetHandlers<void>) => void;
  /** 409(다른 곳에서 먼저 저장됨) 판정 — 에러 코드가 리소스마다 다르다. */
  isConflict: (e: unknown) => boolean;
  labels: PresetMenuLabels;
  /** data-testid 접두사. `/live` 는 기존 'layout-preset' 을 유지한다. */
  testIdPrefix: string;
};

export function PresetMenu<P>({
  presets,
  refetchPresets,
  activePresetId,
  capture,
  apply,
  defaultPayload,
  saveExisting,
  saveNew,
  removePreset,
  isConflict,
  labels,
  testIdPrefix,
}: PresetMenuProps<P>) {
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
  // 저장/삭제 실패 시 메뉴를 닫지 않고 에러를 표면화 — study-views 패턴.
  const failWith = (fallback: string) => (e: unknown) =>
    setError(e instanceof Error ? e.message : fallback);
  useDismissablePopover(open, wrapRef, close);
  const { ref: menuPositionRef, left, top } = useClampedFixedPosition<HTMLDivElement>(
    anchorRect?.left ?? 0,
    anchorRect ? anchorRect.bottom + 4 : 0,
  );

  const activePreset = presets.find((p) => p.id === activePresetId) ?? null;

  const toggle = () => {
    const next = !open;
    setAnchorRect(wrapRef.current?.getBoundingClientRect() ?? null);
    setOpen(next);
    // 메뉴 열기 = "지금 목록을 보겠다" 는 명시적 의도 → staleTime(60s)을 우회해 다시
    // 읽는다. 이 메뉴는 툴바에 상시 마운트라 mount-refetch 가 돌지 않고 전역
    // refetchOnWindowFocus 도 꺼져 있어(main.tsx), 다른 탭이 방금 저장한 프리셋이
    // 새로고침 전까지 보이지 않았다.
    if (next) refetchPresets();
  };

  const applyPreset = (id: string) => {
    const preset = presets.find((p) => p.id === id);
    if (!preset) return;
    apply(preset.payload, preset.id);
    close();
  };

  const saveCurrent = () => {
    if (!activePreset) return;
    setError(null);
    saveExisting(activePreset, capture(), {
      onSuccess: () => close(),
      onError: (e) => {
        // 그 사이 다른 탭·기기가 먼저 저장했다 — 조용히 덮어쓰지 않고 최신 목록을
        // 다시 읽어 사용자가 무엇을 덮어쓸지 보고 판단하게 한다(메뉴는 열어 둔다).
        if (isConflict(e)) {
          refetchPresets();
          setError('다른 곳에서 먼저 변경된 프리셋입니다. 최신 목록을 다시 불러왔습니다');
          return;
        }
        failWith('프리셋 저장에 실패했습니다')(e);
      },
    });
  };

  const confirmSaveAs = () => {
    const name = (saveAsName ?? '').trim();
    if (!name) return;
    setError(null);
    saveNew(name, capture(), {
      onSuccess: () => close(),
      onError: failWith('프리셋 저장에 실패했습니다'),
    });
  };

  const resetDefault = () => {
    apply(defaultPayload(), null);
    close();
  };

  const menu = open && anchorRect ? (
    <div
      ref={menuPositionRef}
      role="menu"
      aria-label={labels.ariaLabel}
      data-testid={`${testIdPrefix}-menu`}
      onMouseDown={(e) => e.stopPropagation()}
      className="min-w-56 rounded border border-border bg-bg-card py-1 shadow-overlay z-50"
      style={{ position: 'fixed', left, top }}
    >
      {error && (
        <div data-testid={`${testIdPrefix}-error`} role="alert" className="px-3 py-1.5 text-xs text-danger">
          {error}
        </div>
      )}
      {presets.length === 0 ? (
        <div className="px-3 py-1.5 text-xs text-fg-dim">저장된 프리셋이 없습니다</div>
      ) : (
        <div className="px-3 pb-1 pt-0.5 text-[10px] text-fg-dim">
          {labels.applyHint}
        </div>
      )}
      {presets.map((preset) => (
        <div key={preset.id} className="flex items-center gap-1 px-1">
          <button
            type="button"
            role="menuitem"
            title={labels.applyTitle}
            data-testid={`${testIdPrefix}-apply-${preset.id}`}
            onClick={() => applyPreset(preset.id)}
            className={`flex-1 truncate rounded px-2 py-1.5 text-left text-xs hover:bg-bg-input-hover ${
              preset.id === activePresetId ? 'text-accent' : 'text-fg-dim'
            }`}
          >
            {preset.name}
          </button>
          {pendingDelete === preset.id ? (
            <button
              type="button"
              data-testid={`${testIdPrefix}-confirm-delete-${preset.id}`}
              onClick={() => {
                setError(null);
                removePreset(preset.id, {
                  onSuccess: () => {},
                  onError: failWith('프리셋 삭제에 실패했습니다'),
                });
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
              data-testid={`${testIdPrefix}-delete-${preset.id}`}
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
        data-testid={`${testIdPrefix}-save-current`}
        onClick={saveCurrent}
        disabled={!activePreset}
        className="block w-full px-3 py-1.5 text-left text-xs text-fg-dim hover:bg-bg-input-hover disabled:opacity-40 disabled:hover:bg-transparent"
      >
        {labels.saveCurrent}
      </button>

      {saveAsName === null ? (
        <button
          type="button"
          role="menuitem"
          data-testid={`${testIdPrefix}-save-as-open`}
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
            data-testid={`${testIdPrefix}-save-as-input`}
            onChange={(e) => setSaveAsName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') confirmSaveAs(); }}
            placeholder="프리셋 이름"
            className="h-7 min-w-0 flex-1 rounded border border-border bg-bg-input px-2 text-xs text-fg outline-none focus:border-accent"
          />
          <button
            type="button"
            data-testid={`${testIdPrefix}-save-as-confirm`}
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
        data-testid={`${testIdPrefix}-reset`}
        onClick={resetDefault}
        className="block w-full px-3 py-1.5 text-left text-xs text-fg-dim hover:bg-bg-input-hover"
      >
        {labels.reset}
      </button>
    </div>
  ) : null;

  return (
    <div ref={wrapRef} className="relative">
      <IconToolbarButton
        data-testid={`${testIdPrefix}-button`}
        onClick={toggle}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={labels.ariaLabel}
        icon={(
          <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="7" height="7" rx="1" />
            <rect x="14" y="3" width="7" height="7" rx="1" />
            <rect x="3" y="14" width="7" height="7" rx="1" />
            <rect x="14" y="14" width="7" height="7" rx="1" />
          </svg>
        )}
      >
        <span>{activePreset ? activePreset.name : labels.buttonFallback}</span>
      </IconToolbarButton>
      {menu && createPortal(menu, document.body)}
    </div>
  );
}
