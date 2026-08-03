#!/usr/bin/env bash
# 바인드 주소가 인터페이스에 올라올 때까지 기다린다 (hoga-ops.service 의 ExecStartPre).
#
# 왜 필요한가: 재부팅(정전 복구)에서 user 매니저는 linger 로 즉시 기동하는데
# tailscaled 는 아직 인터페이스를 안 올렸을 수 있다. 그 창에서 uvicorn 의 bind 는
# EADDRNOTAVAIL 로 즉사하고, Restart=always 가 5초 간격으로 5번 재시도하면
# StartLimitBurst 가 소진돼 **유닛이 failed 로 고착한다** — 그때부터는 Restart 도
# 더 이상 돌지 않으므로, 무인 서버가 다음 날 아침까지 죽어 있게 된다.
# `After=network-online.target` 은 이걸 못 막는다: 그 타깃은 시스템 매니저의
# 것이라 user 매니저 네임스페이스에 아예 존재하지 않아 순서가 강제되지 않는다.
#
# 별도 스크립트인 이유: 유닛 파일 안의 `bash -c '...'` 에 넣으면 systemd 가 자기
# 규칙으로 `$` 를 먼저 훑는 층이 하나 더 생긴다. 셸 문법을 셸에게만 맡긴다.
set -u

HOST="${HOGA_BIND_HOST:-127.0.0.1}"
ATTEMPTS="${HOGA_BIND_WAIT_ATTEMPTS:-60}"   # 1초 간격 — 유닛의 TimeoutStartSec 와 맞춰 둘 것
SLEEP_S="${HOGA_BIND_WAIT_SLEEP_S:-1}"

i=0
while [ "$i" -lt "$ATTEMPTS" ]; do
  # 주소만 뽑아 **정확히** 비교한다. 줄 전체를 grep 하면 부분 일치가 통과한다 —
  # `grep -w` 로도 못 막는다(`.` 이 단어 경계라 `100.64.1.2` 가 `100.64.1.20` 에
  # 걸린다. 실측 확인: `-w` 로 `127.0.0` 이 `127.0.0.1` 에 매치됐다).
  if ip -o addr show 2>/dev/null | awk '{print $4}' | cut -d/ -f1 \
      | grep -qxF "$HOST"; then
    exit 0
  fi
  i=$((i + 1))
  sleep "$SLEEP_S"
done

echo "hoga-ops: bind address ${HOST} never appeared on any interface" \
     "(tailscale 이 안 떴거나 ~/.config/hoga-ops/deploy.env 의 주소가 틀렸다)" >&2
exit 1
