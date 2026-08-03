#!/usr/bin/env bash
# hoga-ops 데이터 백업 — 재수집 불가한 것만 다른 디스크로 민다.
#
# 왜 필요한가: 데이터가 OS 와 같은 단일 디스크에 있고 백업 절차가 없었다.
# hogaplay 업스트림 보유가 ~18시간이라 `parquet/` 은 **다시 받을 수 없는 유일본**
# 이고(15개월치 호가·체결·거래원), 사용자들의 저장뷰·관심종목·프리셋도 마찬가지다.
# 디스크가 죽는 순간 그 전부가 한 번에 사라지는데, 그 시점에 즉흥 대응을 하게
# 두지 않으려고 절차를 코드로 둔다.
#
# 설치:
#   mkdir -p ~/.config/systemd/user
#   cp deploy/hoga-ops-backup.{service,timer} ~/.config/systemd/user/
#   # 대상 경로를 ~/.config/hoga-ops/deploy.env 의 HOGA_BACKUP_DEST 에 적고,
#   # **대상 안에 센티널을 한 번 만든다**(아래 참고):
#   touch "$HOGA_BACKUP_DEST/.hoga-backup-root"
#   systemctl --user daemon-reload
#   systemctl --user enable --now hoga-ops-backup.timer
#
# 복구: 반대 방향 rsync 한 번이다. 서비스를 멈추고
#   systemctl --user stop hoga-ops
#   rsync -a "$HOGA_BACKUP_DEST/" "$DATA_DIR/"
#   systemctl --user start hoga-ops
# raw/ 는 백업에 없지만 없어도 동작한다 — parquet 이 진실 소스고 raw 는 그
# 파생 입력이다(재파싱 권리만 잃는다).
set -euo pipefail

DEST="${HOGA_BACKUP_DEST:-}"
if [ -z "$DEST" ]; then
  echo "hoga-ops-backup: HOGA_BACKUP_DEST 가 비어 있다 — ~/.config/hoga-ops/deploy.env 참고" >&2
  exit 1
fi

DATA_DIR="${HOGA_DATA_DIR:-$HOME/.local/share/hoga-ops/data}"
if [ ! -d "$DATA_DIR" ]; then
  echo "hoga-ops-backup: 원본이 없다: $DATA_DIR" >&2
  exit 1
fi

# 센티널 가드. 이게 없으면 --delete 가 사고를 낸다: 외장 디스크가 안 붙었거나
# 경로에 오타가 나면 rsync 는 **빈 디렉터리를 정상 대상으로 보고** 백업본을
# 원본(=빈 상태)에 맞춰 지운다. 즉 백업이 있다고 믿는 순간 백업이 사라진다.
# 운영자가 대상에 한 번 만들어 두는 파일로 "여기가 진짜 그 대상"을 표시한다.
#
# 센티널은 원본에 없으므로 아래 rsync 의 `P`(protect) 필터로 지켜야 한다 —
# 안 그러면 --delete-excluded 가 첫 실행에서 **센티널 자신을 지우고**, 두 번째
# 실행부터 이 가드가 영구히 거부한다(실측으로 잡은 자기파괴).
if [ ! -e "$DEST/.hoga-backup-root" ]; then
  echo "hoga-ops-backup: 센티널이 없다: $DEST/.hoga-backup-root" >&2
  echo "  대상이 마운트되지 않았거나 경로가 틀렸을 수 있다. 확인 후" >&2
  echo "  touch '$DEST/.hoga-backup-root' 로 한 번 표시할 것." >&2
  exit 1
fi

# 제외 대상 = 재생성 가능하거나 죽은 트리. raw/ 는 301GB 인데 parquet 의 파생
# 입력일 뿐이라 뺀다(지우면 그 날짜를 재파싱할 권리만 잃는다 — ADR-0135 가 이미
# 같은 판단으로 회수를 승인했다). 나머지는 캐시·텔레메트리·휴지통이다.
exec rsync -a --delete --delete-excluded --human-readable --stats \
  --filter='P /.hoga-backup-root' \
  --exclude='/raw/' \
  --exclude='/kis-past-indicators/' \
  --exclude='/kis-past-candles/' \
  --exclude='/timing/' \
  --exclude='/cache/' \
  --exclude='/_trash_*' \
  --exclude='*.tmp' \
  --exclude='.queue.lock' \
  "$DATA_DIR/" "$DEST/"
