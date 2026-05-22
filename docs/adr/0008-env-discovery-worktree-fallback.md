# 0008 — `.env` discovery falls back from worktree to main repo

**Status:** proposed (2026-05-22) — pending implementation of `hoga/env.py` per `docs/superpowers/specs/2026-05-22-krx-env-symbol-design.md`
**Related:** `docs/superpowers/specs/2026-05-22-krx-env-symbol-design.md` §5.1

## Decision

`hoga/env.py::load_env()` discovers the `.env` file to load in this order:

1. `<working-tree>/.env` — resolved as `Path(__file__).resolve().parent.parent / ".env"`, i.e. relative to the currently-executing checkout. In a git worktree this is the worktree's root; in a main checkout this is the main repo root.
2. `<main-repo-root>/.env` — resolved by shelling out to `git rev-parse --git-common-dir` (from the working tree) and walking one level up. Used only when (1) is absent **and** the working tree is a git worktree (not the main checkout itself, and the binary is reachable).

The discovery is encapsulated in two private helpers (`_main_repo_root()`, `_discover_env_file()`); `load_env()` is otherwise a thin wrapper over `python-dotenv`'s `load_dotenv()`.

## Context

This project relies on KRX login credentials (`KRX_ID`, `KRX_PW`) and a hogaplay session cookie (`HOGAPLAY_COOKIE`) to fetch the **Symbol Master** and capture order-book data. The spec settles these into a repo-root `.env`.

The wrinkle: `hoga-ops` development uses git worktrees extensively. At the time of writing, the working directory is `.claude/worktrees/feat+frontend3/` — one of three active worktrees alongside the main checkout. A naïve `Path(__file__).parent.parent / ".env"` resolves to **the current worktree's** root, which means:

- Every worktree needs its own copy of the same credentials.
- Rotating credentials means editing N files; missing one leaves a worktree silently broken.
- Adding a new worktree is gated on remembering to copy `.env` over.

The same problem existed for the legacy `.cookie` file, and historically users worked around it by `cp` or symlink. The spec's `.env` would inherit the same friction unmodified.

## Alternatives considered

### A. Worktree-only (`.env` lives in the working tree, nothing more)

The simplest interpretation of the spec's "repo-root `.env`" decision. No git dependency, no fallback logic, no surprise behavior.

Rejected because the cost is paid every time a new worktree is created, and the failure mode (stale credentials in an unused worktree) is silent — exactly the class of failure this whole spec is trying to remove from the **Symbol Master** UX.

### B. User-global `.env` at `~/.config/hoga-ops/.env`

Considered (and recommended) during brainstorming, but rejected by the user in favor of a repo-local file. The rationale held: a repo-local `.env` is easier to discover, ties secrets to the project they belong to, and matches the existing `.cookie` precedent. Re-adopting (B) here would unwind a decision that was already made deliberately.

### C. Symlink-only convention (documentation, no code change)

Tell users to `ln -s ../../../.env .env` per worktree. Costs no code, but pushes the friction back onto the user every time. Also fragile across operating systems if anyone clones on Windows.

### D. (Chosen) Working-tree-first, main-repo-fallback via git plumbing

`git rev-parse --git-common-dir` is the git-supported way to locate the shared `.git` directory from anywhere inside a repo or worktree. The parent of that path is the main repo root.

This gives the user the ergonomics of (B) without abandoning the repo-local decision: one `.env` in the main checkout is automatically picked up by every worktree, but any worktree can still override locally with its own `.env` for debugging.

## Consequences worth flagging for future readers

- **`hoga/env.py` shells out to `git`.** The subprocess is bounded (2s timeout, no shell, fixed argv), and all exceptions degrade gracefully to "no fallback" — local `.env` still works without git. The dependency is at lookup time only; importing `hoga.env` does not invoke git.
- **Surprising lookup path.** A reader who greps for `_WORKING_TREE / ".env"` will not find the main-repo `.env` being loaded. The ADR exists primarily to make this discoverable: the helper `_discover_env_file()` is named for grep, and tests cover the fallback path explicitly.
- **Worktree override still works.** If a user wants different credentials in a worktree (e.g. testing against a sandbox KRX account), they drop a local `.env` and it wins. Override remains a first-class workflow.
- **Tarball installs lose the fallback.** A `pip install hoga-ops` from a wheel, or an unzipped source tarball, has no `.git` directory. The fallback simply doesn't fire and behavior reduces to "look for `.env` next to the install root" — which for a packaged install means there is no `.env` and the user must use shell env vars or `.cookie` instead. This is acceptable: packaged installs are not the development workflow this ADR optimizes for.
- **Not a generic config-loader.** This logic is for `.env` secrets only. The Symbol Master's `data_dir` lookup (`hoga/config.py::resolve_data_dir`) already uses XDG conventions and is unaffected. We are not introducing a project-wide "find me X near the repo" abstraction.
- **One subprocess per `load_env()` call.** Called twice per server lifetime in the happy path (CLI boot + at most one explicit refresh), so the overhead is invisible. If usage shifts toward calling `load_env()` from hot paths in the future, cache the discovery result.
