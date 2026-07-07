# 0090 — /live 분봉 백필: 선행 워밍 + read-ahead (인터랙션-결합 해소)

**Status:** accepted (2026-07-07)

**Related:**
- ADR-0087 — Foreground 우선순위 두 계층 (background lane 비굶주림 보장의 출처)
- ADR-0088 — 배경 태스크는 감독 통합이 아니라 관측 노출 (supervised task)

## Context

/live 분봉에서 과거로 팬하면 캔들이 늦게 뜬다. 원인은 파라미터가 아니라 결합
구조다: 데이터 가용성이 뷰포트 인터랙션에 결합되어, 팬하는 순간에 KIS 왕복
(하루당 순차 ~4콜, 120행/콜 캡)을 지불한다. settle-loop(useViewportBackfill 3a)는
청크를 직렬로 진행하므로 채우기 시간은 청크 수에 선형이다.

지난 거래일 분봉은 불변이라 (venue, code, date) 캐시는 한 번 채우면 영원히
히트한다. 시스템은 어떤 종목을 보게 될지(활성 탭)와 다음에 어떤 구간을 요청할지
(직전 청크) 이미 알고 있고, background 우선순위 레인(ADR-0087)도 이미 있다.
즉 예측 가능한 수요를 선지불할 부품이 모두 있었다.

## Decision

두 겹의 선행 캐시 채움을 추가한다. 둘 다 기존 뼈대(날짜 캐시, 캐퍼시티 스케줄러,
프론트 델타 fetch) 무변경 위에 얹힌다.

1. **종목 활성화 워밍**: 프론트가 활성 종목 변경 시(1.5s 디바운스)
   `POST /api/live/warm-past-candles`를 fire-and-forget으로 호출. 백엔드
   `LiveMinuteCandleBackfill.warm_minute`이 최근 60캘린더일의 미캐시 날짜를
   background 우선순위로 **순차** fetch한다. (venue, code) 단일 비행,
   supervised task(ADR-0088), 레이트리밋 시 즉시 중단.
2. **read-ahead**: `/api/live/past-candles`가 요청 구간을 서빙한 직후, 직전
   동일 폭 구간을 warm_minute으로 선행 워밍한다(250일 하한 클램프,
   레이트리밋/용량 경고 시 스킵). settle-loop의 다음 청크가 캐시 히트가 된다.

워밍은 순차(동시성 1)로 돌아 사용자 경로의 세마포어(3)와 KIS 예산을 점유하지
않는다. 단일 비행 키는 priority를 포함하지 않는다 — warm이 먼저 띄운 태스크에
사용자 요청이 올라타면 background로 대기하지만 ADR-0087의 비굶주림 보장으로
진전은 유지된다.

## Alternatives considered

- **전 종목 상시 사전 백필**: KIS 쿼터(15콜/초)와 분봉 보존(~1년) 대비 비용
  폭발. 관심종목 스코프 워밍이 같은 체감을 훨씬 싸게 준다. 기각.
- **프리펜드 API 경계 통합**(past-candles + /api/range 단일 응답, useLiveBundle
  원자화 게이트 제거): 근본적이지만 별도 서브시스템 규모. 실측에서 /api/range가
  지배적 병목으로 확인될 때 별도 ADR/플랜으로 진행한다. 보류.
- **프론트 청크 크기 확대**: 첫 페인트 지연 재발(/diagnose 2026-06-09의 90초
  블랭크 사례). 기각.

## Consequences

- 캐시 미스 팬의 체감 지연은 "매 청크 KIS 왕복"에서 "첫 청크만 KIS 왕복,
  이후 캐시 히트"로 바뀐다. 워밍이 이긴 경우 첫 청크도 히트.
- background 호출량 증가: 종목 전환당 최대 ~40거래일 × ~4콜. foreground 양보
  하의 background 레인이 흡수하고, 레이트리밋 신호에 즉시 중단한다.
- 워밍은 primary venue만 데운다 — KRX 폴백이 필요한 날짜는 인터랙션 경로가
  그때 처리한다(폴백 캐시는 도우면 이득, 없어도 기존과 동일).
- read-ahead가 라우트에서 모든 past-candles 요청에 발사되므로, 자기 요청 창의
  KIS 호출 목록을 정확히 단언하던 기존 라우트 테스트는 `_no_read_ahead_warm`
  픽스처(warm_minute 스텁)로 배경 fetch를 억제해 옵트인한다. read-ahead 실동작은
  별도 전용 테스트가 선행 창 fetch를 검증한다.
