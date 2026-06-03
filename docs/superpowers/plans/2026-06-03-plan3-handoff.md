# Plan 3 (Screener 일일 factor 자동화) — 실행 핸드오프

> 새 세션용 자기완결 브리프. 이 파일을 읽고 Plan 3을 **설계→구현**한다. 이전 세션 맥락 없이 시작 가능.

## 0. 한 줄 목표
새 코퍼레이트 액션(분할 등)이 생겨도 **수정주가가 자동으로 정확하게 유지**되도록, EOD 흐름에 자동화를 끼운다. (안 하면 새 분할마다 "64% 미보정" 버그가 다시 누적된다.)

## 1. 먼저 읽기 (순서대로)
- `CLAUDE.md` — 프로젝트 관례(테스트·dev 서버·/browse 등).
- `docs/superpowers/specs/2026-06-02-screener-daily-update-design.md` — **설계 본체.** 특히 §4 데이터흐름, **D1**(±30% 감지)·**D5**(월 순환)·**D6**(16:00 가드), §5 에러처리, §9 해결된 질문.
- `docs/adr/0057-screener-kis-authoritative-factor-store.md` — 핵심 결정(원주가×계수, KIS 정식 소스).
- `docs/superpowers/plans/2026-06-03-screener-factor-store-phase1.md` + `2026-06-03-screener-factor-backfill-phase2.md` — 이미 구현된 것.
- 코드: `hoga/api/screener_factors.py`, `screener_store.py`, `screener_backfill.py`, `screener.py`(`trigger_update`, `_kis_fetch_one`), `scheduler.py`(`_daily_run`, `seconds_until_next_17_kst`), `live/lifecycle.py`(`ensure_kis_client_from_env`).

## 2. 현재 상태 (Phase 1 + Plan 2 코드 착지, 브랜치 `worktree-rosy-weaving-unicorn`)
- **수정주가 = 원주가(SSOT, append-only) × KIS 계수(`factors.parquet`)**, `derive_adjusted`가 파생(ADR-0057). 계수 없으면 기존 `adjust_splits` 휴리스틱 폴백.
- **Phase 1**: factor store 기계 — `compute_factor_segments`, `pair_raw_adj`, `segments_to_frame`, `write_factors`, `read_factors`(스키마 손상 시 격리·폴백), `apply_factors`(join_asof + extend-backward). `derive_adjusted(unadjusted_path, out_path, *, factors_path=None, unadjusted_df=None)`.
- **Plan 2**: 1회 백필 — `screener_backfill.py`의 `factor_backfill`(KIS 수정주가→factors.parquet, resumable, per-code try/except), `reconcile_raw`(원주가 검증+결측 보충, 비덮어쓰기), `build_impact_report`, `run_backfill`/`run_backfill_with` + `screener-backfill` CLI.
- **⚠️ 확인 필요**: `hoga screener-backfill`이 **이미 실행됐는지**(factors.parquet 존재?) 확인. 아직이면 Plan 3은 코드만 작성하고, 실제 효과는 백필 RUN + 다음 EOD부터.
- **일일 갱신은 이미 존재**: 스케줄러 EOD(KST 17:00) + 부팅 복구 + 수동 `POST /api/screener/update` → `screener.trigger_update` → KIS 원주가 append → derive. **단 아직 (a) 계수 갱신도, (b) 장중 가드도, (c) stocks 메타 갱신도 안 함.** Plan 3가 이걸 추가.

