# /live 관심종목 2계좌 WS 26종목 — 출시2 설계

- **Date**: 2026-06-09
- **Status**: Designed — 선결 스모크 **통과(GO)**, 그릴링 + plan-eng-review 루프 반영(연결모델 dynamic-N 확정). 사장님 최종 검토 대기.
- **Topic slug**: `live-2account-ws`
- **Branch**: `live-2account-ws` (main 32c83ec=v0.7.5.0 출시1 위에서 시작)
- **Scope**: `hoga/live/kis_runtime.py`(부품1), `hoga/live/lifecycle.py`(부품2+C4). `stream.py`/`writer.py`/`buffer.py`/`ws_client.py`/`rest_poller.py`는 **무변경**(이미 code-keyed / 단일 주입).
- **부모 설계**: `docs/superpowers/specs/2026-06-09-live-watchlist-coverage-hybrid-design.md` (4장 부품1·2, 6장 출시2)
- **관련 ADR**: 0067(하이브리드 결정·본 설계 근거), 0064(poller 침묵사망 — watchdog 교훈), 0050(KIS 단일 ingress·approval key), 0043(Today Promotion), 0038(단일 워커 싱글톤)

---

## 0. 선결 결과 — ADR-0067 위험 #1 (유일 BLOCKER) **해소**

동일 IP에서 appkey 2개로 KIS WS **2소켓 30초 내내 동시 유지** 확인(2026-06-09 20:11 KST, 장외):

| 신호 | account 0 | account 1 |
|---|---|---|
| approval key 발급 | ✅ 36자 | ✅ 36자, **서로 다름** |
| 소켓 동시 연결(30s) | ✅ | ✅ |
| 구독 ACK(호가+체결+회원사) | **3/3, 거부 0** | **3/3, 거부 0** |
| 프레임 수신(PINGPONG=생존) | ✅ | ✅ |

**판정: GO.** 구독 ACK가 양쪽 3/3 = KIS가 두 appkey의 등록을 동시 수락 → **41등록 한도는 appkey별 독립**(13×2=26 안전). 스모크 스크립트는 `scripts/smoke_2account_ws.py`로 박아 수동 회귀로 보존(테스트 전략 §9 참조).

추가 발견(설계 단순화): `get_approval_key`는 bearer 토큰이 아니라 **appkey+secret을 직접** `/oauth2/Approval`에 POST(`kis_client.py:279-304`). WS 경로는 1분/회 토큰 쿨다운을 안 건드린다 → **위험 #3(2계좌 토큰 경합)은 account 1에서 소멸**(account 1은 REST 미사용 → bearer 토큰 자체를 안 받음).

---

## 1. 범위 = 부품1 + 부품2 + C4

| 항목 | 파일 | 크기 | 내용 |
|---|---|---|---|
| 부품1 | `kis_runtime.py` | medium | 프로세스 싱글톤 1쌍 → `account_id`별 dict |
| 부품2 | `lifecycle.py` | large | `_State` 단일 스트림 → N-스트림 리스트 + 파티션 + 연결별 watchdog/집계 |
| C4 | `lifecycle.py` | (부품2에 흡수) | 빈 watchlist에서 "WS 0 + poller 살아있음" 허용 |

**비범위(별도 deepening 0.7.5.1, main에서 새 브랜치)**: C2(Buffer 페이로드 seam 통합), C3(배지 표현 통합 `collectionStatusBadge.ts`). 본 출시2는 **백엔드 오케스트레이션 전용 — 프론트 코드 0줄**(§6 D 참조).

---

## 2. 결정 상태 (2026-06-09)

**그릴링 + plan-eng-review 루프 확정:**

