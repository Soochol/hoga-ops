# 0162 — 호가벽 급증 지표를 제거한다

**Status:** accepted (2026-08-26) — 사용자 결정. ADR-0161(단별 잔량 증감 제거)의 **하루
뒤 후속**이고, 그 ADR 이 "남는다" 고 적은 지표가 이번 대상이다.

**Related:**

- ADR-0161 — 단별 잔량 증감 제거. 그 문서 §「무엇이 남는가」의 `wall_surge` 문단은
  **이 ADR 로 무효**가 된다(본문은 그때의 사실이므로 소급 수정하지 않는다).
- ADR-0147 — RangeBundle 슬라이스 등록. 이 지표가 그 ADR 을 낳은 **사례**였다
  (PR 세 건 #1321 → #1325 → #1333). 등록 표에서 한 줄이 빠질 뿐 결정은 유효하다.
- ADR-0158 — 오늘분 지표 증분 커서(**rejected**). 분류표의 「호가벽 급증 = 상태 필요」
  행은 이제 대상이 없다.

## 무엇이 사라지는가

| 층 | 사라진 것 |
| --- | --- |
| 프론트 렌더 | `chart/WallSurgeMarkersPrimitive` · `live/LiveWallSurgeMarkers` · `indicators/WallSurgeConfig` · 카탈로그 글리프 |
| 프론트 상태 | `wallSurgeEnabled` · chartPrefs 의 `wallSurgeLabelEnabled`/`wallSurgeLabelCount` |
| wire | `RangeBundle.wall_surge` · `WallSurgeEventWire` · `WallSurgeKind`/`WallSurgeOutcome` 와 두 라벨 표 |
| 백엔드 | `build_wall_surge_slice` · `query_wall_surge` · `_wall_surge_candidates` · `_wall_surge_outcomes` · `WallSurgeRow` · 임계 상수 9개 |
| 캐시 | kind `wall_surge` |
| 도구 | `tools/scan_wall_surge.py` |

## 남는 것 — 형태가 유래를 품고 있다

**당일 최대벽의 순위 화살표(`PeakWallRankArrowsPrimitive`)는 그대로다.** 그 마커가
**축(shaft) 있는 화살표 + 순위 숫자**인 것은 유래가 있다: 같은 pane 에 급증의 **속 찬
삼각형**(▼/▲)이 공존해서, 숫자를 결정적 구분자로 삼아 둘을 갈랐다. 상대가 사라졌다고
형태를 되돌리지 않는다 — 레전드 ①②③ 과의 1:1 대응이 그 마커의 존재 이유다.
`peakWallArrowShape.ts` 의 `ARROW_SHAFT_WIDTH_PX` 주석에 그 사실을 남겼다.

**끊길 뻔한 지식 하나를 먼저 옮겼다.** 「상위 N 은 **화면에 든 것 중** 상위 N 이고,
그래서 선정이 build 가 아니라 draw 시점에 있다」는 설명의 원문이 급증 primitive 에
있었고 최대벽 화살표가 그것을 **참조**하고 있었다. 지우기 전에 참조하던 쪽으로
옮겼다(실측 근거 포함: 5거래일을 로드하고 하루만 보면 상위 4건이 다른 날에 몰려
화면엔 한 개도 안 뜬다).

`SurgeMarkersPrimitive`(총잔량 급증 근접 마커)는 **이름만 비슷한 다른 지표**다 —
`chartPrefs` 의 `surgeApproachPct` 가 그쪽 설정이고 그대로 남는다. lwc 기본
`createSeriesMarkers` 를 쓰지 않는 이유의 원문도 그 파일에 있어, 이번 삭제로 끊기지
않는다.

## 이 지표가 남긴 것 — 레지스트리

없어져도 **ADR-0147 은 이 지표 덕분에 존재한다.** 슬라이스 하나가 화면에 닿으려면
서로를 모르는 명시 열거 목록을 전부 지나가야 하는데(프론트 12곳 · 백엔드 14곳), 그
사실이 드러난 것이 이 지표의 3-PR 행군이었다. 등록 표의 `note` 는 마지막까지
「빌더는 `wall_surge_enabled` 를 받지만 `routes.py` 가 전달하지 않아 HTTP 로 도달
불가 … 토글을 살릴지 지울지가 미결」이라고 적혀 있었다 — **그 미결이 이렇게 닫혔다.**

## 잔여

1. **디스크 캐시의 고아 파일** `*.wall_surge.json` 은 읽는 코드가 없어져 남는다.
   사용자 데이터라 건드리지 않는다. 경로는 환경변수가 아니라 코드에서 뽑고
   (`$HOGA_DATA_DIR` 은 보통 셸에 없다 — ADR-0161 §잔여 참조), **지우기 전에 센다**:

   ```bash
   D=$(uv run python -c "from hoga.config import resolve_data_dir; print(resolve_data_dir())")/kis-past-indicators
   find "$D" -name '*.wall_surge.json' | wc -l
   find "$D" -name '*.wall_surge.json' -delete
   ```

2. **localStorage 의 `wallSurge*` 키**는 지표 설정 정규화가 화이트리스트라 조용히
   버려진다(ADR-0161 이 그 성질을 테스트로 못 박아 뒀다). chartPrefs 쪽 두 키도 같다.

3. **역사 서술은 소급 수정하지 않았다** — ADR-0147·0158, 성능 감사, DESIGN 체인지로그의
   언급은 그 시점의 사실이다. 살아 있는 도메인 문서인 `CONTEXT.md` 만 갱신했다.
