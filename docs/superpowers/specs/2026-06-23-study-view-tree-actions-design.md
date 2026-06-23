# Study View Tree Actions Design

## Summary

Update the saved study views drawer to use the selected compact visual tree direction based on option A from the visual companion. The drawer keeps the current stock-group tree model, but makes the parent/child relationship clearer and removes persistent row action buttons.

## Goals

- Keep saved views grouped under each stock name.
- Make the tree relationship visible with subtle connector treatment, child markers, and tighter row hierarchy.
- Remove inline `수정` and `삭제` buttons from each saved-view row.
- Rename a saved view by double-clicking its name.
- When rename mode opens, focus the input and select the full existing name.
- Delete a saved view from a right-click context menu on the saved-view row.

## Non-Goals

- No backend API changes.
- No changes to saved-view grouping, sorting, collapse state, or drag persistence.
- No bulk delete, duplicate, or metadata editor changes.
- No new tree grouping dimension beyond stock code.

## UI Behavior

### Tree Layout

The stock group header remains the parent row. It keeps the expand/collapse affordance, stock name, and count. The saved-view rows become child rows with a small visual child marker and indentation so the hierarchy reads as:

```text
삼성전자
  장초반 매수벽 유지
  거래원 전환 체크
```

The row remains clickable and keyboard-openable when not editing.

### Rename

Double-clicking the saved-view name starts inline rename mode for that row. The edit input uses the existing saved-view name, focuses immediately, and selects the full text. Enter commits, Escape cancels, and blur commits, matching the current rename lifecycle.

Clicking elsewhere in the row still opens the saved view unless the row is already in rename mode.

### Delete

Right-clicking a saved-view row opens a small context menu near the pointer. The menu contains a `삭제` action. Activating it opens the existing delete confirmation dialog; the saved view is deleted only after that confirmation.

The context menu closes on outside click, Escape, or after choosing an action. It must not open the saved view when invoked.

## Accessibility

- Saved-view rows keep `role="button"` and Enter/Space open behavior when not editing.
- The rename input keeps `aria-label="저장뷰 이름 수정"`.
- The context menu uses menu semantics and can be dismissed with Escape.
- Delete remains guarded by the existing modal confirmation.

## Implementation Notes

- Change only `frontend/src/studyViews/StudyViewsDrawer.tsx` unless tests expose a small helper need.
- Reuse the existing `renameState`, `commitRename`, and delete confirmation state.
- Replace inline row buttons with double-click rename and context-menu delete.
- Add a ref/effect for selecting the rename input text after entering edit mode.
- Keep drag disabled behavior unchanged: row drag remains available only in default sort with no query.

## Testing

- Update `StudyViewsDrawer` tests to cover:
  - Inline action buttons are no longer rendered.
  - Double-clicking a saved-view name enters rename mode and the input contains the current name.
  - Rename still commits through the existing mutation path.
  - Right-clicking a saved-view row opens a context menu with `삭제`.
  - Choosing `삭제` opens the existing confirmation dialog and confirming deletes.

## Open Decisions

None. The selected direction is option A plus compact action behavior requested on 2026-06-23.
