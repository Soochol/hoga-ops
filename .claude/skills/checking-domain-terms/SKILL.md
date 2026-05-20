---
name: checking-domain-terms
description: Use when verifying that recently-changed code, tests, and docs respect the ubiquitous language defined in CONTEXT.md — especially after implementing a feature, after a refactor that renames domain terms, before committing, or before /superpowers:verification-before-completion. Reads CONTEXT.md and `git diff` and reports semantic term violations.
---

# Checking Domain Terms

## Overview

This project's `CONTEXT.md` defines a **ubiquitous language** with explicit `_Avoid_:` lists for each term (e.g. don't use "session" alone — say "Regular Session" or "Data Window"; don't use "API model" — say "Wire Model"). Drift creeps in when a rename in `CONTEXT.md` is not propagated to ADRs, plans, or code.

This skill runs a **semantic check by Claude**, not a regex linter. The agent reads `CONTEXT.md`, reads the changes since the base branch, and judges each suspect term **in context** — distinguishing `browser session` (legit, different domain) from `during the session` (violation, should be `Regular Session`).

**Core principle:** the glossary is the spec; the diff is the test. No exception list to maintain — judgment handles edge cases.

## When to Use

- After `/superpowers:subagent-driven-development` (subagents may use wrong terms despite CONTEXT.md in prompt)
- After `/improve-codebase-architecture` (refactors that rename terms leak stale references)
- Before `/superpowers:verification-before-completion` as the second-to-last gate
- After editing `CONTEXT.md` itself (a new `_Avoid_:` entry may catch existing violations)
- When CONTEXT.md notes "renamed X to Y" — verify nothing in the diff still says X

Do NOT use when:
- The project has no `CONTEXT.md` with `_Avoid_:` markers
- The diff is empty or only touches files outside `hoga/`, `tests/`, `docs/`

## Procedure

Execute these steps in order. Do not skip.

### 1. Load the glossary

Read `CONTEXT.md` fully. Extract:
- Every defined term (e.g. `Regular Session`, `Stock-Date`, `Wire Model`)
- Every `_Avoid_:` line (the negative dictionary)
- Any "renamed X → Y" notes in the Flagged ambiguities section

### 2. Identify the diff

Default to the branch's diff against the base:
```bash
git diff $(git merge-base HEAD master)...HEAD -- 'hoga/**' 'tests/**' 'docs/**'
```

If on master with uncommitted changes:
```bash
git diff -- 'hoga/**' 'tests/**' 'docs/**'
```

Use `git status` to confirm which mode applies.

### 3. Inspect each changed hunk

For every added or modified line, check it against the `_Avoid_:` rules. For each candidate violation, ask:

1. **Is this the avoided term in the ubiquitous-language sense?** Example: `session` in `browser session cookie` is the HTTP/web meaning — NOT a violation. `session` in `during the session prices rose` is the trading meaning — VIOLATION (should be `Regular Session` or `Data Window`).
2. **Is this in an identifier (variable/function/class name) or in prose (comment/docstring/markdown)?** Both are violations, but identifier violations are higher-cost to fix.
3. **Does CONTEXT.md provide the correct replacement?** Cite the specific term to use.

### 4. Report findings

Use this format:

```
=== checking-domain-terms ===

Violations found: N (or "None — diff respects CONTEXT.md")

For each violation:
  file:line — `<offending phrase>`
    → Use `<correct term>` per CONTEXT.md ("<defining sentence>")
    Context: <one-line excerpt>

Renames to verify (if CONTEXT.md notes any):
  - "X" → "Y": found 0 stale references in diff ✓
                 OR found N stale references at <file:line>, ...
```

If there are no violations, say so explicitly — silence is ambiguous.

### 5. Recommend action

For each violation:
- **Prose violation in `.md`**: suggest text edit
- **Identifier violation in `.py`**: suggest rename + grep for callers to update
- **False positive concern**: explain why you judged it legit (so user can audit your reasoning)

Do not auto-fix without user confirmation — false positives in semantic judgment are real.

## Quick Reference

| Situation | Action |
|-----------|--------|
| Term in `_Avoid_:` appears with the avoided meaning | Violation — report with correct replacement |
| Term in `_Avoid_:` appears with a different meaning (e.g. HTTP session) | Not a violation — note in report so user can audit |
| Identifier uses avoided term | Violation, higher fix cost — flag and grep for callers |
| CONTEXT.md was edited in this diff | Re-check the WHOLE repo against new rules, not just the diff |
| Diff is large (1000+ lines) | Sample: focus on `hoga/` source files and ADR/plan additions |

## Common Mistakes

### Treating it as regex

The whole point of this being an LLM skill is semantic judgment. If you find yourself thinking "let me grep for `\bsession\b`", stop — read the line, understand the meaning, then judge.

### Reporting every grep hit

A term appearing in code is not automatically a violation. `cookie session` in a comment about HTTP auth is fine. Only flag uses that match the **ubiquitous-language sense** the `_Avoid_:` rule targets.

### Skipping the "rename verification"

When `CONTEXT.md` has notes like "API model → Wire Model" or section "Flagged ambiguities", explicitly search the diff for the old term. This catches the highest-value drift (recent renames that didn't propagate).

### Silent pass

"No violations" must be stated explicitly. An empty report is ambiguous — did Claude check, or skip?

### Auto-fixing without confirmation

Semantic judgments can be wrong. Always report → confirm → fix, not detect → patch.

## Integration

Where this slots in the feature development workflow (`docs/feature-development-workflow.md`):

```
/superpowers:subagent-driven-development
  → /improve-codebase-architecture
  → (가치 있으면) ADR draft + commit
  → /checking-domain-terms          ← this skill
  → /superpowers:verification-before-completion
  → /superpowers:finishing-a-development-branch
```

## Why LLM, not a script

Originally drafted as a Python regex linter. Rejected because:
- Exception list maintenance burden (every legit compound needs a regex entry)
- Cannot distinguish meanings (`browser session` vs `trading session`)
- This skill always runs inside a Claude session anyway — no CI requirement

If a CI-time deterministic check is ever needed, add a Python script then. Until then, judgment beats regex for glossary enforcement.
