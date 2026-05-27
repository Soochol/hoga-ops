# Inventory: per-Stock-Date Full Capture Count 컬럼

날짜: 2026-05-27
범위: backend (parser, models, queries) + frontend (StockDateGroupDetail, sortDates, types)

## 1. 배경 & 문제

`/inventory` 우측 상세 테이블은 한 종목의 Stock-Date 행들을 나열하지만,
"이 Stock-Date에 대해 Full Capture가 평생 몇 번 일어났는지"를 알 수 없다.
사용자는 어떤 날짜를 얼마나 자주 Retry(=재캡처)했는지 한눈에 보고 싶어한다.

ADR-0031의 `QueueItem.attempt`는 **한 캡처 작업 안에서의 Retry 누적 횟수**를
의미하며 큐가 drain되면 사라지므로 inventory의 영구 컬럼이 될 수 없다.
새로운 디스크 카운터가 필요하다.

## 2. 도메인 용어 & 기존 어휘 정합

이 spec에서 "재캡처"는 **Retry**와 동의어다 (CONTEXT.md "Retry" 정의 참조 —
inventory 의 ↻ 버튼은 [CONTEXT.md:102-114](CONTEXT.md#L102-L114)에서 분류한
**Implicit Retry** 경로를 사용한다). 별개의 개념이 아니다.

- **full_capture_count** (신규): 한 Stock-Date 디렉토리에 meta.json이 성공적으로
  쓰여진 누적 횟수. 즉 그 Stock-Date에 대해 **Full Capture**가 완성된 누적 횟수.
  초기 캡처 = 1, Retry 성공 = 직전값 + 1.
- **attempt** (기존, ADR-0031): 한 캡처 작업 안에서 Retry 클릭으로 누적되는
  카운터. 큐가 drain되면 사라진다.

두 카운터는 **직교**한다 — 묻는 질문이 다르다:
- `attempt` → "이번 캡처가 (실패 누적으로) 얼마나 힘들었나"
- `full_capture_count` → "이 Stock-Date가 평생 몇 번 Full Capture됐나"

예:
- 초기 캡처가 3번 Retry 끝에 성공 → `attempt=3`, `full_capture_count=1`
- 다음 달 Retry가 한 방에 성공 → `attempt=1`, `full_capture_count=2`

UI는 두 값 모두 `×N` 뱃지로 표시하되 위치가 다르다 — `attempt`는
[CaptureQueueRow.tsx:53](frontend/src/capture/CaptureQueueRow.tsx#L53) 큐 행에,
`full_capture_count`는 inventory 상세 테이블에 표시.

## 3. 데이터 모델

### 3.1 meta.json 스키마 (additive)

```json
{
  "code": "005930", "name": "삼성전자",
  "pages_collected": 12,
  "...": "...",
  "full_capture_count": 3
}
```

- `full_capture_count: int` — 옵셔널 필드. 1 이상의 정수.
- 누락(legacy meta) 시 의미는 "알 수 없음".

### 3.2 증가 규칙

`hoga/parser/__init__.py`의 parse 끝, meta.json 쓰기 직전:

1. `prior = json.loads((out_dir / "meta.json").read_text(...)).get("full_capture_count")`
   - 파일 없거나 필드 없으면 `None`.
2. `meta["full_capture_count"] = (prior or 0) + 1`
3. 기존 write_text 경로 그대로 기록 ([hoga/parser/__init__.py:166](hoga/parser/__init__.py#L166)) —
   meta.json 단일 파일이라 partial-write 윈도우는 기존과 동일하게 무시 가능.
   atomicity가 추후 필요해지면 `atomic_write_json` 도입 (이번 spec 범위 밖).

**무엇이 +1을 발생시키나**
- 초기 캡처 성공 → 1 (prior None + 1)
- Retry(force_retry 포함) 성공 → 직전값 + 1
- Resume(쿠키 만료 후 재개): meta.json은 한 번만 쓰임 → 자연스럽게 +1 정확
- Skip / Failed: parser 미도달 → 변동 없음

**race 안전성**: 동일 Stock-Date는 큐 dedup으로 동시 실행 불가
([hoga/api/captures.py](hoga/api/captures.py) `_dedup_against_in_flight` 참고).
순차 실행이라 read-then-write가 안전.

### 3.3 백엔드 모델

`hoga/api/models.py::StockDate`:

```python
full_capture_count: int | None = None
```

`hoga/api/queries.py::_compute_stock_date`은 이미 meta.json을 읽으므로 한 줄 추가:

```python
return StockDate(
    ...,
    full_capture_count=meta.get("full_capture_count"),
)
```

### 3.4 프론트엔드 미러 (ADR-0004)

`frontend/src/api/types.ts::StockDate`:

```ts
full_capture_count: number | null;
```

## 4. UI

### 4.1 컬럼 위치

`StockDateGroupDetail.tsx`의 테이블 헤더 순서:

```
| ↻ | State | ×N | Date | Captured | Volume | Pages | Size | OHLC |
```

State 컬럼 바로 우측.

### 4.2 렌더 규칙

| full_capture_count | 셀 내용 |
|---|---|
| `null` (legacy) | `—` (text-fg-dimmer) |
| `1` | 빈 셀 |
| `≥ 2` | `×{N}` (text-fg-dim font-mono tabular-nums) |

### 4.3 헤더

- 표시 라벨: `×N`
- `title` 툴팁: `Full Capture 누적 횟수`
- `aria-sort` 활성 가능 (정렬 가능 컬럼).

### 4.4 정렬

`frontend/src/inventory/sortDates.ts`에 `fullCaptureCount` SortKey 추가:

- 첫 클릭: `desc` (높은 횟수 우선 — 자주 Retry한 날짜 위로).
- `null`은 항상 마지막 (방향 무관).
- 사이클: none → desc → asc → none (다른 컬럼과 일치).

### 4.5 좌측 종목 카드 — 변경 없음

사용자가 "State 옆"으로 명시. 종목 카드는 이미 `N dates`로 그룹 크기를 표시
중이므로 좌측에 카운터 합계를 또 얹지 않는다 (중복/노이즈 회피).

## 5. 테스트

### 5.1 백엔드 (parser, queries)

- parser: 새 디렉토리 첫 캡처 → meta.json에 `full_capture_count == 1`
- parser: 기존 meta.json `full_capture_count: 2` → Retry 후 `3`
- parser: 기존 meta.json에 카운터 없음(legacy) → Retry 후 `1`
- queries: meta에 필드 없으면 `StockDate.full_capture_count is None`
- queries: meta에 `full_capture_count: 5` → `StockDate.full_capture_count == 5`

### 5.2 프론트엔드

- `StockDateGroupDetail.test.tsx`: 셀 3-way 렌더
  - `null` → `—`
  - `1` → 빈 셀
  - `5` → `×5`
- `sortDates.test.ts`: desc → asc → none 사이클, null은 정렬 끝
- 기존 픽스처에 `full_capture_count: null` 명시적 추가 (옵셔널이지만 명시)

## 6. 마이그레이션 & 운영

- **백필 없음.** 새 캡처가 일어나야 카운터가 자라기 시작.
- 기존 Stock-Date들은 `—`로 표시되다가, Retry될 때 카운터가 ON된다.
- 롤백 안전: 추가 필드는 additive — 코드 롤백해도 디스크 잔류 무해.
- FE 롤백 시 컬럼만 사라짐.

## 7. 비목표 (Non-goals)

- 캡처 타임라인/이력 (언제 each Full Capture 일어났는지) — 후속 작업.
- 좌측 종목 카드 집계 — 별도 요청 시 추가.
- `attempt`와 `full_capture_count`의 통합 — 의미 충돌로 의도적 분리.
- 백필 마이그레이션 — YAGNI.

## 8. 관련 ADR / 코드

- ADR-0004 (mirror 디시플린)
- ADR-0020 (DiskState)
- ADR-0031 (`attempt` 의미론 — `full_capture_count`는 이와 별개)
- [CONTEXT.md "Full Capture"](CONTEXT.md#L27), [CONTEXT.md "Retry"](CONTEXT.md#L101)
- [hoga/parser/__init__.py:140-168](hoga/parser/__init__.py#L140-L168) — meta.json 쓰기 지점
- [hoga/api/queries.py:127](hoga/api/queries.py#L127) — meta.json 읽기 지점
- [hoga/api/models.py:17](hoga/api/models.py#L17) — `StockDate`
- [frontend/src/api/types.ts:7](frontend/src/api/types.ts#L7) — TS 미러
- [frontend/src/inventory/StockDateGroupDetail.tsx:117](frontend/src/inventory/StockDateGroupDetail.tsx#L117) — 테이블 헤더
- [frontend/src/capture/CaptureQueueRow.tsx:53](frontend/src/capture/CaptureQueueRow.tsx#L53) — 기존 `×N` 뱃지 스타일 참조
