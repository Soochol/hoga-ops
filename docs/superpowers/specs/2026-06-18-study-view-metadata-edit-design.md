# Study View Metadata Editing Design

## Goal

Allow saved study views to be renamed from the saved-view list and allow the study page to open and edit the saved memo. These edits must update metadata only: the saved chart snapshot JSON must not be regenerated or rewritten.

## Current Context

- Saved study views are listed in `frontend/src/studyViews/StudyViewsDrawer.tsx`.
- The study page renders the selected snapshot in `frontend/src/studyViews/StudyPage.tsx`.
- The existing `PUT /api/study-views/saves/{id}` path overwrites the full saved snapshot through `ParquetStudyViewWriteRequest`.
- `hoga/api/study_views.py` stores metadata in `study_views/saves.json` and snapshots in `study_views/snapshots/{id}.json`.

## Recommended Approach

Add a metadata-only update path and use it from both UI surfaces.

### Backend

Add a request model named `StudyViewMetadataUpdateRequest` with optional `name` and `memo` fields. At least one field must be provided.

- `name`, when provided, is trimmed and must not be blank.
- `memo`, when provided, is trimmed consistently with existing save-dialog behavior.
- The update function changes only the matching `ParquetStudyView` row in `saves.json`.
- `updated_at_ms` is refreshed and the list remains sorted by newest update first.
- Snapshot files under `study_views/snapshots/` are not written.
- Missing ids return the same 404 behavior as existing save routes.

Expose this through:

```text
PATCH /api/study-views/saves/{id}/metadata
```

### Frontend Data Layer

Add `updateStudyViewMetadata(id, body)` in `frontend/src/api/studyViews.ts` and a metadata mutation in `useStudyViewMutations`.

On success:

- Invalidate `STUDY_VIEW_SAVES_QUERY`.
- Leave `studyViewSnapshotQuery(id)` untouched because metadata edits do not alter snapshot content.
- `StudyPage` reads the selected metadata row from `useStudyViews()` by matching the `view` query param. The snapshot query continues to provide chart content only.

### Saved View List Rename

In `StudyViewsDrawer`:

- Double-clicking a saved view name enters inline edit mode.
- The row keeps normal single-click navigation on the rest of the row.
- Enter commits the trimmed name.
- Blur commits the trimmed name.
- Escape cancels and restores the prior name.
- Empty or unchanged values do not call the mutation.
- While the rename mutation is pending for a row, keep the input stable and avoid duplicate commits.

### Study Page Memo UI

In `StudyPage`:

- Add a compact "메모" control in the header.
- Opening it reveals the current memo for the selected saved view.
- The memo can be edited in a textarea.
- Blur or an explicit save button commits the memo through the metadata mutation.
- Escape closes without committing the current draft.
- Empty memo is valid and renders as a quiet empty state.

Render the memo as a header-adjacent popover panel aligned to the right side of the study page header. The panel must stay within the viewport, keep the chart visible underneath, and use existing border/background/text tokens.

## Error Handling

- If metadata save fails, keep the draft visible and show a small inline error.
- Do not silently modify local cached data on failure.
- Do not navigate away during rename or memo editing.

## Tests

Backend tests:

- Metadata patch renames without touching the snapshot file.
- Metadata patch updates memo without touching the snapshot file.
- Blank name is rejected.
- Missing id returns 404.

Frontend tests:

- Double-clicking a saved-view name enters edit mode and Enter commits via metadata mutation.
- Blur commits a changed saved-view name.
- Escape cancels rename.
- Study page memo control opens, edits, and commits memo through metadata mutation.
- Failed memo save shows an inline error.

## Out of Scope

- Editing snapshot contents, viewport, indicator state, tags, or provenance.
- Changing the existing overwrite behavior.
- Adding markdown rendering or rich text to memo.
