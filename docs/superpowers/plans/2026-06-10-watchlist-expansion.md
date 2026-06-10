# 관심종목 대폭 확장 — 적용 플랜 (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans 로 task별 실행. 본 플랜은 **코드 기능 구현이 아니라 실데이터 적용 런북**이라, TDD 단위테스트 대신 `dry-run → apply → --verify → 멱등 재실행 → 시각확인`의 관측 가능한 검증 게이트를 쓴다. 체크박스(`- [ ]`)로 추적.

**Goal:** 승인된 큐레이션(25폴더·120종목 → 36폴더·약 234종목)을 백엔드 `/api/watchlist` API로 **멱등·검증가능**하게 반영한다.

**Architecture:** 선언적 목표 JSON(`scripts/watchlist_curation_data.json`) + 멱등 applier(`scripts/apply_watchlist_curation.py`, urllib stdlib). 직접 파일편집 없이 API만 사용. 신규 폴더는 맨끝 append + 신규 종목은 미분류 경유라 **현재 Live Set(상위 13×계좌수) 기본 보존**. ETF(레버리지/인버스)는 마지막 폴더로 라이브셋 비대상화.

**Tech Stack:** Python 3 stdlib(urllib.request), FastAPI 백엔드(`hoga serve` / uvicorn :8000), 데이터 `~/.local/share/hoga-ops/data/watchlist.json`.

---

## 산출물 현황 (brainstorming/writing-plans에서 이미 생성·검증)

- ✅ **스펙**: `docs/superpowers/specs/2026-06-10-watchlist-expansion-design.md` (사장님 승인)
- ✅ **데이터**: `scripts/watchlist_curation_data.json` — renames 4 · new_folders 11 · folder_targets 29. 코드 126참조(신규 114 + 이동 12), symbol-master 전수 검증·중복배정 0.
- ✅ **applier**: `scripts/apply_watchlist_curation.py` — dry-run(기본)/`--apply`/`--verify`. ruff clean.
- ✅ **쓰기 경로 e2e 검증 완료**: 격리 백엔드(temp `HOGA_DATA_DIR` + KIS creds 비움 + 포트 8099, 사장님 실데이터·:8000 무관)에 `--apply` 전 경로 1회 실행 → **36폴더/234종목, `--verify` PASS, 멱등 재실행 0연산** 확인. 사장님 실데이터(25/120)는 무변경 확인.

**실행 게이트**: 백엔드(:8000) 가동 + 사장님 GO. 미충족 시 Task 2 이후 보류.

**보강 폴더 정렬**: `move`는 기존 멤버 **뒤**에 신규를 append(reorder=False). 즉 기존 폴더의 내부 순서는 보존되고 신규 주도주가 **하단**에 붙는다(예: LG이노텍이 심텍·코리아써키트 아래). 신규 폴더만 주도주 순으로 reorder.

## 파일 구조

| 파일 | 책임 | 상태 |
|---|---|---|
| `scripts/watchlist_curation_data.json` | 선언적 목표(무엇을) — renames/new_folders/folder_targets | 생성됨 |
| `scripts/apply_watchlist_curation.py` | 멱등 적용·검증(어떻게) — dry-run/apply/verify | 생성됨 |
| `docs/superpowers/specs/2026-06-10-watchlist-expansion-design.md` | 설계 근거·종목 전체·리스크 | 생성됨 |

## 롤백 안전장치

적용은 사장님 실데이터를 바꾼다. **적용 전 스냅샷 필수**. 백엔드가 `watchlist.json`을 원자적으로 저장하므로, 복구 = 백엔드 정지 → 스냅샷 복사 → 재기동. (기존 `watchlist.json.backup-*`도 존재하나 본 작업 전 시점.)

---

### Task 1: 사전 점검(Pre-flight) — 백엔드·데이터·계획 확인

**Files:** (읽기 전용)

- [ ] **Step 1: 백엔드 가동 확인**

