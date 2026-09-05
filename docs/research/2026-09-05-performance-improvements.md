**성능 개선 구현 결과 — 2026-09-05**

[초기 리뷰](2026-09-05-performance-review.md)의 세 항목을 `codex/performance-search-and-live-buffer` 브랜치에 반영했다. 비교 기준은 `fd3cbe3c7f8ecf582cf61dd583c109a60bb29059`다.

| 개선 | 변경 전 | 구현 후 확인 |
| --- | --- | --- |
| 빠른 패턴 조건 변경 | 봉수 5→10 연타에 HTTP 6개, 패널을 닫아도 fetching 6개 | 25ms 간격 연타 후 최종 HTTP 1개, 닫으면 signal 취소·fetching 0개 |
| 최근 기간의 과거 패턴 검색 | 전체 이력을 계산한 뒤 기간 필터 | 해당 종목의 시작 위치부터 계산; 합성 데이터의 warm 검색 484.44→72.26ms |
| 같은 종목의 실시간 창 8개 | 프레임당 버퍼 push 8회·서로 다른 반환 배열 8개 | push 1회·공유 반환 배열 1개; 한 창 종료 후 나머지 갱신 유지 |

**패턴 요청 수와 작업 대기**

[usePatternSearch.ts](../../frontend/src/pattern/usePatternSearch.ts)는 새 네트워크 요청 전 150ms 동안 입력 변경을 모으고, React Query의 AbortSignal을 fetch까지 전달한다. 캐시에서 바로 제공하는 결과에는 이 대기가 없다. now와 history 모두 최신 봉수만 요청하며 대기 중 패널을 닫으면 HTTP를 보내지 않는다.

[ReadRequestCoalescer](../../hoga/api/request_coalescer.py)는 패턴 라우트의 동일 요청을 하나의 계산으로 합친다. HTTP 연결 종료를 기다리며, 마지막 호출자가 떠나면 공유 작업을 취소한다. 한 호출자의 종료가 다른 호출자의 검색까지 취소하지 않도록 참조 수를 센다.

[ComputeExecutor](../../hoga/compute_executor.py)는 프로세스 풀의 워커 수만큼만 작업을 제출한다. 나머지는 취소 가능한 비동기 대기 상태로 남긴다. 호출자가 취소해도 이미 실행한 CPU 작업은 완료 때까지 자리를 보유한다. 실행 중인 계산을 강제 종료하는 기능은 아니다. 깨진 풀의 뒤늦은 완료 콜백이 교체된 새 풀을 폐기하지 않도록 풀 객체도 확인한다. API 단일 프로세스와 기존 워커 수 설정을 유지했다.

**검색 범위와 결과 보존**

[screener_pattern.py](../../hoga/api/screener_pattern.py)의 `search_history`는 종목별 `last_days`에서 `since` 경계를 먼저 찾는다. 상관·표준편차·거래량·거래대금·구조 관계 계산은 그 위치부터 배열 뷰로 수행한다. 매 요청마다 축소한 코퍼스를 복사하지 않는다.

전체 코퍼스에서 미리 계산한 이평, 원래 봉 offset, 자기 구간·날짜 겹침 제거, 이후 수익률, 길이 유연, 구조 게이트 전 분포·베이스라인을 보존했다. 일·주·월봉 × 이평 3종 × 구조 3종 × 거래량 2종 × 길이 유연 2종의 108개 조합과 날짜 지정 질의 2개에서 기존 전체 계산 경로와 응답을 대조했다. 추가 연산량 테스트에서는 3종목 × 7채널이 제외된 앞부분을 읽지 않고 선택한 100봉만 상관 계산하는 것을 확인했다.

실제 `run_pattern_search` 진입점을 기준 커밋에서 불러와 현재 코드와 비교했다. 동일한 합성 parquet 100종목 × 10,000봉에서 최근 252봉을 선택하고, 일봉·질의 15봉·길이 ±2·이평 5/20·상위 100개·최소 거래대금 50억·이후 20봉 조건으로 측정했다. 결과는 13~17봉의 다섯 검색 블록이다.

| 조건 | warm 경과 시간 | warm CPU 시간 | cold 경과 시간 |
| --- | ---: | ---: | ---: |
| 구조 OFF | 484.44 → **72.26ms** (6.70배) | 489.50 → 72.26ms | 577.44 → 183.26ms |
| 구조 running·허용 오차 2 | 832.67 → **121.14ms** (6.87배) | 832.37 → 121.13ms | 934.83 → 223.35ms |