- **B. 토큰 캐시 경로** *(승인)* — account 0은 기존 `kis-token.json` 유지(backcompat), 신규 계좌만 `kis-token-{id}.json`. account 1 = `kis-token-1.json`.
- **C. watchdog 재시작 정책** *(승인)* — **연결별 격리 복구**(죽은 연결만 재기동, blast-radius 최소). §5.6.
- **D. 한 연결 다운 시 정직성** *(승인 — 기본)* — `capture_healthy`=존재 연결 AND → 기존 전역 배너가 정직. `live_set`=assigned 불변. per-code 정밀 배지는 C3 이월. 대안(live_set=healthy 재정의)은 exclusivity invariant를 헬스에 묶어 **기각**(§6).
- **Q1. 연결 생명주기** *(결정 — dynamic-N)* — 코드 있는 파티션만 연결, 빈 part는 연결 없음. idle 2nd 소켓 베팅 회피 + watchdog churn 회피 + build/teardown 프리미티브를 watchdog와 공유. §5.2.
- **Q3. 2계좌 영구 고장** *(결정 — 운영 수용)* — `degraded_accounts` 필드 + watchdog WARNING으로 어느 키인지 고지(Q10). 복구 = 키 수정 또는 제거→N=1 폴백. 자동 강등 안 함(D 일관).
- **Q4. 파티션** *(결정 — 연속 슬라이스)*, **Q5. N변경=재시작**, **Q6. _restart_conn 프리미티브**, **Q9. 즉시·멱등 teardown(디바운스 폐기)**, **Q10. degraded_accounts 신규 필드(capture_reason 값 불변)**, **Q11. 존재 conn만 집계** — 상세 §5.
- **R1**(teardown≠close KisClient) · **R2**(즉시 멱등 teardown) — §5.2.

---

## 3. 핵심 seam — rest_poller 생명주기 분리 (C4가 여기서 공짜로 떨어진다)

**현재 결함**: `_start_live_stream_locked`(lifecycle.py:390)가 매 재시작마다 `_stop_live_stream_locked()`로 poller를 stop(472-473)하고 **빈 `_subscribed`로 새 poller를 생성**(437). watchdog 재시작(596)·refresh never-started 폴백(522)이 모두 이 경로 → **watchdog 재시작이 보는종목 구독을 날려 화면을 비우는 잠복 버그(출시1)**.

**변경**: rest_poller를 stream 생명주기에서 **분리**.
- creds(account 0) 있으면 **1회 생성, 전 stream/watchdog 재시작에 걸쳐 유지**.
- `_subscribed`(보는종목)는 ws.py의 subscribe/unsubscribe로만 변하고 stream 재시작에 불변.
- stream refresh/health 변화 시 **`set_excluded_codes`만 갱신**.

**효과**:
1. **C4 무료 해결** — "streams==[] + poller 살아있음"이 *N=0인 일반 경로*가 됨(빈 리스트 순회). get_status/watchdog/refresh에 빈 watchlist 특수분기 불필요.
2. **잠복 버그 동반 수정** — 어떤 stream 재시작도 보는종목 구독을 보존.

poller 소유권은 stream(`_StreamConn`)이 아니라 **모듈 `_state` 최상위**(`_state.rest_poller`)에 둔다 — 현재 위치 유지, 단 start/stop이 매번 재생성하지 않도록 라이프사이클만 분리.

---

## 4. 부품1 — 2계좌 인증 (`kis_runtime.py`)

### 현재
프로세스 전역 싱글톤 **1쌍**: `_kis_client`, `_kis_token_provider`(176줄). `ensure_kis_client_from_env(data_dir)`가 account 0 클라이언트 반환. 소비자: 휴장 경로·스크리너 EOD·`/api/live/quotes`·WS approval·REST poller — 전부 account 0 공유(15/s 버킷 1개).