Run: `curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8000/api/watchlist`
Expected: `200`
미가동이면(`000`/거부) 사장님께 백엔드 기동 요청 후 진행. 기동: CLAUDE.md "Dev servers" 참조
(`uv run uvicorn hoga.api.app:default_app --factory --host 127.0.0.1 --port 8000`).

- [ ] **Step 2: 적용 전 스냅샷(롤백용)**

Run:
```bash
cp ~/.local/share/hoga-ops/data/watchlist.json \
   ~/.local/share/hoga-ops/data/watchlist.json.pre-expansion-20260610
ls -la ~/.local/share/hoga-ops/data/watchlist.json.pre-expansion-20260610
```
Expected: 파일 생성됨(약 26KB).

- [ ] **Step 3: dry-run으로 계획 검토**

Run: `python3 scripts/apply_watchlist_curation.py | tail -4`
Expected 마지막 줄:
```
[미리보기(DRY-RUN) — --apply 로 실제 반영]
  리네임 4 · 폴더생성 11 · 종목추가 114(skip 0) · move 29 · reorder 11
```
숫자가 다르면 데이터/현재상태 점검(이미 일부 적용됐을 수 있음 — 멱등이라 안전하나 확인).

- [ ] **Step 4: 현재 상태 사후조건은 FAIL이어야 정상(검증기 변별력 확인)**

Run: `python3 scripts/apply_watchlist_curation.py --verify | head -2`
Expected: `검증: 25폴더 / 120종목` + `[FAIL] ...건:` (아직 미적용이므로 FAIL이 정상).

---

### Task 2: 적용(Apply) — 게이트: 사장님 GO 필요

**Files:**
- Modify(API 경유): `~/.local/share/hoga-ops/data/watchlist.json`

- [ ] **Step 1: 실제 적용 실행**

Run: `python3 scripts/apply_watchlist_curation.py --apply 2>&1 | tee /tmp/watchlist-apply.log`
Expected 요약:
```
[적용 완료]
  리네임 4 · 폴더생성 11 · 종목추가 114(skip 0) · move 29 · reorder 11
```
그리고 최종 폴더별 카운트 출력(아래 36폴더). `[FATAL]`이 보이면 즉시 중단하고 로그·Task 5 롤백 검토.

- [ ] **Step 2: 적용 직후 최종 구조 육안 확인**

Expected(요약): `최종: 36폴더 / 234종목`, 미분류 경고 없음.
선두 폴더(반도체-메모리/IDM …)가 그대로 상위 순서인지 확인(Live Set 보존).

---

### Task 3: 사후조건 검증(Verify) — 결정적

- [ ] **Step 1: 검증 스크립트 PASS 확인**

Run: `python3 scripts/apply_watchlist_curation.py --verify`
Expected:
```
검증: 36폴더 / 234종목
[PASS] 모든 리네임·신규폴더·종목배치 사후조건 충족, 미분류 0
```
`[FAIL]`이면 출력된 누락/오배치 항목을 move/add로 보정(스크립트 재실행은 멱등).

- [ ] **Step 2: 분할 결과 스팟체크**

Run:
```bash
curl -s http://127.0.0.1:8000/api/watchlist | python3 -c "
import json,sys
d=json.load(sys.stdin); fmap={f['id']:f['name'] for f in d['folders']}
for f in ['증권','화장품/뷰티','바이오-비만/대사','금융-은행/지주','음식료']:
    fid=next(k for k,v in fmap.items() if v==f)
    es=sorted([e for e in d['entries'] if e['folder_id']==fid],key=lambda e:e['order'])
    print(f, '->', [e['name'] for e in es])
"
```
Expected: 증권에 미래에셋·키움 등 + 한화투자증권·대신증권; 음식료에 삼양식품+CJ제일제당·오리온·농심·오뚜기; 바이오-비만/대사에 펩트론·한미약품 등. (한미약품이 바이오-대표/제약에 **없어야** 정상 — 이동 확인.)

---

### Task 4: 멱등성 확인

- [ ] **Step 1: 재실행 dry-run은 0 연산이어야 함**

