# 플랜: 무인 운영 감독 배선 (1인 사용자 P0-1)

2026-07-31. `docs/research/2026-07-31-market-launch-readiness.md` 의 1인 사용자
우선순위 첫 항목. "장중 프로세스/태스크 사망 → 영구 데이터 구멍" 창을 닫는다.

> **구현 중 정정 (2026-07-31).** 이 플랜은 원래 "코드 수정 없이 설정·배선만" 이라고
> 적었다. 틀렸다. 구현 전 실측에서 **정상 부팅한 백엔드가 `/health?deep=1` 에 503 을
> 낸다**는 것이 드러났다(`dead_tasks: ["symbols-boot-refresh"]`). 판정 로직이 일회성
> 부팅 태스크의 **정상 완료를 죽음으로 읽고** 있었기 때문이다. 이 상태로 3단계
> 타이머를 걸면 정상 시스템을 홀드오프 주기마다 영원히 재시작한다 — 하려던 일의 정반대다.
> 따라서 감독 배선에 앞서 `_task_health` 에 `completed` 상태를 도입했다(§0 참고).
> 시그널을 소비하기 전에 시그널이 옳은지 확인해야 한다는 교훈이 이 플랜의 핵심 기록이다.

## 0. 선행 수정 — deep health 오탐 두 건 (완료)

**(a) 일회성 부팅 태스크가 `dead` 로 보고됐다.** `symbols-boot-refresh`(.mst 재다운로드
1회)와 `watchlist-catchup`(미보유 거래일 1회 훑기)은 제 일을 마치면 끝난다. 그런데
`_task_health` 는 감독 대상이 전부 무한 루프라는 전제로 `task.done()` 을 일괄 죽음으로
판정했다. 결과: 부팅 몇 초 뒤부터 deep health 가 영구 503, 프론트엔드 "배경 작업이
죽었습니다" 토스트도 상시 점등(둘 다 이번 작업과 무관하게 이미 존재하던 버그).

수정: `_task_health` 에 네 번째 상태 `completed` 를 추가했다 — 이름이
`_ONESHOT_TASKS` 에 있고 예외·취소 없이 끝난 태스크만 해당한다. 끝나면 안 되는 루프가
끝난 것은 여전히 `dead`(ADR-0064 실패 모드)이고, 일회성이라도 **예외로 끝났거나 취소된
것은 `dead`** 다. `task.exception()` 은 취소된 태스크에서 예외를 던지므로
`cancelled()` 를 먼저 본다 — 안 그러면 health 자체가 500 이 된다.

검증(실측): 수정 전 갓 부팅한 백엔드 = `HTTP 503 dead_tasks:["symbols-boot-refresh"]`
→ 수정 후 같은 조건(빈 `XDG_DATA_HOME` 으로 부팅 리프레시를 실제 생성) =
`HTTP 200 dead_tasks:[] symbols-boot-refresh=completed`.

**(b) `hoga-ops.service` 의 재시작 폭주 가드가 꺼져 있었다.**
`StartLimitIntervalSec`/`StartLimitBurst` 가 `[Service]` 에 있었는데 systemd 는 이 둘을
`[Unit]` 키로 읽는다 — `systemd-analyze verify` 가 "Unknown key name ... in section
'Service', ignoring" 으로 확인해 준다(systemd 255). 무시되면 가드가 없는 것과 같아
설정 오류로 즉시 죽는 프로세스를 5초 간격으로 영원히 되살린다. `[Unit]` 로 옮겼고
이제 `systemd-analyze verify` 가 무경고 통과한다. 이 가드는 3단계 홀드오프 설계가
"결정적 장애면 StartLimitBurst 가 서비스를 세운다" 고 기대는 대상이라 선행 조건이었다.

## 우선순위 전체 (1인 사용자 관점)

| # | 항목 | 성격 | 예상 규모 |
| --- | --- | --- | --- |
| **1** | **무인 운영 감독 배선 (이 플랜)** | 설정·배선 | 반나절 |
| 2 | 일일 오프사이트 백업 + 복원 리허설 | 스크립트 + cron | 반나절~1일 |
| 3 | 알림 2종 — 장중 수집 tick 정지, 쿠키 만료 | 소규모 스크립트/코드 | 1일 |
| 4 | 디스크 용량 경보 + kis-past-indicators 프루닝 | 소규모 코드 | 1일 |
| 5 | localStorage 설정 내보내기/가져오기 | 프론트 소규모 기능 | 1~2일 |
| 6 | KIS 분봉 디스크 캐시 (ADR-0095 Reversal 랜딩) | 코드 (설계 기존재) | 2~3일 |
| 7 | KIS 일일 누적 쿼터 실측 (ADR-0102 미검증 항목) | 측정·기록 | 관측 1일 |

