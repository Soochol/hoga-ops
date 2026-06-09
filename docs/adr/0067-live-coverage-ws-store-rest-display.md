# 0067 — 라이브 커버리지: 관심종목 2계좌 WS(저장) + 보는종목 REST(표시전용) 하이브리드

**Status:** accepted (2026-06-09); **출시2 구현완료 (2026-06-09)** — 부품1(2계좌 인증)·부품2(이중 WS dynamic-N)·C4. 위험 #1(동일-IP 2소켓) 스모크 통과로 해소, 위험 #3(2계좌 토큰 경합) 소멸(account k>0 = approval key 전용, bearer 토큰 미사용). 실-KIS 장중 2계좌 enable 검증은 plan "수동 검증" 단계 대기. spec `2026-06-09-live-2account-ws-design.md`, plan `2026-06-09-live-2account-ws.md`.

**Amended (2026-06-10 — KIS 계정 분리 / account-split):** 본 ADR의 **"account k>0 = WS approval key 발급 전용(bearer 토큰·15콜/초 버킷 미사용)" 전제는 폐기됨.** account 1이 이제 background REST(REST 폴러·quotes·investor-net·Screener EOD/backfill)를 담당해, #53에서 유휴였던 account 1의 REST 15/s 버킷을 활용한다(role→account 라우팅 `kis_runtime.kis_for_role`: foreground=account 0 전용 / background=account 1, 총 30/s). 위험 #3(토큰 경합)은 "account k>0 bearer 미발급"이 아니라 **계정 분리(foreground/background를 다른 account로) + FM5 폴백**(account 1 REST 토큰 실패 → account 0, `_rest_auth_degraded` latch)으로 관리한다. 보는종목 REST(Viewed-Code Poll)의 "account 0 공유 버킷"도 background로 재배치돼 account 1을 쓴다(N=1/저하 시 account 0 폴백). 상세: CONTEXT.md "KisClient", `kis_runtime.kis_for_role`.

**Related:**
- ADR-0053 — Live push 단일 WebSocket (브라우저↔백엔드; 본 ADR의 KIS↔백엔드 업스트림 WS와 **다른 층위**)
- ADR-0064 — Live poller 침묵 사망 (REST 폴러 부활 시 감독 필수의 근거)
- ADR-0037 / ADR-0039 — Source 서브폴더 · 선호
- spec `docs/superpowers/specs/2026-06-09-live-watchlist-coverage-hybrid-design.md`
- CONTEXT.md "Live Set", "Live Capture"

## Decision

`/live` 장중 실시간 커버리지를 두 경로로 나눈다:

- **관심종목(Watchlist, ≤26)** — KIS WebSocket으로 수집한다. KIS는 appkey당 41등록, 종목당 3등록(호가 H0STASP0 + 체결 H0STCNT0 + 회원사 H0STMBC0)이라 1계좌 13종목 → **2계좌(2 appkey)로 ~26종목**. **이 경로만 디스크에 저장**한다(JSONL → Today Promotion → `kis_live` parquet). 사용자가 관심종목을 26개 이내로 관리하므로 **관심종목 = Live Set**.

- **보는 종목(activeCode가 관심종목 밖)** — 그 **1종목만 REST 폴링**(FHKST01010200 호가 + FHPST01060000 체결 + FHKST01010600 회원사, 2초 주기, account 0 공유 버킷)해서 **LiveBuffer에 publish — 화면 표시 전용, 디스크 저장 안 함**.

- **배타** — 한 종목은 둘 중 하나만. `live_set` 멤버십이 단일 권위: WS set 안이면 WS만, 밖이면 REST만.

## Why

WS는 sub-second지만 13종목/계좌 한도, REST는 종목 자유지만 15콜/초라 전종목은 8~24초로 느리다(키움도 동일 — REST 초당 5건으로 KIS보다 나쁨). 관심종목은 상시 분석 대상이라 빠른 WS + 저장이 맞고, 관심종목 밖은 "잠깐 호가 확인"이라 REST 화면 표시면 충분하다.

**REST를 표시 전용(저장 안 함)으로 둔 게 핵심이다.** REST가 `writer`/`promote`를 건드리면 같은 종목이 WS·REST 양쪽에 기록돼 JSONL이 혼합되고 체결강도가 이중계상된다(설계 적대 검토의 BLOCKER). 표시 전용이면 그 위험 구조가 *생길 수 없다*. 또 관심종목 밖 종목은 저녁 hogaplay 일배치 대상도 아니라(scheduler는 watchlist만 enqueue), 저장해봤자 "본 구간만 듬성듬성"이라 실익이 적다.

## 대안과 기각

- **전종목 REST 폴링** — 120종목 8~24초 주기. 준실시간이라 호가 모니터링 부적합 + 폴러 부하.
- **증권사 교체(키움)** — REST 초당 5건(KIS 20보다 나쁨), WS 종목 한도 공식 미확인, 신 API 프로덕션 검증 부족 → 이득 없음, 전환 비용만 큼.
- **단일 계좌** — 13종목 한계.
- **REST도 저장** — 혼합 JSONL · 이중계상 → 표시 전용으로 회피.

## Consequences

- **Live Set 정의 변경**: "Watchlist 상위 13" → "Watchlist 전체(≤26), 2계좌 WS". "14위↓ 장중 미수집" 문제 소멸(사용자가 26 관리; 초과 시 상위 26만 WS + 나머지는 보는 것만 REST로 graceful).
- **새 개념 Viewed-Code Poll**: 보는종목 REST 표시폴링(저장 없는 화면 전용; "polling capture" _Avoid_와 구별). 구현 후 CONTEXT.md에 등재.
- **REST 폴러 부활** — ADR-0064 교훈(예외 격리 + 사망 감지 + 거짓 health 금지) 필수.
- **디스크 저장 = 관심종목(WS)만.** 보는 종목은 화면에서 보는 순간에만 존재.
- 2번째 계좌의 동일-IP WS 2연결 가능성은 발급 후 스모크 테스트로 확정(다중 appkey→다중 세션은 외부 사례 입증).