## 3. Plan 3 범위 — 4가지 (EOD 흐름에 통합)
1. **action_detector** — 액션 종목 플래그: 단일 거래일 원주가 종가비가 일일 등락한계(±30%)를 넘으면(`close/prev_close < 0.70` 또는 `> 1.43`) 거의 확실히 분할/병합(정상 거래는 한계 못 넘음). 양방향(분할·액면병합) 포착. **한계 미만 희석(유상증자)은 여기서 못 잡음** → 월 순환이 안전망.
2. **factor_refresh** — 플래그 종목 + **월 1/30 순환**(놓친 희석 자가 교정)에 대해: 그 종목 KIS 수정주가 재수신 → `pair_raw_adj`+`compute_factor_segments`로 계수 세그먼트 재계산 → `factors.parquet` upsert(`factor_backfill`의 단일-종목 변형 재사용 권장). **감지는 로컬(싸게)지만 *정확한 비율은 반드시 KIS*에서** — 로컬 대략 비율이 원래 64% 버그의 원인이므로 factor 값으로 절대 쓰지 말 것.
3. **16:00 장중 가드** — 거래일 바는 세션 마감 후에만 ingest: `D < today_kst` OR `now_kst ≥ 16:00 KST`일 때만. **ingest 지점에서 집행**(KIS가 미확정 오늘 행 줘도 컷오프 전이면 드롭) → 부팅 복구가 장중에 돌아도 미완성 당일 바 안 들어감. (스펙 D6; 반장 12:30 마감도 안전.)
4. **stocks 메타 갱신** — `stocks.parquet`(name/market/is_etf/is_halted)은 시드 이후 고정 → symbol-master 기반으로 주기 갱신(신규상장·상폐·거래정지 반영).

→ 모두 `screener.trigger_update` / `scheduler._daily_run`(EOD 경로)에 통합.

## 4. 이미 정해진 결정 (재론 금지 — 스펙/ADR에 있음)
- factor store(원주가×계수), KIS 정확 계수, **per-code 재계산이 today-basis 소급 이동을 처리**.
- 감지 트리거 = 로컬 ±30% 한계 초과 / 정확 비율 = KIS 재수신.
- **월 1/30 순환** = 한계 미만 희석 안전망.
- **16:00 컷오프**.
- KIS 수정주가는 거래량도 보정함(실측 확인) — `apply_factors`가 가격×계수·거래량÷계수로 거래대금 보존.

## 5. 관례 / 함정 (이전 페이즈 교훈)
- 테스트: **`uv run --extra dev pytest ...`** (bare `uv run pytest`는 "No module named pytest"로 죽음 — dev deps 옵션 그룹).
- 커밋: **`git add <정확한 경로> && git commit`** — `git add -A`/`.` 금지, `git commit --only` 금지(hook 차단). 메시지 본문 끝 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- 워크트리에서 작업. **동시에 커밋하는 서브에이전트 금지**(git index 레이스).
- **KIS 호출은 callable로 주입** — 테스트는 fake, 프로덕션은 `KisClient.fetch_past_daily_candles(code, frm, to, *, adjust=...)` 래핑(`adjust=True`=수정주가, `False`=원주가). 패턴: `screener.py:_kis_fetch_one`, `screener_backfill.run_backfill`. **per-code try/except**(한 종목 실패가 다중-종목 run 중단 금지).
- **Harness Pyright/LSP squiggle은 신뢰 불가**(신규 심볼/파일에 stale; polars `.min()` 반환·dict 키 타입 등 거짓양성 다수) — 반드시 `uv run --extra dev pytest`로 검증, squiggle로 판단 X.
- Plan 3 직전 전체 스위트 green 기준: **1141 passed**.

## 6. 진행 방식
**superpowers:writing-plans**로 Plan-3 구현 플랜 작성(설계는 대체로 스펙에 있음 — 아래 열린 점만 먼저 다듬기) → **superpowers:subagent-driven-development**로 실행(TDD, 태스크별 리뷰). Phase 1·Plan 2와 동일. 구현 후 일일 흐름은 KIS 목킹으로 테스트, 실효과는 다음 EOD/백필 RUN부터.

## 7. Plan 3이 못 박아야 할 열린 점
- action_detector가 `trigger_update`의 **어디서** 도는지(원주가 append 후·derive 전) + `prev_close`를 어디서 읽는지(방금 append된 새 행 vs 코퍼스 직전 종가).
- factor_refresh 단일-종목 KIS fetch 깊이(백필 fetch 재사용; 깊은 역사는 extend-backward가 처리).
- 순환 슬라이스 선택(코드 해시 % 30 등 결정적).
- stocks 메타 갱신 주기(매일 vs 주간) + symbol-master 읽는 경로(`resolve_symbol_master_path`).
- 16:00 가드가 `trigger_update`의 기존 갭-거래일 로직과 어떻게 맞물리는지.
- (관찰) action_detector는 Plan-1 fix들과 무관하지만, factor_refresh의 계수 upsert는 `apply_factors` extend-backward(전체가 seg_start 이전이면 earliest factor로 채움)에 의존 — 그 계약 유지.