순서 근거: 1 없이는 2~7 이 다 있어도 "죽은 채 하루를 보내는" 사고가 남는다. 2 는
디스크 장애라는 다른 축의 영구 소실을 막고, 3·4 는 사람이 개입해야 하는 상황(쿠키
만료·디스크 만수)을 18h 데드라인 안에 알게 한다. 5~7 은 편의·성능·리스크 확인.

## 왜 이게 1번인가 (전제 사실)

- 원본(hogaplay)은 ~18시간만 보존한다. 장중 수집 공백은 사후 복구가 불가능하다
  (README, ADR-0125).
- 앱 내부 워치독은 전부 프로세스 **안**에서만 동작한다. 프로세스 사망은 외부
  감독자만 덮을 수 있다 (`deploy/hoga-ops.service` 머리주석).
- 배경 태스크(당일 승격 루프·daily-loop·워치독 자신)는 조용히 죽어도 프로세스는
  살아 있어 systemd 가 못 잡는다. 부활 경로는 프로세스 재시작뿐 (ADR-0088).
- 이를 위한 판정 API 는 이미 있다: `GET /health?deep=1` 이 죽은 태스크가 하나라도
  있으면 503 + `dead_tasks` 목록을 반환한다 (`hoga/api/app.py` `_health`). 부팅
  중에는 200 + `"supervised_tasks": "unknown"` 을 주므로 기동 중 오탐이 없다.
  **없는 것은 이 503 에 반응하는 액추에이터뿐이다.**
- 감독자가 프로세스를 되살려도 `.env` 의 자동 시작 스위치가 꺼져 있으면 수집은
  재개되지 않는다 (README "운영" 절, `.env.example`).

## 산출물

1. 설치된 systemd user 유닛 `hoga-ops.service` (기존 파일 사용, 경로만 수정)
2. `.env` 자동 시작 플래그 2개 on
3. 신규 파일 3개:
   - `deploy/hoga-ops-health.sh` — deep-health 판정·재시작 스크립트
   - `deploy/hoga-ops-health.service` — 스크립트를 1회 실행하는 oneshot 유닛
   - `deploy/hoga-ops-health.timer` — 60초 주기 타이머
4. 검증 기록 (아래 체크리스트)

## 단계

### 1단계 — systemd 유닛 설치 (기존 파일)

```sh
mkdir -p ~/.config/systemd/user
cp deploy/hoga-ops.service ~/.config/systemd/user/
# WorkingDirectory=%h/code/hoga-ops 를 실제 체크아웃 경로로 수정
systemctl --user daemon-reload
systemctl --user enable --now hoga-ops
loginctl enable-linger "$USER"   # 로그아웃 후에도 유지 (노트북 필수)
```

검증: `systemctl --user status hoga-ops` 가 active, `curl -s
http://127.0.0.1:8000/health` 가 `{"status":"ok"}`.

**주의 — 개발 서버와의 포트 충돌**: 이 서비스가 :8000 을 점유한다. 핫리로드
uvicorn(:8000)으로 개발할 때는 `systemctl --user stop hoga-ops` 로 먼저 내리고,
끝나면 다시 올린다. 내린 동안은 감독이 없다는 뜻이므로 장중 개발은 피한다.
(워크트리 도그푸드 백엔드 :8011/:8012 는 flock 비소유 읽기 전용이라 무관 —
ADR-0094.)

### 2단계 — 자동 시작 플래그

`.env` 에:

```sh
HOGA_LIVE_STARTUP_ENABLED=true
HOGA_STARTUP_CATCHUP_ENABLED=true
```

`systemctl --user restart hoga-ops` 후 검증: `/api/live/status` 가 라이브 스트림
가동을 보고하고, catchup 이 미보유 거래일을 큐에 넣는지 캡처 큐 UI 로 확인.

### 3단계 — deep-health 재시작 타이머 (신규)

`deploy/hoga-ops-health.sh` (요지):