Run: `python3 scripts/apply_watchlist_curation.py | tail -3`
Expected: `리네임 0 · 폴더생성 0 · 종목추가 0(skip 0) · move 0 · reorder ...` (move 0 = 모두 제자리). reorder는 멱등 PUT이라 표기될 수 있음.

- [ ] **Step 2: 재적용해도 무해함 확인(선택)**

Run: `python3 scripts/apply_watchlist_curation.py --apply | tail -2`
Expected: 추가/이동 0 또는 서버 no-op. 데이터 변동 없음(`--verify` 재PASS).

---

### Task 5: 시각 확인 — /heatmap(관심맵) & /live 패널

**Files:** (브라우저)

- [ ] **Step 1: 관심맵 렌더 확인**

Run(브라우저 스킬):
```bash
B=/home/dev/.claude/skills/gstack/browse/dist/browse
$B goto http://localhost:5173/heatmap && $B console --errors
```
Expected: 콘솔 에러 없음. 신규 폴더(AI데이터센터-전력/케이블, 유리기판, 양자기술 등)와 주도주가 맵에 보임.
(/heatmap 라우트 부재 시 — 스펙 §주 참조 — `/live` 또는 우측 관심종목 패널로 대체 확인.)

- [ ] **Step 2: 관심종목 패널 폴더 순서 확인**

`/live` 우측 패널에서 폴더 순서: 기존 반도체 폴더가 상단, 신규 폴더가 하단, **레버리지/인버스가 최하단**인지 확인.

---

### Task 6: Live Set 경계 점검(선택)

- [ ] **Step 1: 라이브 캡처 대상 상위 N 확인**

Run: `curl -s http://127.0.0.1:8000/api/live/status 2>/dev/null | python3 -m json.tool | grep -iE "live_set|codes" | head` (엔드포인트 명칭은 환경별 상이 — 없으면 skip)
Expected: live_set이 여전히 선두 반도체 위주(13×계좌수). 대량 추가로 등록 한도 초과 징후(`sub_failed`) 없음.
경계 미세이동(앞쪽 반도체 보강분만큼)은 스펙 §7 기재대로 정상. 특정 26-set 고정이 필요하면 별도 reorder(out of scope).

---

### Task 7: 커밋 결정 — 게이트: 사장님 GO 필요 (자동커밋 금지)

> 하드룰: **자동 커밋 금지.** 아래는 사장님이 명시적으로 "커밋" 지시할 때만.

- [ ] **Step 1: 커밋 대상**

```bash
git add docs/superpowers/specs/2026-06-10-watchlist-expansion-design.md \
        docs/superpowers/plans/2026-06-10-watchlist-expansion.md \
        scripts/watchlist_curation_data.json \
        scripts/apply_watchlist_curation.py
git commit -F - <<'MSG'
docs+tooling: watchlist 대폭 확장 큐레이션(120→234) 스펙·적용 스크립트

- 27개 테마 리서치(WebSearch 현재 대장주 + symbol-master 코드검증)
- 신규 폴더 11 + 분할/리네임 4, 신규 114종목·이동 12
- 멱등 applier(dry-run/apply/verify), 직접 파일편집 없이 API 경유

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
MSG
```
(관심종목 **데이터 변경 자체는 API로 이미 반영**되었으므로 레포 커밋 대상이 아니다 — 커밋은 스펙·스크립트 문서화용.)

---

## Self-Review 체크 (작성자 수행)

- **스펙 커버리지**: §3 폴더변경→Task 2(리네임/생성), §4·§5 종목→데이터 JSON+Task 2~3, §7 적용순서→applier 단계순, §7 Live Set→Task 6, §8 리스크(롤백)→롤백 절+Task 1 스냅샷. 갭 없음.
- **Placeholder**: 없음(모든 Step에 실명령+기대출력).
- **타입/명칭 일관**: 폴더 최종명(음식료/금융-은행/지주/건설/플랜트(중동)/바이오-대표/제약)이 데이터 JSON·verify·스펙에서 동일.
