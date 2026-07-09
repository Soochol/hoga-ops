# 0094 — 한 data dir당 캡처 큐 소유자는 하나 (flock)

**Status:** accepted (2026-07-09)

**Related:**
- ADR-0019 — restore-before-spawn 순서 불변식 (소유자만 restore·spawn)
- ADR-0042 — fail_streak cap (이중 캡처가 streak을 이중 오염시키던 부작용도 차단)

## Context

한 사용자 머신에서 백엔드 인스턴스가 둘 이상 같은 `data_dir`
(`~/.local/share/hoga-ops/data`)을 공유하는 일이 흔하다: 메인 체크아웃(:8000)과
워크트리 도그푸드 백엔드(:8011/:8012)가 동시에 뜬다. 두 인스턴스 모두 부팅 시
`.queue.json`을 restore하고(ADR-0019) 각자 워커 풀을 스폰한다.

그 결과 두 워커가 **같은 Stock-Date를 동시에 캡처**한다. 두 orchestrator가
같은 `(code, date)`의 `_progress.json`과 `raw/*.tsv`를 서로 덮어쓴다 — 실측으로
`started_at`이 두 부팅 시각 사이를 왕복하고 `pages_done`이 역행하는 것을 확인했다
(대한항공 003490/20260707, 2026-07-09). 캡처 데이터 자체는 global_seq dedupe로
살아남지만, 진행 상태(재개 커서)가 오염되고 업스트림을 두 배로 때린다. 또한 각
워커가 done+not-COMPLETE로 끝나면 fail_streak가 두 배로 오른다(ADR-0042).

## Decision

`data_dir`당 캡처 큐 소유권을 `<data_dir>/.queue.lock`에 대한 advisory
`flock(LOCK_EX | LOCK_NB)`로 배타화한다. 소유자만이:

- 매니페스트를 restore하고(ADR-0019 순서 유지),
- 워커 풀을 스폰하고,
- 큐 뮤테이션을 `.queue.json`에 persist한다.

비소유 인스턴스는 **읽기 전용**으로 부팅한다:

- **restore하지 않는다.** 비소유자가 stale한 큐를 restore하면 그 워커가 소유자와
  같은 Stock-Date를 도는 바로 그 사고가 재발한다. 워커를 안 띄우는 것보다 이게
  더 중요하다.
- **`_persist_queue_locked`는 no-op.** 소유자가 실시간 관리 중인 `.queue.json`을
  덮어쓰면 진실의 원천이 깨진다.
- 뮤테이션 엔드포인트(enqueue/retry/cancel/cancel-all/resume/unblock)는 HTTP 503
  `queue_not_owned`를 반환한다. 조회(GET /queue)와 차트·인벤토리 등 모든 읽기
  경로는 정상 동작한다. `QueueSnapshot.queue_owned=false`로 프론트가 배너를
  띄운다.

### 왜 flock인가 (pid 파일이 아니라)

`flock`은 프로세스가 종료·크래시하면 커널이 자동 해제한다. stale 락 정리 로직을
잘못 짤 여지가 없다. 락은 열린 fd에 묶이므로 프로세스 수명 동안 fd를 열어 둔다
(닫으면 해제). `--reload` 재기동은 구 프로세스 teardown과 신 프로세스 boot가
겹치므로, 획득 실패 시 0.5s×4회 재시도해 후속 프로세스가 선행 프로세스의 락을
넘겨받게 한다.

### 옵트아웃

`HOGA_CAPTURE_QUEUE_DISABLED=1`이면 락 경합 없이 읽기 전용으로 부팅한다. 도그푸드
백엔드가 명시적으로 "나는 캡처 안 함"을 선언하는 용도다. 설정하지 않아도 flock이
동일하게 보호하므로 필수는 아니다.

## Consequences

- 워크트리 도그푸딩(:8011/:8012 관행)은 그대로다: 자동으로 비소유가 되어 차트·조회는
  전부 동작하고 캡처 enqueue만 503으로 안내된다. 워크트리에서 캡처 테스트를 하려면
  메인을 내리면 락이 풀린다.
- **로컬 파일시스템 전제.** `flock`은 로컬 FS에서 신뢰할 수 있다. NFS는 범위 밖
  (data_dir이 로컬이므로 무관).
- 테스트: 모듈 전역 `_queue_owned`/ownership fd는 `reset_state_for_tests()`가
  소유 기본값(True)으로 복원한다 — 비소유 테스트가 다음 테스트에 503을 누출하지
  않게. 기본값 True라 `_data_dir`을 직접 쓰는 기존 persistence 테스트는 무수정.