```sh
#!/usr/bin/env bash
# /health?deep=1 이 503 이면 hoga-ops 를 재시작한다.
# - 연결 실패(프로세스 다운)는 건드리지 않는다: Restart=always 가 담당.
# - 부팅 중은 API 가 200+unknown 을 주므로 오탐 없음.
# - 폭주 가드: 직전 재시작 후 HOLDOFF(기본 600s) 안에는 다시 재시작하지 않는다.
#   같은 태스크가 부팅 직후 반복 사망하면 재시작이 무의미하므로 로그만 남긴다.
set -u
STAMP="${XDG_RUNTIME_DIR:-/tmp}/hoga-ops-health.last-restart"
HOLDOFF=600
body=$(curl -sf --max-time 5 "http://127.0.0.1:8000/health?deep=1") && exit 0
code=$?
[ "$code" -ne 22 ] && exit 0          # 22 = HTTP 4xx/5xx. 그 외(연결 실패 등)는 무시.
now=$(date +%s)
last=$(cat "$STAMP" 2>/dev/null || echo 0)
if [ $((now - last)) -lt "$HOLDOFF" ]; then
  echo "deep-health still 503 within holdoff; NOT restarting (investigate journalctl)" >&2
  exit 0
fi
echo "$now" > "$STAMP"
echo "deep-health 503 → restarting hoga-ops. payload: $(curl -s --max-time 5 'http://127.0.0.1:8000/health?deep=1')" >&2
systemctl --user restart hoga-ops
```

`deploy/hoga-ops-health.service`: `Type=oneshot`, `ExecStart=<체크아웃>/deploy/hoga-ops-health.sh`.
`deploy/hoga-ops-health.timer`: `OnBootSec=120`, `OnUnitActiveSec=60`,
`AccuracySec=10`, `[Install] WantedBy=timers.target`.

설치:

```sh
chmod +x deploy/hoga-ops-health.sh
cp deploy/hoga-ops-health.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now hoga-ops-health.timer
```

설계 결정 두 가지:

- **연결 실패에는 반응하지 않는다.** 프로세스 다운은 `Restart=always` 의 영역이고,
  타이머까지 재시작을 걸면 기동 중인 프로세스를 이중으로 걷어찰 수 있다. 타이머의
  단독 임무는 "살아 있지만 태스크가 죽은" 상태(ADR-0064 실패 모드) 하나다.
- **홀드오프 600초.** 재시작해도 같은 태스크가 즉시 다시 죽는 결정적 장애라면
  재시작 반복은 무의미하고 `StartLimitBurst`(5회/5분)를 태워 서비스 자체를 세운다.
  1회 재시작 후 지속되면 로그를 남기고 사람을 기다린다 — 이 로그가 3번 항목
  (알림)의 트리거 후보이기도 하다.

### 4단계 — 검증 (실제로 죽여 본다)

| 시나리오 | 방법 | 기대 결과 |
| --- | --- | --- |
| 프로세스 사망 | `kill -9 $(pgrep -f "hoga serve" \| head -1)` | ≤5s 내 재기동(`RestartSec=5`), 자동 시작 플래그로 수집 재개, `/health` 200 |
| 타이머 정상 동작 | `systemctl --user list-timers hoga-ops-health.timer` / `journalctl --user -u hoga-ops-health -f` | 60초마다 실행, 200 이면 무동작 |
| 503 경로 | 스크립트를 `--max-time` 짧게 한 채 임시로 존재하지 않는 경로(404→exit 22)로 바꿔 1회 실행 | 재시작 발생 + 홀드오프 스탬프 생성, 두 번째 실행은 "NOT restarting" 로그 |
| 재시작 폭주 가드 | 위 상태에서 60초 내 재실행 | 홀드오프에 걸려 재시작 안 함 |
| StartLimit 소진 복구 | (문서 확인만) | `systemctl --user reset-failed hoga-ops && systemctl --user start hoga-ops` |

503 경로를 진짜 죽은 태스크로 재현하기는 어렵으므로(태스크를 고의로 죽이는 훅이
없다) 스크립트 분기 검증으로 갈음한다. 실전 503 은 발생 시 journald 에 payload
(`dead_tasks`)가 남으므로 사후 확인 가능하다.

### 5단계 — 운영 루틴 문서화

README "운영" 절에 타이머 설치 절차와 아래 명령을 추가하는 후속 커밋:

```sh
systemctl --user status hoga-ops              # 서비스 상태
journalctl --user -u hoga-ops -f              # 서버 로그
journalctl --user -u hoga-ops-health --since today   # 감독 타이머 동작 이력
systemctl --user list-timers                  # 타이머 스케줄 확인
```

## 롤백

```sh
systemctl --user disable --now hoga-ops-health.timer hoga-ops
```

`.env` 플래그를 되돌리면 수동 시작 모드로 복귀. 데이터·코드에 비가역 변경 없음.

## 명시적 비범위

- 알림(문자·텔레그램) — 3번 항목. 이 플랜의 홀드오프 로그가 그 입력이 된다.
- 백업 — 2번 항목.
- system 유닛(root) 승격, 컨테이너화 — 상용화 트랙(Phase 2)의 일이다. 1인 노트북
  운영에는 user 유닛 + linger 가 맞는 규모다.
