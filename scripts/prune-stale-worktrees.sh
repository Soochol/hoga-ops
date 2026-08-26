#!/usr/bin/env bash
# 오래된 git 워크트리를 안전하게 정리한다 (inotify 파일 워처 회복용).
#
# 배경: Claude Code / Codex 가 세션마다 워크트리를 만들어 쌓인다. 각 워크트리에서
# `npm install`을 돌리면 node_modules 로 수만 개 디렉토리가 생기고, codex-desktop /
# VS Code 같은 파일 감시 앱이 이를 재귀 감시하면 시스템 inotify watch 예산
# (fs.inotify.max_user_watches)이 소진돼 `vite`가 ENOSPC 로 죽는다.
#
# 안전장치:
#   - 메인 체크아웃과 "현재 셸이 들어있는 워크트리"는 절대 건드리지 않는다.
#   - CLEAN(미커밋 변경 0) 워크트리만 제거한다. 커밋은 브랜치(.git)에 남으므로
#     working dir 만 사라진다 — 데이터 손실 없음. `git worktree add`로 언제든 복구.
#   - DIRTY(미커밋 변경 있음) 워크트리는 건드리지 않고 보고만 한다(--force 안 씀).
#
# 사용법:
#   scripts/prune-stale-worktrees.sh            # 미리보기(dry-run, 기본)
#   scripts/prune-stale-worktrees.sh --apply    # 실제 제거
set -euo pipefail

APPLY=0
[ "${1:-}" = "--apply" ] && APPLY=1

MAIN="$(git rev-parse --path-format=absolute --git-common-dir)"
MAIN="$(dirname "$MAIN")"                       # git-common-dir 의 부모 = 메인 체크아웃
SELF="$(git -C "$PWD" rev-parse --show-toplevel 2>/dev/null || echo "")"  # 현재 워크트리

echo "메인 체크아웃(유지): $MAIN"
echo "현재 워크트리(유지): ${SELF:-<없음>}"
echo "모드: $([ "$APPLY" = 1 ] && echo '실제 제거(--apply)' || echo '미리보기(dry-run) — 실제 제거하려면 --apply')"
echo

git worktree prune                              # 죽은 참조 먼저 정리

removed=0; skipped_dirty=0; kept=0
while IFS= read -r wt; do
  case "$wt" in
    "$MAIN"|"$SELF") echo "KEEP   $wt"; kept=$((kept+1)); continue ;;
  esac
  # 활성 세션 보호: 어떤 프로세스라도 cwd 가 이 워크트리 안이면 사용 중 → 건너뜀
  # (메인에서 실행해도 돌아가는 Claude/Codex 세션 워크트리를 제거하지 않게).
  in_use=0
  for cwd in /proc/*/cwd; do
    tgt=$(readlink "$cwd" 2>/dev/null) || continue
    case "$tgt" in "$wt"|"$wt"/*) in_use=1; break ;; esac
  done
  if [ "$in_use" -ne 0 ]; then
    echo "SKIP   $wt  (사용 중 — 프로세스 cwd 가 이 안에 있음, 활성 세션 보호)"
    kept=$((kept+1))
    continue
  fi
  dirty=$(git -C "$wt" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
  if [ "$dirty" -ne 0 ]; then
    echo "SKIP   $wt  (dirty=$dirty — 미커밋 변경 보호, 수동 확인 필요)"
    skipped_dirty=$((skipped_dirty+1))
    continue
  fi
  if [ "$APPLY" = 1 ]; then
    git worktree remove "$wt" && echo "REMOVE $wt"
  else
    echo "WOULD  $wt  (clean — --apply 시 제거)"
  fi
  removed=$((removed+1))
done < <(git worktree list --porcelain | awk '/^worktree /{print $2}')

echo
echo "요약: 유지 $kept · $([ "$APPLY" = 1 ] && echo 제거 || echo 제거대상) $removed · dirty건너뜀 $skipped_dirty"
[ "$APPLY" = 1 ] && git worktree prune

# inotify watch 현황 (참고). grep -c 는 0매치 시 exit 1 + "0" 출력이라 || 는 밖에 둔다.
watch_total=0
for f in /proc/*/fdinfo/*; do
  c=$(grep -c '^inotify ' "$f" 2>/dev/null) || c=0
  watch_total=$((watch_total + c))
done
echo "현재 inotify watch: $watch_total / $(cat /proc/sys/fs/inotify/max_user_watches)"
