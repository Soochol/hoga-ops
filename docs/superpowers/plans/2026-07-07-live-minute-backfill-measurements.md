# /live 분봉 백필 실측 (플랜 Task 1·8)

측정 환경: `HOGA_PERF_DEBUG=1` 백엔드(:8001, 워크트리 코드), 엔드포인트 직접 호출
(브라우저 드래그의 불안정성 회피). 디스크 캐시는 로컬 공유분 사용. 2026-07-07.

방법론 노트: past-candles의 read-ahead는 응답 반환 **후** 발사되는 fire-and-forget
이라, cold 응답 wall-clock은 baseline KIS 청크 비용을 그대로 반영한다(read-ahead가
응답을 지연시키지 않음). 캐시 미스는 캐시된 코드(005930)의 캐시 범위 밖 과거 창
(2025년 7-8월, 최古 캐시=20250924)으로 유발.

## 좌측 팬이 실제로 발사하는 쿼리 (핵심)

프론트 확인: 과거 델타는 `useRangeHogaDelta`(mode=hoga) + `useRangeSidecarDelta`
(mode=sidecar) + `/api/live/past-candles`. **mode=full은 팬 경로가 아님**(초기/today
풀뷰용). 렌더는 atomic 게이트(useLiveBundle)로 이 셋이 모두 settle될 때까지 대기 →
체감 지연 = **가장 느린 쿼리**.

| 쿼리 | cold (캐시 미스) | warm (재조회) | 표본 |
|---|---|---|---|
| **past-candles (KIS)** | **1552–2570 ms** | **8 ms** | 5거래일 창 ×3 |
| /api/range `mode=hoga` | 26–35 ms | — | ×3 |
| /api/range `mode=sidecar` | 169–184 ms | — | ×3 |

**팬 렌더 대기 = max(위 셋):**
- cold: `max(2570, 35, 184) = 2570 ms` → **past-candles가 지배**(sidecar의 ~14배, hoga의 ~73배)
- 워밍 적용 후(past-candles→8ms): `max(8, 35, 184) ≈ 184 ms` → 팬이 **~2.6s → ~0.2s**로 붕괴

### past-candles cold/warm 상세 (005930, 20250811–20250818, 5거래일)
- COLD (KIS fetch): **2570 ms**, 1905 candles, fresh=5일, cached=3일(공휴일/주말 empty 자동저장)
- WARM (재조회): **8 ms** → **327배**
- perf 로그 분해: 개별 `past_candles_fetch`(하루≈4 KIS 페이지) 97–168 ms; 전체
  `past_candles_collect` 2562 ms. warm 재조회 4.3ms(동일 처리, KIS 없음) → cold의
  **~99.7%가 KIS 경로**(네트워크 + 스케줄러/토큰버킷 페이싱), 캔들 처리는 무시 수준.

## 참고: mode=full (팬 경로 아님)

초기/today 풀뷰가 쓰는 `mode=full`은 peak-wall 쿼리(ask/bid peaks, trade-volume-poc,
ADR-0085 계열)를 포함해 비쌈:
- cold(엔진 웜업 포함, 첫 호출): 23,767 ms
- cold(엔진 웜, 창별 peak-cache 콜드): 7,044–8,081 ms (5일 창 ×3)
- warm(재조회): 299–384 ms

이는 **다른 인터랙션(종목 선택/초기 풀뷰)의 비용**이며, 사용자가 제기한 "과거 차트
이동(팬)" 지연과는 별개다. 팬은 mode=hoga/sidecar(저렴)만 발사한다.

## 프리펜드 API 경계 통합 go/no-go

- 사후 기준, 팬 청크 체감을 지배하는 것: **past-candles (KIS), ~90%+**. /api/range 팬
  델타(hoga+sidecar 합 ~200ms)는 지배적이지 않음.
- **판정: NO-GO.** "past-candles + /api/range 단일 응답 + useLiveBundle 게이트 제거"
  경계 통합은 팬 지연을 줄이지 못한다 — /api/range 팬 델타가 이미 저렴하기 때문.
  이번에 랜딩한 **워밍 + read-ahead가 지배 병목(KIS ~2s)을 정확히 겨냥한 올바르고
  충분한 수정**임이 실측으로 확정됨.
- (별개 잔여) mode=full 초기 풀뷰의 7–8s 콜드 peak 비용은 "팬"과 무관한 별도
  최적화 대상. 초기 로드 체감이 문제되면 그때 독립적으로 다룬다.
