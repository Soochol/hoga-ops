# 0150 — 관심종목 폴더의 저장 옵트인(capture_enabled) 제거

**Status:** accepted (2026-08-18)

**Supersedes:**
- **ADR-0079**(capture-enabled folders gate live storage) — "group opt-in decides *whether*
  a Code is saved" 를 **뒤집는다**. 관심종목에 있으면 저장 대상이다.

**Unchanged:** ADR-0070(폴더 다중 소속) · ADR-0116/0118(키움 WS 단일 저장 경로) ·
ADR-0142(히트맵 일일 캡처) · ADR-0034(일일 스케줄러 catch-up — 애초에 이 플래그를 읽지 않았다).

**결정 출처:** 사용자 확정 2026-08-18. 아래 실측을 제시하고 세 선택지(토글 유지+켜기 /
현상 유지 / 토글 제거)를 물어 **제거**를 골랐다.

## Context

ADR-0079 는 실시간 저장을 **폴더 단위 명시적 옵트인**으로 만들었다 — 신규 폴더는
`capture_enabled=False` 로 태어나고, 켜진 폴더의 멤버만 Capture Candidate 가 된다.
의도는 "체크한 그룹만 저장" 이라는 사용자 통제였다.

**그 의도가 실제로는 반대로 작동했다.** 2026-08-18 사용자 환경 실측:

| 항목 | 값 |
|---|---|
| 관심 그룹 | 2개, **둘 다 `capture_enabled=False`** |
| 관심종목 | 43종목 (매매후보1 41 · 최대거래량 장투 5) |
| 실제 `live_set` | **299 — 전부 히트맵 종목** |
| 키움 등록 | 690 / 1000 (앱키 5개, 여유 있음) |

즉 **관심종목은 한 종목도 실시간 저장되지 않고 있었다**. 사용자는 그 사실을 몰랐다 —
`capture_enabled` 를 드러내는 UI 가 편집 모달의 hover 토글 하나뿐이었고(#1387 이전에는
`pointer-events-none` 이라 hover 없이는 클릭조차 못 했다), 신규 폴더 기본값이 꺼짐이라
**"그룹을 만들고 종목을 넣었는데 저장이 안 되는" 것이 정상 경로**였다.

옵트인이 지키려던 것은 유한한 키움 등록 예산(200 × 앱키수)이다. 그런데:

- **예산은 여유였다**(690/1000). 관심종목 43개를 더해도 ~790 으로 들어간다.
- **히트맵(299)은 애초에 게이트가 없다** — `LiveSettings.heatmap_capture_enabled` 는
  rest30 정책과 함께 2026-07-17 에 제거됐고, `_compute_heatmap_codes` 는 전 엔트리를 넣는다.
  즉 예산의 대부분을 쓰는 쪽에는 옵트인이 없고, 43종목짜리 쪽에만 있었다.

**옵트인은 용량을 지키지 못했고 조용한 미저장만 만들었다.**

## Decision

`WatchlistFolder.capture_enabled` 와 그 표면 일체를 제거한다. **관심종목 폴더의 멤버는
전부 Capture Candidate 다** — 히트맵과 같은 규칙("등록 = 대상", ADR-0142)으로 통일된다.

제거 범위:

- `WatchlistFolder.capture_enabled`(on-disk) · `WatchlistFolderView.capture_enabled`(wire) ·
  `FolderCaptureRequest`
- `PATCH /api/watchlist/folders/{id}/capture` 라우트와 `set_folder_capture_enabled`
- `capture_ordered_codes` 의 폴더 게이트
- 프론트: `setFolderCaptureEnabled` · `useSetFolderCaptureEnabled` · `folderCaptureEnabled`
  폴백 · 편집 모달 토글/캡션 · 패널 「저장」 배지

용량 초과 시 동작은 그대로다 — `plan_storage_targets` 가 **관심종목 우선**으로 채우고
초과분은 미수집(경고 로그). 즉 선별이 필요해지면 그 우선순위가 담당하며, 사용자가 줄이는
수단은 관심종목/히트맵에서 **빼는 것**이다(둘이 같은 규칙이 됐다).

## Consequences

**저장 대상이 늘어난다.** 위 환경 기준 등록 690 → 약 790/1000. 예산이 빠듯한 환경에서는
히트맵 쪽이 먼저 잘린다(관심종목 우선). 계좌를 늘리거나 목록을 줄여 대응한다.

**기존 `watchlist.json` 은 그대로 읽힌다.** 파일에 남은 `capture_enabled` 키는 pydantic
`extra='ignore'` 로 무시되고 다음 save 에서 자연 소멸한다 — 값이 `false` 든 잘못된 타입이든
같다. `tests/test_api_watchlist_folders.py::test_load_v3_document_with_legacy_capture_enabled_key`
가 그 세 경우를 못박는다. **모델에 `extra='forbid'` 를 걸면 그 순간 부팅이 깨진다.**

**롤백은 데이터 손실 없이 가능하다.** 옛 코드는 키 없는 폴더를 기본값 `True` 로 읽으므로,
되돌리면 모든 폴더가 켜진 상태가 된다(제거 전의 꺼짐 상태는 복원되지 않는다).

**`capture_candidate`(wire, 코드 단위)는 상수 `true` 가 된다.** 값이 틀리지 않으므로 이
ADR 에서는 남긴다. 그 정리는 소비처인 `deriveStorageLabel` 이 이미 write-only 라는 발견과
함께 별도로 다룬다.

**되돌릴 때 필요한 것**: ADR-0079 를 되살리고 위 제거 범위를 복원한 뒤, 사용자가 폴더별로
다시 켜야 한다. 그래서 이 결정은 "선별이 필요 없다" 가 아니라 **"선별은 목록 자체로 한다"** 는
쪽에 건 것이다.
