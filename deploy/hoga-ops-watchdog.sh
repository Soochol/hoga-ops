#!/usr/bin/env bash
# hoga-ops 워치독 (#998) — deep health 실패 시 유닛을 재시작한다.
#
# 왜 필요한가: systemd 의 Restart=always 는 **프로세스 exit** 에만 반응한다.
# "프로세스는 살았는데 배경 태스크가 조용히 죽은"(ADR-0064) 상태와 "큐 비소유
# read-only 부팅"(ADR-0094) 상태는 exit 없이 지속되므로, deep health(503)를
# 주기적으로 물어 외부에서 재시작해야 회수된다. 앱 내 자동재시작을 두지 않는
# ADR-0088 과 충돌하지 않는다 — 이것은 앱 밖의 감독이다.
#
# HOGA_HEALTH_URL: prod 는 tailscale 인터페이스에만 바인드하므로(ADR-0134)
# 루프백 기본값이 닿지 않는다 — 워치독 유닛의 Environment= 에서 실제 바인드
# 주소로 반드시 재정의할 것 (hoga-ops-watchdog.service 주석 참고).
set -u
URL="${HOGA_HEALTH_URL:-http://127.0.0.1:8000/health?deep=1}"

if curl -fsS --max-time 10 "$URL" >/dev/null 2>&1; then
  exit 0
fi
echo "hoga-ops-watchdog: ${URL} unhealthy — restarting hoga-ops" >&2
exec systemctl --user restart hoga-ops
