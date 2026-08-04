"""Single source of truth for backend-emitted error code strings.

Every `code` field that crosses the API surface — both REST responses
(``HTTPException(detail={"code": ..., "message": ...})``) and the per-item
``CaptureError.code`` field carried on SSE ``capture_finished`` events —
draws from one of these enums.

There are three enums, split by category (see ADR-0009):

* :class:`CaptureErrorCode` — captures-domain non-upstream codes
  (request gating, lifecycle states, internal-error fallback).

* :class:`UpstreamCode` — upstream-dependency availability codes
  (KRX login state, hogaplay cookie state, hogaplay HTTP errors).
  Used as ``reason: UpstreamCode | None`` on cache envelopes
  (``SymbolsAllResponse``, ``CalendarResponse``), as
  ``detail.code: UpstreamCode`` on HTTP 5xx error responses, and as
  ``CaptureError.code`` on per-item SSE failures.

* :class:`LiveErrorCode` — ``/api/live`` request-validation and wiring codes.
  Added 2026-07-30: the ``/api/live`` router had been emitting raw code strings
  (and 28 **plain-string** ``detail`` s) entirely outside this SSOT, so the same
  API surface carried three different error shapes. See the class docstring.

**Response key is ``message``, never ``msg``.** ``frontend/src/api/client.ts``
reads ``detail.message`` only, so a ``detail.msg`` payload silently loses its
human-readable text and the UI falls back to ``"<status> <path>"``. (``msg`` IS
correct inside HTTP-200 ``data_warnings[]`` entries — a different contract with
its own frontend consumers. Don't unify those.)

The frontend mirrors all three enums verbatim as literal unions in
``frontend/src/api/types.ts`` (ADR-0004 mirror discipline: codes are
part of the wire contract, not an internal implementation detail).
Adding a new value here means adding the same string to the
corresponding frontend union in the same commit.
"""
from __future__ import annotations

from enum import StrEnum


class CaptureErrorCode(StrEnum):
    """Captures-domain non-upstream codes (ADR-0009).

    Migrated 2026-05-22: cookie/hogaplay codes moved to UpstreamCode.
    """

    TODAY_TOO_EARLY = "today_too_early"
    MISSING_RANGE = "missing_range"
    TERMINAL = "terminal"
    NOT_FOUND = "not_found"
    INTERNAL_ERROR = "internal_error"
    # Queue mutation attempted on a server that does not own the capture queue
    # for this data dir (another instance holds the flock — ADR-0094). HTTP 503.
    QUEUE_NOT_OWNED = "queue_not_owned"
    # 로컬 디스크에 쓸 수 없다(ENOSPC/EDQUOT/EROFS). INTERNAL_ERROR 에서 갈라낸
    # 이유는 ADR-0042 cap 회계가 다르기 때문이다 — 이건 (Code, Stock-Date) 의
    # 속성이 아니라 **머신의 일시 상태**라, 재시도 한도를 태워서는 안 된다.
    DISK_FULL = "disk_full"


class UpstreamCode(StrEnum):
    """Upstream-dependency availability codes (ADR-0009).

    Used for:
      * cache-style envelopes (HTTP 200) as ``reason: UpstreamCode | None``
      * HTTP error responses (5xx) as ``detail.code: UpstreamCode``
      * SSE per-item failure ``CaptureError.code`` (alongside CaptureErrorCode)

    String values are stable across surfaces; the field name (``reason``
    vs ``code``) signals the response shape.
    """

    # 거래일 달력 **소스를 읽지 못했다**. PR-H(#1044) 이후 소스는 커밋된 정적 시드
    # 라 이건 배포 사고이지 일시 장애가 아니다 — 재시도가 조치가 아니다.
    #
    # 원래는 KIS `chk-holiday` 의 HTTP/rt_cd 실패("잠시 후 재시도")를 뜻했고,
    # #1046 ② 가 `kis_holiday_fetch_failed` 에서 값만 개명했다. **그때 의미가 같이
    # 옮겨오지 않아** 조회 경로에 벤더가 사라진 뒤에도 소비자 카피가 "KIS 일시
    # 오류 — 잠시 후 새로고침" 을 말했다. 아래 STALE 과 갈라 그것을 닫는다.
    TRADING_DAYS_UNAVAILABLE = "trading_days_unavailable"
    # 달력 **커버리지가 요청 날짜에 못 미쳐 평일로 근사**했다. 소스는 멀쩡하다.
    #
    # 정적 시드 + 오버레이는 `ka20006`(지수 일봉) 역산이라 **원리적으로 오늘까지만**
    # 안다 — 지수는 장이 열려야 산출되므로 미래 행이 없다(연구 2026-08-03). 그래서
    # 커버리지 뒤가 비는 것은 장애가 아니라 소스의 성질이고, UNAVAILABLE 과 조치가
    # 다르다: 재시도가 아니라 **오버레이 갱신**(키움 자격증명 · 스케줄러)이다.
    TRADING_DAYS_STALE = "trading_days_stale"
    # KIS credentials absent (KIS_APP_KEY/KIS_APP_SECRET unset) — distinct from
    # FETCH_FAILED so UIs give the right remediation ("set keys" vs "retry
    # later"); same principle as DISK_WRITE_FAILED vs MASTER_FETCH_FAILED.
    CREDENTIALS_MISSING = "credentials_missing"
    COOKIE_EXPIRED = "cookie_expired"
    COOKIE_MISSING = "cookie_missing"
    HOGAPLAY_HTTP_ERROR = "hogaplay_http_error"
    SYMBOL_MASTER_NOT_INITIALIZED = "symbol_master_not_initialized"
    # Disk-write failure during a cache flush — distinguishes "the upstream
    # source is down" (MASTER_FETCH_FAILED) from "the upstream returned data
    # but we couldn't persist it" (full volume, EACCES, detached volume).
    # Operators see distinct reasons; UIs can surface a different remediation
    # ("free disk space" vs "check KIS credentials").
    DISK_WRITE_FAILED = "disk_write_failed"
    # KIS .mst symbol-master download/unzip/parse failure (Phase 2). The .mst is
    # a static no-auth file, so there is no credentials failure mode here.
    MASTER_FETCH_FAILED = "master_fetch_failed"


