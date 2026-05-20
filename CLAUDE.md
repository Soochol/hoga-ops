# CLAUDE.md

Project-specific guidance for Claude Code working in this repo.

## Agent skills

### Issue tracker

Issues live in GitHub (`Soochol/hoga-ops`) via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical triage roles map 1:1 to label strings (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout: `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Design System

Always read `DESIGN.md` at the repo root before making any visual or UI decisions in the frontend.
All font choices, colors, spacing, border radii, motion, and aesthetic direction are defined there.
Do not deviate without explicit user approval.

The approved visual reference is `docs/superpowers/designs/2026-05-20-replay-viewer.html` —
open it in a browser to see the design system rendered with realistic dummy data.

When reviewing frontend code, flag anything that doesn't match `DESIGN.md` (off-token colors,
hardcoded spacing values, non-system fonts, decorative elements not sanctioned by the system).
