#!/usr/bin/env bash
# hoga-ops 워치독 (#998) — deep health 실패 시 유닛을 재시작한다.
#
# 왜 필요한가: systemd 의 Restart=always 는 **프로세스 exit** 에만 반응한다.
# "프로세스는 살았는데 배경 태스크가 조용히 죽은"(ADR-0064) 상태와 "큐 비소유
# read-only 부팅"(ADR-0094) 상태는 exit 없이 지속되므로, deep health(503)를
# 주기적으로 물어 외부에서 재시작해야 회수된다. 앱 내 자동재시작을 두지 않는
# ADR-0088 과 충돌하지 않는다 — 이것은 앱 밖의 감독이다.
#
# 대상 주소는 서비스 유닛과 **같은 파일**에서 온다(deploy/hoga-ops.env.example
# → ~/.config/hoga-ops/deploy.env). 좌표를 두 곳에 리터럴로 적으면 한쪽만
# 고쳐지는 사고가 나고, 그 증상은 "건강한 서버를 장중 5분마다 재시작" 이다.
set -u

HOST="${HOGA_BIND_HOST:-127.0.0.1}"
PORT="${HOGA_BIND_PORT:-8000}"
URL="${HOGA_HEALTH_URL:-http://${HOST}:${PORT}/health?deep=1}"
# 재시작 이력. journald 한 줄로는 "하루 몇 번 돌았나" 를 알 수 없어서, 세지
# 않으면 장중 5분마다 재시작되는 서버를 아무도 눈치채지 못한다.
HISTORY="${XDG_STATE_HOME:-$HOME/.local/state}/hoga-ops/watchdog-restarts.log"

# --max-time 10: 이보다 느린 응답은 그 자체가 병증이다. -w 로 상태 코드를 받아
# "안 뜬 것(000)" 과 "떴는데 아픈 것(503)" 을 구분한다.
response="$(curl -sS --max-time 10 -w $'\n%{http_code}' "$URL" 2>/dev/null)"
code="${response##*$'\n'}"
body="${response%$'\n'*}"

if [ "$code" = "200" ]; then
  exit 0
fi

# 운영자가 일부러 멈춘 서비스는 되살리지 않는다. `systemctl --user stop hoga-ops`
# 로 정비 중인데 5분 뒤 타이머가 되살리면, 멈춘 이유(디스크 정리·업그레이드·
# 디버깅)를 밟고 지나간다. systemd 에게 "지금 켜져 있어야 하는 상태인가" 를 묻는
# 것이 의도를 읽는 유일한 방법이다 — 헬스 응답으로는 구별할 수 없다.
if ! systemctl --user is-active --quiet hoga-ops; then
  echo "hoga-ops-watchdog: hoga-ops 가 active 가 아니다 — 의도적 정지로 보고 건드리지 않는다." \
       "(자동 재시작은 유닛의 Restart=always 담당)" >&2
  exit 0
fi

if [ "$code" = "000" ]; then
  # 연결 자체가 안 됐다. 프로세스 사망이면 Restart=always 가 이미 붙고 있고,
  # 주소 오설정(deploy.env 미교정)이면 재시작은 아무것도 고치지 못한 채 장중
  # 수집만 끊는다. 그래서 여기서는 **재시작하지 않고** 시끄럽게 남긴다.
  echo "hoga-ops-watchdog: ${URL} unreachable — 프로세스 사망이거나 주소 오설정." \
       "systemctl --user status hoga-ops 와 ~/.config/hoga-ops/deploy.env 확인." >&2
  exit 1
fi

# 떴는데 아프다 — 재시작으로 회수되는 유일한 부류.
echo "hoga-ops-watchdog: ${URL} unhealthy (HTTP ${code}) — restarting hoga-ops" >&2
# 원인을 버리지 않는다. 재시작하면 인메모리 상태가 사라져 "왜 09:23 에
# 재시작됐나" 를 되짚을 방법이 없어진다. dead_tasks·queue 가 담긴 이 본문이
# 그 유일한 기록이다.
echo "hoga-ops-watchdog: body: ${body}" >&2

mkdir -p "$(dirname "$HISTORY")" 2>/dev/null || true
printf '%s\t%s\t%s\n' "$(date -Is)" "$code" "$body" >> "$HISTORY" 2>/dev/null || true

exec systemctl --user restart hoga-ops
