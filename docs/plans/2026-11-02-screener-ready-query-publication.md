# 갱신 일봉의 조회 자료 공개

일봉 관측 공개자는 원본 검증과 함께 조회용 자료를 완성한 뒤 스냅샷 포인터를 공개한다.
서버를 다시 시작해도 조회는 작은 요약 헤더와 압축 JSON 행을 읽는다. 과거 원본 관측,
잠정·충돌 판정, 정정 선택, 수량 근거, 원주가 자동 수집의 소유권은 바꾸지 않는다.
조회 속도와 공개 준비 시간은 별도로 측정한다.

`hoga.api.screener_daily_projection.summary(data_dir, manifest, code, stop=...)`는
확정 시각과 공급자 세션·정책을 반환한다. 행 본문을 열지 않는다.
`read(data_dir, manifest, code, stop=...)`는 기존 `Observation`과 정확한 원본 후보 행을 반환한다.
둘 다 핀한 manifest를 받아 해당 관측에 연결된 자료만 읽으며 파일을 쓰지 않는다.
오래된 manifest, 미준비 Code, 손상·미지원 자료는 원본 전체를 검증하는 경로로 간다.
원본이 손상되었거나 읽는 중 변경되면 확인되지 않은 결과 대신 오류를 반환한다.

스냅샷의 `daily_query.headers`가 Code별 헤더 ID를 묶는다. 헤더는 형식·검증 버전,
원본 관측 ID와 마지막 후보 ID, 재귀 후보의 모든 파일 수신증,
압축 본문 해시·길이와 확정 날짜 요약을 묶는다. 수신증은 실제 디스크 원본의 canonical
체크섬을 검증한 뒤 device/inode/size/mtime/ctime을 기록한다. 원본 경로에 같은 이름의
파일이 이미 있어도 메모리의 입력 값으로 디스크 검증을 대신하지 않는다.

공개자는 기존 `.writer.lock` 아래에서 본문, 헤더, 스냅샷을 fsync한 뒤 포인터를 교체한다.
최종 포인터 교체 전에는 스냅샷의 실제 디스크 값과 모든 헤더·본문·원본 의존성을 다시 확인한다.
원주가 가드, 수량·정정, 관측 공개가 같은 최종 commit 함수를 사용한다.
정정·가드 공개는 같은 원본 ID에 연결된 조회 자료를 유지한다.

파생 자료가 손상되면 명시적인 공개·준비 작업만 원본을 다시 검증한 후 정확한 예상
해시의 바이트로 원자적 복구할 수 있다. 이 예외는 조회용 헤더와 압축 본문에만 적용한다.
과거 원본 관측과 기존 스냅샷 파일은 복구 명목으로 덮어쓰지 않는다.
조회자는 손상된 자료를 복구하지 않는다. 기존 파일을 열고 있던 독자는 읽기 전후 파일
정체성이 달라졌거나 체크섬이 맞지 않으면 결과를 거부한다.

본문 한 Code의 상한은 압축 8 MiB, 해제 64 MiB다. 읽기·해제 중 상한을 적용하고
후행 압축 내용, 잘린 스트림, 다른 길이·스키마·원본 바인딩을 거절한다.
초과 관측은 원본 검증 경로를 유지하며 준비 보고서의 `oversized`에 남긴다.
메모리 재사용은 기존 64 MiB 합계, 8 MiB 항목, 1,536개 제한을 공유한다.
파일 수신증과 요약도 이 제한에 포함한다. 디스크에 pickle을 저장하거나 읽지 않는다.
공유 메모리 캐시는 포장·대기·복사 중 의존성이 바뀐 경우에도 오래된 값을 반환하지 않는다.

## 기존 스냅샷의 명시적 준비

자격증명이나 공급자 요청 없이 로컬에서 선택한 Code만 준비한다.
자동 시작 스캔이나 조회 중 마이그레이션은 없다.

```python
from pathlib import Path
from hoga.api.screener_daily_projection import prepare_existing_query_data

report = prepare_existing_query_data(
    Path("/isolated/data"), expected_snapshot="<pinned snapshot ID>", codes=["005930"],
)
```

작업은 원래 스냅샷을 수정하지 않고 같은 원본·정책을 가리키는 자식 스냅샷을 공개한다.
동시 공개가 있으면 선택한 원본 ID가 같은 경우에만 최신 메타데이터와 합친다.
원본 ID가 달라지면 거절한다. 선택 범위 밖의 원본을 읽지 않는다.
이미 같은 자료가 준비되어 있으면 새 스냅샷을 만들지 않는다.

반환 dict에는 `expected_snapshot`, `previous_snapshot`, `snapshot_id`, `no_op`,
`prepared`, `reused`, `oversized`, `compressed_bytes`, `decoded_bytes`,
`max_compressed_bytes`, `max_decoded_bytes`, `source_bytes`, `sizes`,
`elapsed_seconds`가 있다. `sizes`는 준비된 각 Code의 압축·해제 바이트 수다.
`source_bytes`는 해당 범위에서 중복을 제거한 원본 파일 크기의 합계다.
각 수치는 준비 비용·크기이며 실제 첫 조회 시간 측정을 대신하지 않는다.

## 검증

`tests/api/test_screener_daily_query_*.py`는 새 프로세스에서 모든 원본 관측 JSON 열기를
금지하고 확정·잠정·충돌·가드·정정의 전체 조회 자료가 원본 검증 결과와 같은지 비교한다.
요약의 본문 미열기, 원본·파생 자료 손상, 중첩 후보·같은 크기와 복원 mtime,
읽는 중 변경, 중단 지점, 독자 취소와 생존 대기자, 동시 가드 공개, bootstrap CAS와
멱등 실행도 확인한다. 실제 고정 코퍼스의 준비 크기와 첫 조회 시간은 별도 진단에 기록한다.
