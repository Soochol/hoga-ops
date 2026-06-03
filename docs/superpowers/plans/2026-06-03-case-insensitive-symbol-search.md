# 종목 검색 대소문자 무시 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 종목명 검색을 영문 대소문자 무시로 만들어, `cj`/`ktcs`/`s-oil` 같은 입력으로도 `CJ`/`KTcs`/`S-Oil`이 검색되게 한다.

**Architecture:** 매칭 시점 인라인 소문자화. 백엔드(`hoga/api/symbols.py`의 `search()`)와 프론트(`frontend/src/capture/useSymbols.ts`의 `filterSymbols()`) 두 곳의 종목명 분기에서, 쿼리는 루프 밖에서 1회 소문자화하고 각 종목명은 비교 시점에 `.lower()`/`.toLowerCase()`한다. 데이터 모델 변경 없음. 한글은 소문자화가 no-op이라 기존 동작이 보존된다. 코드 검색(숫자) 분기와 빈 쿼리 분기는 건드리지 않는다.

**Tech Stack:** Python (FastAPI, pytest), TypeScript/React (vitest, tsc)

**작업 디렉터리:** 모든 명령은 워크트리 루트 `/home/dev/code/hoga-ops/.claude/worktrees/case-insensitive-symbol-search` 에서 실행한다. 백엔드 테스트는 `uv run --extra dev pytest`(dev deps가 optional group이라 `--extra dev` 필수), 프론트는 `cd frontend && npx vitest run` + `npx tsc -b`.

---

### Task 1: 백엔드 — `search()` 종목명 매칭 대소문자 무시

**Files:**
- Modify: `hoga/api/symbols.py:600-610` (`search()` 종목명 분기 608-609줄)
- Test: `tests/test_api_symbols.py` (기존 `test_search_filters_by_name` 아래에 새 테스트 추가)

- [ ] **Step 1: 실패하는 테스트 작성**

`tests/test_api_symbols.py`의 `test_search_filters_by_code_prefix`(118줄) 바로 아래에 추가한다. 기존 파일의 `_stub_pykrx` 헬퍼(20줄)와 `asyncio.run(...refresh...)` 패턴을 그대로 따른다:

```python
def test_search_name_is_case_insensitive(monkeypatch, tmp_path):
    """영문 종목명은 입력 케이스와 무관하게 매칭된다 (한글은 영향 없음)."""
    _stub_pykrx(
        monkeypatch,
        kospi=[("058850", "KTcs"), ("010950", "S-Oil"), ("001040", "CJ")],
        kosdaq=[],
    )
    path = tmp_path / "sm.json"
    asyncio.run(symbols.refresh(path=path, data_dir=tmp_path))
    # 소문자 쿼리 → 혼합 케이스 종목명 매칭
    assert [h.code for h in symbols.search("ktcs", limit=5)] == ["058850"]
    # 대문자 쿼리 → 혼합 케이스 종목명 매칭
    assert [h.code for h in symbols.search("S-OIL", limit=5)] == ["010950"]
    # 소문자 쿼리 → 대문자 종목명 매칭
    assert [h.code for h in symbols.search("cj", limit=5)] == ["001040"]
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `uv run --extra dev pytest tests/test_api_symbols.py::test_search_name_is_case_insensitive -v`
Expected: FAIL — `assert [] == ["058850"]` (현재 `q_norm in h.name`이 대소문자를 구분하므로 `"ktcs"`가 `"KTcs"`에 매칭 안 됨)

- [ ] **Step 3: 최소 구현**

`hoga/api/symbols.py`의 `search()` 종목명 분기(608-609줄)를 다음으로 교체한다. 빈 쿼리 분기(601-602줄)와 숫자 코드 분기(603-606줄)는 그대로 둔다:

```python
    # Name substring (case-insensitive)
    q_lower = q_norm.lower()
    matches = [h for h in _cache if q_lower in h.name.lower()]
    matches.sort(key=lambda h: (not h.name.lower().startswith(q_lower), len(h.name)))
    return matches[:limit]
```

- [ ] **Step 4: 테스트 통과 확인 (신규 + 기존 회귀)**

Run: `uv run --extra dev pytest tests/test_api_symbols.py -v`
Expected: PASS — 신규 `test_search_name_is_case_insensitive` 통과, 기존 `test_search_filters_by_name`(한글 `삼성`)·`test_search_filters_by_code_prefix` 등 전부 통과

- [ ] **Step 5: 커밋**

```bash
git add hoga/api/symbols.py tests/test_api_symbols.py
git commit -m "feat(symbols): 종목명 검색 대소문자 무시 (백엔드 search)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: 프론트엔드 — `filterSymbols()` 종목명 매칭 대소문자 무시