warm은 코퍼스 캐시가 준비된 상태에서 교대로 7회, cold는 앱의 코퍼스 캐시를 비우고 교대로 3회 실행한 중앙값이다. cold도 OS 파일 캐시는 비우지 않았다. 코퍼스 로딩과 응답 모델 생성은 포함하며, 프로세스 생성·작업 큐·HTTP·브라우저는 제외한다. 모든 시행에서 `elapsed_ms`를 제외한 응답을 비교했으며 부동소수는 절대·상대 오차 각각 `1e-8`, 나머지는 정확히 일치했다.

측정은 다른 빌드·테스트가 끝난 뒤 같은 Python 3.14.4, NumPy 2.5.2, Polars 1.41.0 런타임에서 수행했다. 이전 리뷰의 축소 코퍼스 실험본과 다른, 구현 완료 후의 실제 검색 함수 측정이다. [측정 JSON](2026-09-05-performance-review-evidence/implemented-pattern-result.json), [재현 코드](2026-09-05-performance-review-evidence/implemented_pattern_benchmark.py).

**실시간 버퍼 공유**

[sharedLiveSeries.ts](../../frontend/src/api/sharedLiveSeries.ts)는 종목·KST 거래일별 버퍼, WS 구독, 150ms flush를 공유한다. venue별 필터 결과는 내용이 같으면 같은 참조를 반환한다. REST 메타데이터는 기존 venue별 Query 캐시에 둔다. 늦게 도착한 REST는 기존 창의 이력과 아직 flush하지 않은 WS 꼬리를 합친다. 같은 시각에 여러 체결·호가가 있을 수 있으므로 전체 프레임 내용과 반복 횟수로 겹침을 제거하며, 서로 다른 프레임은 모두 보존한다. 같은 시각의 최신 상태는 기존 WS 프레임이 마지막에 오도록 유지한다.

마지막 소비자가 떠나면 버퍼와 타이머를 회수한다. venue 변경·마지막 KRX 호가 폴백·StrictMode 재구독을 검증했고, 거래일 시계는 자정 및 탭 복귀 때만 날짜 변경을 알린다. 기존 15분 보존과 kind별 60,000개 상한을 유지했다. 8→1은 중복 버퍼 처리와 반환 배열 수의 측정이며 전체 렌더 시간이나 전체 메모리의 8배 개선을 뜻하지 않는다.

**최종 검증**

머지 준비 시 `main`의 최대벽 기능(`6f3290e22`)을 통합했다. 독립 리뷰에서 같은 시각의 서로 다른 REST 프레임을 누락하는 문제를 발견해 수정했다. 수정 전 7개 실패를 확인한 뒤, 여섯 kind의 중복·반복·중첩 JSON 키 순서·venue 격리·재수화 테스트가 모두 통과했다.

- 프론트 전체: `npx vitest run` — **530파일, 7,070개 통과**.
- 백엔드 전체: `uv run --extra dev pytest -q -m 'not wallclock'` — **4,766개 통과, 2개 skip, wallclock 13개 제외**. 이 테스트는 워크트리의 Python 3.12.13 환경에서 실행했다.
- 브라우저 E2E: `npx playwright test` — **36개 통과**. 최종 실행에 Vite production build 포함. 기존 큰 청크 경고는 남아 있다.
- `npm run typecheck`, 변경한 TS/TSX의 ESLint, `uv run --extra dev ruff check .`, `git diff --check` 통과.
- E2E는 격리 포트 20325/21325와 빈 증권사 자격 증명으로 실행했다. 사용자 개발 서버 8000/5173과 운영 API는 사용하지 않았다.

운영 환경에서의 혼합 부하 p95와 1/4/8창 React commit 시간은 이번 로컬 검증의 측정 범위 밖이다. 코드 개선과 회귀 검증을 완료했으며 배포는 수행하지 않았다.

검색 벤치마크는 저장소 루트에서 실행한다. `PYTHONPATH=.`로 현재 워크트리 코드를 사용한다. 위 수치를 재현하려면 위와 같은 Python·라이브러리 버전을 사용해야 한다.

```bash
PYTHONPATH=. uv run python docs/research/2026-09-05-performance-review-evidence/implemented_pattern_benchmark.py
```
