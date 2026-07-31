#!/usr/bin/env bash
# deep-health 감독자: "살아 있지만 아무 일도 안 하는" 프로세스를 재시작한다.
#
# 왜 필요한가: 배경 태스크(daily-loop, watchlist-catchup, today-promoter, 그리고
# live-stream-watchdog **자신**)는 조용히 죽어도 프로세스는 살아 있다. systemd 의
# Restart=always 는 프로세스 사망만 덮으므로 이 상태를 못 잡는다 — 부활 경로는
# 프로세스 재시작뿐이다(ADR-0088). 실제로 폴러가 침묵 사망한 걸 저녁에 데이터
# 구멍으로 발견한 사고가 있었다(ADR-0064). hogaplay 업스트림 보유가 ~18h 라
# 그날 오전은 그때 이미 영구 소실이다.
#
# `GET /health?deep=1` 은 죽은 태스크가 하나라도 있으면 503 + dead_tasks 를 준다
# (hoga/api/app.py `_health`). 판정 API 는 이미 있었고 없던 것은 그 503 에 반응하는
# 쪽이다. 이 스크립트가 그 액추에이터다.
#
# 설치는 systemd timer 로 한다 — deploy/hoga-ops-health.{service,timer} 참고.
#
# 환경변수:
#   HOGA_HEALTH_URL   판정 대상 (기본 http://127.0.0.1:8000/health?deep=1)
#   HOGA_HEALTH_UNIT  재시작할 유닛 (기본 hoga-ops)
#   HOGA_HEALTH_HOLDOFF_S  재시작 최소 간격 초 (기본 600)
#   HOGA_HEALTH_STAMP 마지막 재시작 시각 스탬프 경로
set -u

URL="${HOGA_HEALTH_URL:-http://127.0.0.1:8000/health?deep=1}"
UNIT="${HOGA_HEALTH_UNIT:-hoga-ops}"
HOLDOFF="${HOGA_HEALTH_HOLDOFF_S:-600}"
STAMP="${HOGA_HEALTH_STAMP:-${XDG_RUNTIME_DIR:-/tmp}/hoga-ops-health.last-restart}"

body_file="$(mktemp)"
trap 'rm -f "$body_file"' EXIT

# -o/-w 로 한 번에 본문과 상태코드를 받는다. 재시작 로그에 dead_tasks 를 실으려고
# 두 번 호출하면 그 사이에 상태가 바뀔 수 있다 — 판정과 로그는 같은 응답이어야 한다.
# 연결 실패 시 curl 은 http_code 를 000 으로 쓴다.
code="$(curl -s --max-time 5 -o "$body_file" -w '%{http_code}' "$URL" 2>/dev/null || true)"

case "$code" in
  200)
    exit 0
    ;;
  000)
    # 무응답 = 프로세스 다운 또는 기동 중. 여기서 재시작을 걸면 systemd 가 이미
    # 되살리는 중인 프로세스를 이중으로 걷어찬다. 이 경우는 Restart=always 의 영역이다.
    exit 0
    ;;
  503)
    # 아래에서 처리.
    ;;
  *)
    # 404(URL 오타)·500(다른 고장) 등. 재시작이 답이라는 근거가 없으므로 기록만 한다.
    echo "hoga-ops-health: unexpected HTTP $code from $URL — not restarting" >&2
    exit 0
    ;;
esac

now="$(date +%s)"
last="$(cat "$STAMP" 2>/dev/null || echo 0)"
case "$last" in
  ''|*[!0-9]*) last=0 ;;
esac

if [ "$((now - last))" -lt "$HOLDOFF" ]; then
  # 재시작 직후 같은 태스크가 또 죽었다 = 결정적 장애. 반복 재시작은 무의미하고
  # StartLimitBurst(5회/5분)를 태워 서비스 자체를 세운다. 로그만 남기고 사람을 기다린다.
  echo "hoga-ops-health: still 503 within holdoff ${HOLDOFF}s — NOT restarting. body: $(cat "$body_file")" >&2
  exit 0
fi

echo "$now" > "$STAMP"
echo "hoga-ops-health: 503 → restarting $UNIT. body: $(cat "$body_file")" >&2
systemctl --user restart "$UNIT"
