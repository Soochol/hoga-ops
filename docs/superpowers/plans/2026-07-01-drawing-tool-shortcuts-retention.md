# Drawing Tool Shortcuts Retention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make drawing shortcuts match the requested keys and keep the active drawing tool after creating a drawing until Escape returns to select mode.

**Architecture:** The drawing tool registry owns shortcut metadata and per-tool commit behavior. Tests exercise pure tool specs directly, so this change can stay in `frontend/src/chart/drawing/tools.ts` plus its focused unit tests.

**Tech Stack:** React 18, TypeScript, Vitest, Zustand drawing store.

## Global Constraints

- `Alt+H` activates horizontal line.
- `Alt+J` activates trendline.
- `Alt+B` activates pencil.
- Creating hline, trendline, or pencil must not switch the active tool to select.
- `Escape` remains the way to return to select mode.
- Do not add dependencies.

---

### Task 1: Update Drawing Tool Contracts

**Files:**
- Modify: `frontend/src/chart/drawing/tools.test.ts`
- Modify: `frontend/src/chart/drawing/tools.ts`

**Interfaces:**
- Consumes: `matchShortcut(e: KeyboardEvent): DrawingTool | null`
- Produces: unchanged `DrawingToolSpec.shortcut?: { alt: true; key: string }`

- [x] **Step 1: Write failing tests**

Change the shortcut tests to expect `Alt+J -> trendline` and `Alt+B -> pencil`, and change hline/trendline/pencil commit tests to assert `revertToSelectMode` is not called after successful creation.

- [x] **Step 2: Run focused test to verify failure**

Run: `npm test -- drawing/tools.test.ts --run`

Expected: failures for old `Alt+T`/`Alt+P` mappings and old post-create select-mode revert.

- [x] **Step 3: Implement minimal code**

Set `trendlineTool.shortcut.key` to `j`, set `pencilTool.shortcut.key` to `b`, and remove successful `ctx.revertToSelectMode(id)` calls from `hlineTool`, `trendlineTool`, and `pencilTool`.

- [x] **Step 4: Run focused test to verify pass**

Run: `npm test -- drawing/tools.test.ts --run`

Expected: pass.
