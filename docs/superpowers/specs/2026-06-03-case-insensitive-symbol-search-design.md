# 종목 검색 대소문자 무시 (case-insensitive symbol search)

- 날짜: 2026-06-03
- 브랜치: `worktree-case-insensitive-symbol-search`
- 범위: 종목명 검색만 (코드 검색 분기는 변경하지 않음)

## 문제

종목명 검색이 영문 대소문자를 구분한다. 입력한 케이스가 종목명과 정확히 일치해야만
매칭되어, 사용자가 `cj`(소문자)를 입력하면 `CJ`로 시작하는 종목이 검색되지 않는다.

근거 데이터 (symbol-master.json, 총 2,770종목):

- 라틴 문자가 섞인 종목명: **379개** (`CJ`, `BGF`, `AK홀딩스`, ETF류 등)
- 소문자까지 섞인 종목명: **9개** — `KTcs`, `KTis`, `S-Oil`, `iM금융지주`,
  `JYP Ent.`, `SM Life Design`, `iMBC`, `원익QnC`

매칭 로직은 백엔드·프론트 두 곳에 중복 구현되어 있어 둘 다 동일하게 고쳐야 한다.

## 목표 / 비목표

**목표**

- 종목명 부분문자열 매칭과 그 정렬을 대소문자 무시로 만든다.
- 백엔드(`/api/symbols`)와 프론트(클라이언트 측 필터링)의 동작을 일치시킨다.
- 기존 한국어 종목명 검색·정렬 동작을 완전히 보존한다.

**비목표 (이번 범위 밖)**

- 코드 검색 분기(`isdigit()` 게이트) 변경. 영문자가 섞인 코드(`00104K`류 69개)는
  현재 코드로 검색되지 않으나, 이번 작업에서 다루지 않는다 (별도 이슈).
- 검색 매칭 로직의 백엔드·프론트 중복 제거 리팩터링.

## 접근법

채택: **매칭 시점 인라인 소문자화** (검토한 3안 중 1안).

- 쿼리는 루프 밖에서 1회만 소문자화한다.
- 각 종목명은 매칭/정렬 비교 시점에 `.lower()` / `.toLowerCase()`로 소문자화한다.
- 데이터 모델 변경 없음. 한글은 소문자화가 no-op이라 기존 결과·정렬이 보존된다.

대안과 기각 이유:

- **2안 — `SymbolHit`에 `name_lower` 사전 계산 캐싱**: 쿼리당 소문자화를 회피하지만
  데이터 모델·직렬화 변경과 동기화 책임이 늘어난다. 2,770건/서브밀리초 규모에 과한
  최적화(YAGNI)라 기각.
- **3안 — `casefold()` 유니코드 케이스폴딩**: JS에 대응 함수가 없어 백/프론트 의미가
  갈라진다. 종목명은 ASCII A–Z + 한글뿐이라 이득이 없고 복잡도만 증가해 기각.

## 변경 상세

### 백엔드 — `hoga/api/symbols.py` `search()` (593–610줄)

종목명 분기(608–609줄)만 변경:

```python
# 변경 전
matches = [h for h in _cache if q_norm in h.name]
matches.sort(key=lambda h: (not h.name.startswith(q_norm), len(h.name)))

# 변경 후
q_lower = q_norm.lower()
matches = [h for h in _cache if q_lower in h.name.lower()]
matches.sort(key=lambda h: (not h.name.lower().startswith(q_lower), len(h.name)))
```

빈 쿼리 분기와 숫자(코드) 분기는 변경하지 않는다.

### 프론트엔드 — `frontend/src/capture/useSymbols.ts` `filterSymbols()` (18–33줄)

종목명 분기(25–31줄)만 변경:

```typescript
// 변경 전
const matches = hits.filter((h) => h.name.includes(norm));
matches.sort((a, b) => {
  const ap = a.name.startsWith(norm) ? 0 : 1;
  const bp = b.name.startsWith(norm) ? 0 : 1;
  // ...
});

// 변경 후
const lower = norm.toLowerCase();
const matches = hits.filter((h) => h.name.toLowerCase().includes(lower));
matches.sort((a, b) => {
  const ap = a.name.toLowerCase().startsWith(lower) ? 0 : 1;
  const bp = b.name.toLowerCase().startsWith(lower) ? 0 : 1;
  // ...
});
```

빈 쿼리 분기와 숫자(코드) 분기는 변경하지 않는다.

## 보존되는 동작 (회귀 방지 체크리스트)

- 빈 쿼리 → 앞에서 N개 (변경 없음)
- 숫자 쿼리 → 코드 접두사 분기 (변경 없음)
- 한글 종목명 → 결과·정렬 순서 완전 동일 (소문자화 no-op)
- 접두사 우선 정렬 유지, 단 대소문자 무시 (예: `cj` → 길이순으로 `CJ`(2자)가
  `CJ대한통운`보다 앞)

## 테스트 (TDD: red → green)

**백엔드 — `tests/test_api_symbols.py`**

- 소문자 쿼리 `cj` → `CJ`로 시작하는 종목 매칭
- 대문자 쿼리 `KTCS` → `KTcs` 매칭
- 혼합 `s-oil` → `S-Oil` 매칭
- 한글 쿼리 → 기존 매칭·정렬 불변

**프론트엔드 — `frontend/src/capture/useSymbols.test.tsx`**

- `filterSymbols`에 대소문자 무시 매칭 케이스 추가
- 대소문자 무시 상태에서도 접두사 우선 정렬 유지 검증

## 검증 게이트

- 백엔드: `uv run --extra dev pytest tests/test_api_symbols.py`
- 프론트: `cd frontend && npx vitest run useSymbols && npx tsc -b`