**Files:**
- Modify: `frontend/src/capture/useSymbols.ts:24-32` (`filterSymbols()` 종목명 분기)
- Test: `frontend/src/capture/useSymbols.test.tsx` (`describe('filterSymbols')` 블록에 케이스 추가)

- [ ] **Step 1: 실패하는 테스트 작성**

`frontend/src/capture/useSymbols.test.tsx`의 `describe('filterSymbols', ...)` 블록(25-48줄) 안, `respects limit` it 블록(45-47줄) 앞에 추가한다. 기존 `HITS` 픽스처(16-23줄)와 동일한 `SymbolHit` 형태(`captured_breakdown`에 `invalid` 포함)를 쓰는 영문 픽스처를 블록 안에서 선언한다:

```typescript
  it('name match is case-insensitive', () => {
    const en: SymbolHit[] = [
      { code: '058850', name: 'KTcs', market: 'KOSPI', captured_count: 0,
        captured_breakdown: { complete: 0, source_partial: 0, client_incomplete: 0, invalid: 0 } },
      { code: '010950', name: 'S-Oil', market: 'KOSPI', captured_count: 0,
        captured_breakdown: { complete: 0, source_partial: 0, client_incomplete: 0, invalid: 0 } },
      { code: '001040', name: 'CJ', market: 'KOSPI', captured_count: 0,
        captured_breakdown: { complete: 0, source_partial: 0, client_incomplete: 0, invalid: 0 } },
    ];
    expect(filterSymbols(en, 'ktcs', 10).map((h) => h.code)).toEqual(['058850']);
    expect(filterSymbols(en, 'S-OIL', 10).map((h) => h.code)).toEqual(['010950']);
    expect(filterSymbols(en, 'cj', 10).map((h) => h.code)).toEqual(['001040']);
  });
  it('case-insensitive query keeps prefix-first then length ordering', () => {
    const en: SymbolHit[] = [
      { code: '000120', name: 'CJ대한통운', market: 'KOSPI', captured_count: 0,
        captured_breakdown: { complete: 0, source_partial: 0, client_incomplete: 0, invalid: 0 } },
      { code: '001040', name: 'CJ', market: 'KOSPI', captured_count: 0,
        captured_breakdown: { complete: 0, source_partial: 0, client_incomplete: 0, invalid: 0 } },
    ];
    // 'cj'는 둘 다 접두사 매칭(ap=bp=0) → 이름 길이순: 'CJ'(2자)가 'CJ대한통운'보다 앞
    expect(filterSymbols(en, 'cj', 10).map((h) => h.code)).toEqual(['001040', '000120']);
  });
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd frontend && npx vitest run useSymbols`
Expected: FAIL — `name match is case-insensitive`에서 `expected [] to equal ['058850']` (현재 `h.name.includes(norm)`이 대소문자를 구분)

- [ ] **Step 3: 최소 구현**

`frontend/src/capture/useSymbols.ts`의 `filterSymbols()` 종목명 분기(24-32줄)를 다음으로 교체한다. 빈 쿼리 분기(20줄)와 숫자 코드 분기(21-23줄)는 그대로 둔다:

```typescript
  // Name match (case-insensitive): prefix-matches first, then substring matches; secondary sort by name length.
  const lower = norm.toLowerCase();
  const matches = hits.filter((h) => h.name.toLowerCase().includes(lower));
  matches.sort((a, b) => {
    const ap = a.name.toLowerCase().startsWith(lower) ? 0 : 1;
    const bp = b.name.toLowerCase().startsWith(lower) ? 0 : 1;
    if (ap !== bp) return ap - bp;
    return a.name.length - b.name.length;
  });
  return matches.slice(0, limit);
```

- [ ] **Step 4: 테스트 통과 + 타입 체크**

Run: `cd frontend && npx vitest run useSymbols && npx tsc -b`
Expected: PASS — 신규 2개 + 기존 `filterSymbols`/`useSymbols`/`useSymbolSearch` 케이스(한글 `삼성` 포함) 전부 통과, `tsc -b` 에러 0

- [ ] **Step 5: 커밋**

```bash
git add frontend/src/capture/useSymbols.ts frontend/src/capture/useSymbols.test.tsx
git commit -m "feat(symbols): 종목명 검색 대소문자 무시 (프론트 filterSymbols)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 최종 검증 게이트

두 태스크 완료 후 워크트리 루트에서:

- [ ] 백엔드: `uv run --extra dev pytest tests/test_api_symbols.py -v` → 전부 PASS
- [ ] 프론트: `cd frontend && npx vitest run useSymbols && npx tsc -b` → 전부 PASS, 타입 에러 0

수동 확인(선택): 백/프론트 dev 서버 기동 후 `/live` 또는 `/capture` 검색창에 `cj`, `ktcs`, `s-oil`을 입력해 매칭되는지 확인.