### 변경: account_id별 dict
```python
_kis_clients: dict[int, KisClient] = {}
_kis_token_providers: dict[int, KisTokenProvider] = {}
_lock = threading.Lock()   # check-then-create 원자성 유지(기존과 동일)

def _account_env(account_id: int) -> tuple[str, str]:
    """account_id(0-based) → (KEY 환경변수명, SECRET 환경변수명).
    0 = KIS_APP_KEY/SECRET(접미 없음, 기존). N>0 = 접미 (N+1) = '사람이 세는 번호'
    → account_id=1 ↔ KIS_APP_KEY_2/KIS_APP_SECRET_2(사장님 '2번째 키'). 위험 #6 통일."""
    if account_id == 0:
        return "KIS_APP_KEY", "KIS_APP_SECRET"
    suffix = account_id + 1
    return f"KIS_APP_KEY_{suffix}", f"KIS_APP_SECRET_{suffix}"

def _token_cache_path(data_dir: Path, account_id: int) -> Path:
    """B: account 0 = 기존 kis-token.json(backcompat), N>0 = kis-token-{N}.json."""
    name = "kis-token.json" if account_id == 0 else f"kis-token-{account_id}.json"
    return data_dir / ".local" / name
```

**env 접미 규약(위험 #6 확정)**: account_id 0-based. account 0 = 접미 없음(기존 `KIS_APP_KEY`/`KIS_APP_SECRET`), account k>0 = 접미 `(k+1)` = "사람이 세는 번호"(사장님 브리프의 `KIS_APP_KEY_2`=2번째 키). 즉 `_account_env(1)=("KIS_APP_KEY_2","KIS_APP_SECRET_2")`. 위 `_account_env`가 **스펙 단일 정의**(코드 주석에 박는다).

### account_id별 getter
- `ensure_kis_token_provider(account_id, data_dir)` / `ensure_kis_client(account_id, data_dir)` — dict 캐시.
- `_resolve_env_creds(account_id)` — 해당 account의 env 쌍 읽기, 없으면 None.
- `configured_account_ids(data_dir) -> list[int]` — env에 키 있는 account만(0부터 연속). N_ACCOUNTS = len(이것). **1계좌만이면 [0] → 현행 13종목·1스트림 폴백.**
- **backcompat**: `ensure_kis_client_from_env(data_dir)` = `ensure_kis_client(0, data_dir)` 별칭 유지 → 휴장/스크리너/quotes 호출부 **무변경**. account 0 토큰 경로도 `kis-token.json` 그대로.

### account 1의 역할 한정
account 1 KisClient는 **WS approval_key 발급 전용**(`get_approval_key`만 호출). REST 15/s 버킷·bearer 토큰 미사용. → account 1은 **토큰 쿨다운·15/s 경합과 무관**(위험 #3 소멸). REST poller·quotes·EOD는 **계속 account 0 단독**.

---

## 5. 부품2 — 이중 WS 오케스트레이션 (`lifecycle.py`)

> **연결 모델 = dynamic-N (사장님 결정 2026-06-09, plan-eng-review 검증).** 계좌 N개 = 연결 *상한*. 실제 연결은 **코드가 있는 파티션만** 생성(빈 part = 연결 없음). idle 빈 소켓을 상시 유지하지 않는다 — ① KIS 상대 미검증 베팅 회피(스모크는 양쪽 *구독 있는* 상태만 확인), ② watchdog가 0종목 연결을 끝없이 재시작하는 churn 회피. create/teardown은 watchdog 복구와 **같은 프리미티브**를 쓴다(§5.2, DRY).

### 5.1 `_State` 분해
```python
@dataclass
class _StreamConn:
    account_id: int
    stream_obj: object            # LiveStream (자체 writer 소유, code-disjoint)
    ws_task: asyncio.Task
    flush_task: asyncio.Task
    codes: tuple[str, ...]        # 이 연결의 파티션(dynamic-N: 항상 비어있지 않음)

@dataclass
class _State:
    started_at_ms: int | None = None
    n_configured: int = 0                    # start에 1회 산출·캐시(Q5)
    watchlist_codes: tuple[str, ...] = ()    # 전체 assigned — get_active_codes/Today Promoter가 읽음
    streams: dict[int, _StreamConn] = field(default_factory=dict)   # account_id 키(list 아님)
    live_set: tuple[str, ...] = ()           # = 살아있는 conn 코드 합집합 = 배지/배타 권위(§6 기본)
    rest_poller: LiveRestPoller | None = None
```
- streams를 **account_id 키 dict**로(list 아님) — dynamic-N에서 conn 부재가 자연스럽고 watchdog가 `streams[k]` 한 연결만 교체하기 쉬움.
- 각 `_StreamConn`은 **자체 `LiveStream`+`LiveWriter`**. 파티션 code-disjoint(account0=[0:13], account1=[13:26])라 writer per-code Lock이 인스턴스 간이 아니어도 **(date,code) 충돌 불가** → writer/buffer 무변경.
- **단일 `_buffer` 공유**(code-keyed ring, 다중 producer 안전).

### 5.2 연결 프리미티브 — build / teardown (R1·R2; refresh·watchdog 공유)
```python
def _build_conn(account_id, codes, data_dir) -> _StreamConn:
    # ensure_kis_client(account_id) → LiveStream(+writer) → KisWsClient(approval=client.get_approval_key)
    # → set_active_codes(codes) → ws_task=run(codes), flush_task=run_flush_loop()
async def _teardown_conn(conn) -> None:
    # conn.ws_task/flush_task만 cancel+await. ★ account의 KisClient 싱글톤은 닫지 않음.
```
- **R1 (★) — teardown는 KisClient를 닫지 않는다.** 기존 불변식 "stop ≠ close client"(`aclose_kis_client`는 PROCESS shutdown 전용, `kis_runtime.py:146-149`; `_stop_live_stream_locked`도 task만 cancel, `lifecycle.py:454-474`)를 per-account로 승계. KisClient는 `kis_runtime` dict에 남아 다음 build가 재사용 → boundary 넘나들 때 client 재생성·approval 폭발 방지.
- **R2 — 즉시·멱등 teardown(디바운스 없음).** 디바운스는 "짧게라도 빈 소켓 유지"라 dynamic-N 근거와 모순 → **폐기**(루프 자기수정). boundary 토글 churn은 사람 드래그 속도(드묾)·approval 발급 ~50ms(스모크 측정)라 수용. done task에 cancel은 no-op이라 멱등. `_lifecycle_lock`이 refresh·watchdog과 직렬화.
- 이 두 프리미티브가 **refresh-create / refresh-teardown / watchdog-restart 셋을 공유**(essential 복잡도 1벌, DRY).

### 5.3 파티션 (Q4 — 연속 슬라이스)
```python
def partition_live_set(codes: list[str], n: int) -> list[list[str]]:
    """display-order 연속 배정: account k = codes[k*13:(k+1)*13].
    해시 배정 대신 연속(Q4): boring·CONTEXT.md 'top-13=경계' 모델 일치·explicit>clever.
    13-경계 안 넘는 코드는 계좌 고정 → 재정렬 churn 최소(위험 #4)."""
```
- `_compute_live_set`: `[:13]` → `[:13*n_configured]` 절단. 그 뒤 `partition_live_set(codes, n_configured)`.
- `LIVE_SET_MAX_CODES` 모듈 상수 → **동적**(`13 * n_configured`). `KIS_WS_MAX_REGISTRATIONS=41`/`TRS_PER_CODE=3`/`_PER_ACCOUNT_MAX=13` 상수 유지.
- **Q5 — n_configured 변경 = 서버 재시작.** env는 boot-load. 계좌2 켜기는 `.env`에 키 넣고 재시작. n_configured는 start에 1회 산출·캐시 → refresh는 N변화 분기 없음(불변 가정).

### 5.4 start (`_start_live_stream_locked` 재작성)
1. account 0 creds 없으면 False(완전 오프라인).
2. **rest_poller 보장**(없으면 생성 account0 client+`_buffer`, 있으면 재사용 — `_subscribed` 보존, §3).
3. n_configured 산출·캐시. `codes = _compute_live_set`(=`[:13*n_configured]`).
4. **codes 비어도 False 아님(C4)**: streams={} + poller만, started_at_ms 세팅 후 True.
5. codes 있으면 `parts = partition_live_set(codes, n_configured)`; **비어있지 않은 part만** `_build_conn(k, parts[k])` → `streams[k]=conn` (dynamic-N).
6. `live_set = union(살아있는 conn codes)` → `rest_poller.set_excluded_codes(set(live_set))`.

### 5.5 refresh (`refresh_live_stream`) — dynamic-N create/teardown
- **streams=={} 폴백**: 비어있으면(부팅·C4) `_start_live_stream_locked` 재호출이 기동.
- streams 있으면: `parts = partition_live_set(_compute_live_set(), n_configured)`. account k마다:
  - part 있고 conn 있음 → `ws.update_codes(parts[k])`(diff) + `set_active_codes`.
  - part 있고 conn 없음 → **`_build_conn(k, parts[k])`** (13→14 경계: conn-1 신규 — advisor 갭의 정답).
  - part 없고 conn 있음 → **`_teardown_conn` + `streams.pop(k)`** (14→13: conn-1 해체, 빈 소켓 안 남김).
- **exclude-then-subscribe 순서(advisor, ADR-0067 §5 clean handoff)**: 새로 build되는 코드는 WS 구독 *전에* `set_excluded_codes`에 들어가야 보던 코드의 WS↔REST 순간 이중생산이 없다. → exclusion 재동기화를 build보다 먼저(또는 build 직전 그 코드만 우선 배제). 표시 전용이라 치명적 아니나 의도된 순서.
- `_buffer.drop_codes_except(set(codes))` 유지. live_set/exclusion = union(살아있는 conn) 재동기화.
- cross-boundary 이동: 양쪽 conn에 diff(remove+add) — `update_codes`가 처리. 연속 배정이라 경계 안 넘는 코드 무변동.

### 5.6 watchdog — 연결별 격리 복구 (결정 C, Q6)
- `_ws_watchdog_check`가 `streams` 순회: 각 conn에 dead(ws_task/flush_task done) OR stale(`_capture_health`=="stale") 판정.
- 죽은 conn만 **`_restart_conn(k)` = `_lifecycle_lock` 안에서 재검증 → `_teardown_conn(old)` + `_build_conn(k, 현재 parts[k])` → `streams[k]` 교체**(Q6). 멀쩡한 conn·poller·다른 account 토큰/KisClient 불변(R1).
- `sub_failed`(appkey 거부)·`reconnecting`(영구 고장, Q3): **재시작 안 함**, WARNING + 가시화. 복구는 운영자(키 수정 또는 제거→N=1 폴백).
- **dict 원자 순회 불변식(advisor)**: watchdog의 `streams` 순회 중 `await`을 넣지 말 것 — 단일 이벤트루프(ADR-0038)라 await-free 순회만 원자적이다. dead 감지(동기 순회)로 대상 모은 뒤, 변이는 `_restart_conn`(lock 안 재검증)에서. 순회 중 await→refresh가 pop/build하면 "dict changed size during iteration" 크래시.
- live_set/exclusion은 §6 기본(assigned)에선 watchdog 불개입(refresh만). 게이트(`ws_capture_window`)/`to_thread`/세션 grace 현행 재사용.

### 5.7 get_status — 집계 (Q10·Q11)
- `running` = (어느 conn task alive) OR (poller alive). (C4 poller-only도 서비스 중.)
- `ws_connected` = **살아있는 conn 전부** connected(AND); conn 0(C4)이면 False.
- `live_set` = union(살아있는 conn codes) (§6 기본).
- `capture_healthy` = **존재하는 conn 전부** healthy(AND) — Q11: 빈 part는 conn 없음 ≠ 불건강, **존재 conn만 집계**. conn 0이면 True + `capture_reason="idle"`.
- `capture_reason` = worst conn의 reason **(값 불변)**. degraded면 worst conn의 reason 문자열 그대로(`reconnecting`/`stale`/`sub_failed`).
- **`degraded_accounts: list[int]` 신규 additive 필드(Q10, advisor 수정)** — 저하 conn의 account_id 목록. ★ `capture_reason` *값*은 재포맷 안 함(기존 프론트 소비 필드; `LiveStatus`의 "unknown keys safely ignored"는 unknown *필드* 보장이지 unknown *값* 아님 — line 127). 새 필드라 **프론트 0줄 증명 가능**(C3 소비 전까지 무시). 운영자는 지금 로그(watchdog WARNING이 account 명시)로, UI 표기는 C3로.
- `last_tick_ms` = conn 중 max. `watchlist_count` = len(watchlist_codes).

---

## 6. D 결정 — 한 연결 다운 시 정직성 (★ 사장님 검토 핵심)

**문제**: account 1 소켓이 죽고 watchdog 복구 전, 그 코드들을 어떻게 보여줄까. 출시1 배지(realtime=∈live_set)를 그대로 두면 동결된 코드가 "실시간" 거짓말.

**시간 경계 주의**: 어느 안이든 "즉시 정직"이 아니라 **watchdog 복구 지연 내 정직**이다 — dead task ~30s, half-open 소켓은 120s stale grace 경과 후 감지. 이는 현재 단일 연결 `capture_healthy`와 동일한 경계다.

### 기본 (★ 채택, 사장님 승인 2026-06-09) — 배너 레벨 정직, per-code는 C3로
- `live_set` = **assigned 파티션 유지**(의미·exclusivity 권위 불변, ADR-0067 §5 그대로).
- `capture_healthy` = 존재하는 conn AND(§5.7, Q11) → **기존 단일 "실시간 일부 저하" 배너가 정직**(전역 레벨). 어느 계좌인지는 `degraded_accounts` 신규 필드(Q10, 프론트 0줄).
- per-code 정밀도(어느 코드가 동결인지)는 **C3(`collectionStatusBadge.ts`)로 이월** — 사장님이 이미 deferred로 구분한 영역. 출시2는 백엔드 N-스트림만, **프론트 0줄**.
- 비용: degraded 구간(짧음, watchdog 복구) 동안 per-code 배지는 여전히 "실시간"(전역 배너로는 저하 고지).

### 대안 (기각) — per-code까지 정직 (프론트 0줄이지만 invariant에 동적성 추가)
- `live_set` 의미를 **assigned→"healthy 연결 코드"로 재정의** + **exclusion도 healthy를 따름** + watchdog가 헬스 변화에 재동기화.
- 이득: 죽은 연결 코드가 live_set에서 빠져 배지가 per-code로 정직(`deriveCollectionStatus` *코드* 무변경) + 보는종목이면 REST graceful fallback.
- 비용(정직히): **`live_set`은 단순 배지 입력이 아니라 producer-exclusivity의 권위**(`set_excluded_codes`). healthy로 재정의하면 **exclusivity 경계가 파티션 멤버십이 아니라 연결 헬스에 따라 출렁인다**. REST 무디스크라 데이터 안전성은 유지되지만(혼합 JSONL 불생성), 안전-임계 invariant에 동적성을 더해 *bounded-window 배지 이득*을 사는 것. 또 `deriveCollectionStatus`의 코드는 두되 **입력 의미를 바꾸는** 것이라, 사장님이 settled로 둔 영역에 대한 뒷문 행동 변경.
- (참고) 영향 검증: `get_active_codes()`(Today Promoter)는 `watchlist_codes`(=assigned) 사용 → disk promotion 무영향. churn 가드: dead/stale 임계(grace) 도달 시만 live_set에서 제외(짧은 재연결 플리커 억제).

**결정(2026-06-09)**: **기본 채택.** degraded 구간은 watchdog(C, 연결별)가 빠르게 메우고 배너가 정직하며, per-code 정밀 배지는 별도 deepening C3의 자리. 안전-임계 invariant(exclusivity)를 연결 헬스에 묶지 않는다. 영구 고장(Q3)도 `degraded_accounts`+로그로 고지 후 운영자 폴백(키 제거→N=1)으로 graceful.

---

## 7. 위험 + 대응 (ADR-0067 §7 갱신)

| # | 위험 | 상태 | 대응 |
|---|---|---|---|
| 1 | 동일 IP 2소켓 동시 유지 | **해소(GO)** | §0 스모크 통과. `scripts/smoke_2account_ws.py` 회귀. |
| 2 | WS·REST 동일종목 → 혼합 JSONL | 해결 유지 | exclusion(live_set) 단일 권위 + REST 무디스크 — 기본/대안 공통(§6). |
| 3 | 2계좌 토큰 경합(1/분) | **소멸** | account 1은 bearer 토큰 미사용(approval key만, 쿨다운 무관). account 0만 토큰 — 현행과 동일. |
| 4 | 파티션 churn(재정렬·경계토글마다 재구독/재연결) | MEDIUM | 연속 배정(Q4) + 연결별 diff(전환만) + dynamic-N 즉시 teardown은 사람 드래그 속도라 churn 사람-페이스(Q9, approval ~50ms). |
| 5 | poller 3콜/주기 vs 백필 15/s 경합 | MEDIUM(불변) | account 0 단독·2초 주기·보는종목 소수(출시1과 동일). |
| 6 | env 표기 불일치 | LOW | `KIS_APP_KEY_2`(account_id=1) 단일 규약, §4에 박음. |
| 7(신규) | 한 연결 die→복구 사이 배지 거짓 | MEDIUM | 기본(채택): `capture_healthy`=존재 conn AND → 전역 배너 정직 + `degraded_accounts` 신규 필드(Q10, 프론트 0줄) + 연결별 watchdog 빠른 복구(C). per-code 정밀은 C3. |
| 8(신규) | C4 poller-only ↔ stream 전이 경합 | MEDIUM | poller를 stream에서 분리(§3) → 전이가 streams dict 크기 변화일 뿐, poller·`_subscribed` 불변. |
| 9(신규) | watchdog _restart_conn이 KisClient 닫으면 boundary마다 client 재생성 | MEDIUM | R1: teardown는 task만 cancel, KisClient는 `kis_runtime` dict에 보존(§5.2). |

---

## 8. 테스트 전략 (TDD)

대부분 **2번째 실계좌 없이 mock으로** 검증 가능(스모크만 실계좌·수동).

- **부품1**: `configured_account_ids` — 1계좌만이면 [0]; 2계좌면 [0,1]. account 1 부재 시 None. account 0 토큰 경로 backcompat(`kis-token.json`). account 1 경로 `kis-token-1.json`. `_account_env` 규약(0↔접미없음, 1↔`_2`).
- **파티션(Q4)**: `partition_live_set(26,2)`→13/13; `partition_live_set(13,2)`→[13,[]](빈 part); `partition_live_set(13,1)`→[13]. 연속·안정성(경계 안 넘는 코드 계좌 불변).
- **dynamic-N start**: n=1 → conn 1개(현행 바이트 동일). n=2·26종목 → conn 2개(13/13), 각 자체 writer·공유 buffer. **n=2·13종목 → conn 1개(account0)만, account1 conn 없음**(빈 소켓 아님). account 1 creds 없으면 n_configured=1 폴백.
- **연결 프리미티브(R1·R2)**: `_teardown_conn`이 task만 cancel하고 **KisClient는 안 닫음**(account 1 client가 kis_runtime dict에 잔존 assert). teardown 멱등(done task 재teardown 무해).
- **C4**: 빈 watchlist start → streams=={} + rest_poller alive + started_at_ms 세팅 + True. on_view_subscribe → poller 폴링(빈 화면 아님).
- **rest_poller 분리**: stream/conn 재시작 후 `_subscribed` 보존(잠복 버그 회귀).
- **refresh dynamic-N**: n=2·13종목(conn-1 없음)에서 **14번째 추가 → `_build_conn(1)` 신규 생성**(advisor 갭의 정답). 13으로 축소 → **`_teardown_conn(1)`+pop**(빈 소켓 안 남김). cross-boundary 이동 → 양쪽 diff. 빈 watchlist → streams=={} 폴백.
- **watchdog `_restart_conn`(Q6)**: conn[1]만 dead → `_restart_conn(1)`만(teardown+build), conn[0]·poller·account0 토큰 불변(account1 approval 재발급 1회·account0 0회 assert). `reconnecting`/`sub_failed`(Q3) → 재시작 안 함·WARNING.
- **D 기본**: 1 conn degraded → capture_healthy=False, `capture_reason="reconnecting"`(값 불변), `degraded_accounts==[1]`(Q10 신규 필드), **live_set은 assigned 불변**(대안 미구현 — healthy-shrink 테스트 없음).
- **get_status 집계(Q11)**: conn 2개 중 1개 degraded → healthy=False, worst reason(값 불변), `degraded_accounts==[1]`. **빈 part로 conn 없는 account는 불건강 집계 제외**. 연결 0(C4) → healthy=True/"idle", running=poller alive.
- **스모크(수동, 실계좌)**: §0 — `scripts/smoke_2account_ws.py`로 2소켓 공존 재확인(장중엔 ticks>0도).

---

## 9. 마이그레이션 / 롤백

- **1계좌 폴백 = 현행 무변경**: `KIS_APP_KEY_2` 미설정이면 N=1 → 13종목·1스트림·바이트 동일 동작. 출시2 코드가 1계좌 환경을 회귀시키지 않음이 핵심 안전망.
- **enable**: `.env`에 `KIS_APP_KEY_2`/`KIS_APP_SECRET_2` 등재 시 자동 N=2(26종목). 이미 §0에서 `.env`에 등재 완료(gitignore).
- **롤백**: `KIS_APP_KEY_2` 제거(또는 코드 revert) → 즉시 1계좌. 토큰 캐시 `kis-token-1.json`은 잔존해도 무해(account 1 미구성 시 미사용).
- **토큰 경로 backcompat**: account 0이 `kis-token.json` 유지하므로 기존 배포 토큰 재발급(1/분 쿨다운) 강제 없음.

## 10. 구현 순서 (writing-plans로 상세화)

1. **부품1**(kis_runtime account_id dict + `_account_env`/`_token_cache_path` + `configured_account_ids` + backcompat 별칭) — 독립, mock.
2. **rest_poller 분리 seam**(§3) — 부품2 전제, 잠복 버그 회귀 테스트 동반.
3. **연결 프리미티브**(`_build_conn`/`_teardown_conn` + `partition_live_set`, R1·R2 §5.2/5.3) — TDD, 가장 먼저(refresh·watchdog 공유 기반).
4. **부품2 본체**(_State dict + dynamic-N start/refresh create-teardown §5.4/5.5) — TDD.
5. **watchdog `_restart_conn` + get_status 집계 + D 기본(capture_healthy AND 배너 + `degraded_accounts` 신규 필드)**(§5.6/5.7/6).
6. **C4 검증**(빈 watchlist — 대부분 §3·§5.4에서 이미 떨어짐) + Q3 영구고장 폴백(키 제거→N=1) 수동 확인.
7. **enable + 수동 스모크 재확인**(장중 1회 권장).