class LiveErrorCode(StrEnum):
    """``/api/live`` request-validation + wiring codes (ADR-0009 3번째 카테고리).

    왜 별도 enum 인가: ``CaptureErrorCode`` 는 captures 도메인, ``UpstreamCode`` 는
    업스트림 가용성이다. 요청 문법 위반(``invalid_code``)과 의존성 미배선
    (``not_wired``)은 둘 중 어디에도 속하지 않는다 — ADR-0009 가 카테고리로 나눈
    원칙을 따라 세 번째 enum 을 둔다(둘 중 하나에 밀어넣으면 카테고리 경계가 무의미해진다).

    문자열 값은 2026-07-30 이전 raw 문자열과 **동일**하다 — 이 변경은 값이 아니라
    타입·형태(``msg`` → ``message``)를 정돈한 것이므로 프론트 소비자와 기존 테스트가
    그대로 통과한다.
    """

    # ── 요청 문법 (HTTP 422) ────────────────────────────────────────────────
    # code 는 6자리 숫자가 아니다 — params.CODE_PATTERN 은 [0-9A-Z]{6} 또는 Q+6자리
    # (ETN)도 허용하므로 메시지는 "6 digits" 라고 단정하지 않는다.
    INVALID_CODE = "invalid_code"
    INVALID_DATE = "invalid_date"
    FROM_AFTER_TO = "from_after_to"
    DATE_IN_FUTURE = "date_in_future"
    DATE_RANGE_TOO_LARGE = "date_range_too_large"
    INVALID_VENUE = "invalid_venue"
    INVALID_INDEX_ID = "invalid_index_id"
    UNSUPPORTED_INDEX = "unsupported_index"
    UNSUPPORTED_INDEX_INVESTOR_NET = "unsupported_index_investor_net"
    # /past-candles 의 bucket_ms 가 벤더 분봉 주기로 매핑되지 않는다
    # (kiwoom_minute_candles.BUCKET_MS_TO_TIC_SCOPE). 조용히 1분으로 폴백하지 않는
    # 이유는 그 함수의 docstring 참고 — 증상 없이 콜 수만 배로 늘기 때문이다.
    UNSUPPORTED_BUCKET_MS = "unsupported_bucket_ms"

    # ── 조회 대상 없음 (HTTP 404) ────────────────────────────────────────────
    # 라이브 버퍼에 그 종목 데이터가 아직 없다. CaptureErrorCode.NOT_FOUND 를 재사용하지
    # 않는 이유: 값이 겹치면 소비자가 어느 카테고리인지 판단할 수 없고(카테고리 분리가
    # 무의미해진다), "일반적 not_found" 보다 "라이브 데이터 없음" 이 조치를 더 잘 지시한다.
    NO_LIVE_DATA = "no_live_data"

    # ── 의존성 미배선 (HTTP 503) ─────────────────────────────────────────────
    # 28곳의 평문 detail("KIS scheduler not wired" 등)을 하나로 접었다. 코드를 쪼개지
    # 않는 근거는 error_codes 의 판정 기준 그대로다: **remediation 이 같다**(설정하거나
    # 재시작). 무엇이 안 배선됐는지는 ``message`` 가 그대로 실어 준다.
    NOT_WIRED = "not_wired"

    # ── 업스트림 (HTTP 502) ──────────────────────────────────────────────────
    # 키움 전용. UpstreamCode 에 넣지 않은 이유는 그 enum 이 hogaplay/KIS 축으로
    # 자라 왔고 값 문자열도 벤더 접두를 이미 갖고 있어서다.
    KIWOOM_API_ERROR = "kiwoom_api_error"
    KIWOOM_HTTP_ERROR = "kiwoom_http_error"
