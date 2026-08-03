# 0135 — 만료 미확정 갭 raw 회수: 2단계 옵트인

**Status:** accepted (2026-08-03)

**Related:**
- ADR-0075 — raw 보존 게이트("hogaplay COMPLETE 만 삭제")와 그 Trigger Condition
  ("비-COMPLETE raw 누적이 디스크를 위협하면 옵트인을 도입한다"). 이 ADR 이 그
  Trigger 의 **두 번째** 발화다.
- ADR-0131 — 만료 미확정 갭을 terminal 로 선언해 **재캡처를 중단**한 결정(1단계).
  거기서 명시적으로 "이 술어는 삭제 권한을 주지 않는다" 고 못박았고, 이 ADR 이
  그 유보를 해제한다(2단계).
- ADR-0093 / ADR-0126 — `upstream_gap_confirmed` 의 두 확정 경로.
- 프로덕션 레디니스 재감사(2026-08-03) — 성장률 재측정이 이 결정의 방아쇠.

## Context

무인 prod(ADR-0134)에서 raw 성장률을 다시 쟀더니 **거래일당 ~33GB** 였다
(`du` 4일 실측: 20260728 34G · 29 33G · 30 34G · 31 33G). 그때까지 문서가 전제하던
"하루 ~4GB" 의 8배다. 남은 디스크 여유(약 252GB) 기준으로 **7~8 거래일**이면
만수이고, 만수 순간부터 캡처·라이브 JSONL·승격이 전부 쓰기 실패한다.

기존 회수 수단(ADR-0075 기본 게이트 + `--include-confirmed-gaps` 옵트인)으로는
부족한 정도가 아니라 **거의 아무것도 회수하지 못한다**. 2026-08-03 `hoga prune`
dry-run 실측(디스크 여유 250 GiB / 937 GiB = 26.6%):

| 보존 사유 | 건수 | 크기 | 현행 처분 |
| --- | --- | --- | --- |
| `source_partial(gap_unconfirmed,expired)` | 1,235 | **169.0 GiB** | **영구 보존** |
| `client_incomplete` (resume 소스) | 580 | 54.0 GiB | 영구 보존(정당) |
| `within_grace` | 244 | 33.2 GiB | 유예 내(정당) |
| `source_partial(gap_confirmed)` | 227 | 30.9 GiB | 1단계 옵트인 시 회수 |
| `invalid` · `none` · `no_upstream_data` | 473 | 7.4 GiB | 영구 보존 |

**기본 게이트의 회수량은 0 dirs / 0.0 GiB 다** — COMPLETE 클래스가 비어 있어서
ADR-0075 의 게이트가 실질적으로 무동작이다. `--include-confirmed-gaps` 를 켜도
30.9 GiB 에 그친다. 지배 클래스(169 GiB, 전체 보존량의 55%)가 회수 대상 밖에
있고, 그 클래스는 계속 자란다.

그리고 그 미확정분의 거의 전부가 **원리적으로 확정될 수 없는** 상태다. 확정
경로는 둘뿐인데(재캡처가 동일 갭 재현 / 갭이 세션 경계에 접함), 후자는 파싱 시점에
이미 판정되므로 남은 것은 재캡처뿐이고, hogaplay 보유 창이 ~18시간이라 그 재캡처가
불가능하다. 2026-07-30 전수 실측: 미확정 1,344건 중 보유 창 **안**은 2건(0.15%),
가장 오래된 것은 2025-05-02 로 15개월째 같은 자리다.

## Decision

**보유 창 밖 미확정 갭(`is_expired_unconfirmed_gap`)의 raw 를 일일 prune 대상에
포함시킨다 — 단 별도 옵트인이고 기본은 off 다.**

- env: `HOGA_PRUNE_EXPIRED_UNCONFIRMED=true` (일일 스케줄러)
- CLI: `hoga prune --include-expired-unconfirmed` (수동·dry-run 우선)

**스위치를 `HOGA_PRUNE_CONFIRMED_GAPS` 와 합치지 않는다.** 두 클래스는 위험도가
다르다. confirmed 는 시스템이 "이 raw 를 다시 파싱해도 결과가 같다" 를 **관측으로**
확인한 상태다. expired-unconfirmed 는 "확인할 방법이 영원히 없다" 는 상태이고,
지우면 그 날짜를 다시 파싱할 권리를 영구히 포기한다. 결이 다른 결정을 한 스위치에
묶으면 한쪽을 원한 운영자가 다른 쪽까지 켜게 된다.

**경계는 그대로 유지한다.** `CLIENT_INCOMPLETE`(resume 소스)와 보유 창 **안**의
미확정 갭은 어느 옵트인으로도 삭제되지 않는다. 후자는 재캡처가 아직 유효하다.

## Consequences

- 무인 prod 의 권장 구성은 두 옵트인을 **모두** 켜는 것이다(합계 회수량 약
  200 GiB — 현재 여유 250 GiB 를 거의 배로 늘린다). 회수는 유예 기간
  (`HOGA_RETENTION_DAYS`, 기본 3일) 밖에만 적용되므로 최근 데이터는 안전하다.
- **되돌릴 수 없다.** 지운 raw 로 만들 수 있던 것은 지금 parquet 에 있는 것과
  같지만, "같다" 를 나중에 재검증할 방법은 사라진다. 그 날짜의 원본이 필요한
  분석(파서를 고쳐 재파싱 등)은 대상 날짜에 대해 영구히 불가능해진다.
- 그래서 기본은 off 다. 켜기 전 `hoga prune --include-expired-unconfirmed`
  (dry-run)로 회수량과 대상을 먼저 볼 것 — CLI 가 켜지 않은 상태에서도 그 행을
  `source_partial(gap_unconfirmed,expired)` 로 분리해 보여 준다.
- 이 옵트인은 디스크 문제의 **완치가 아니라 유예**다. 성장률 33GB/거래일 자체는
  줄지 않는다. 여유가 다시 임계에 닿는지는 `/health?deep=1` 의 `disk.free_pct` 로
  계속 봐야 한다.
