/**
 * 10호가창 세션 모드 정책 — **어느 장의 호가를 보여줄지**의 SSOT.
 *
 * ## 두 갈래다 — 종목의 NXT 상장 여부가 가른다
 *
 *   `nxt_enabled === false`  갈래 A · KRX 전용 → **정규장 ↔ 시간외 클릭 토글**
 *   `nxt_enabled === true`   갈래 B · NXT 상장 → **현재 국면 라벨만**(클릭 없음)
 *   `nxt_enabled == null`    모름 → **아무것도 하지 않는다**
 *
 * 모름을 어느 갈래로도 밀지 않는 이유: 심볼 마스터 도착 전 창과 신규 상장이 여기
 * 걸리는데, 추측하면 둘 다 틀릴 수 있다. `effectiveLiveVenue` 가 모름을 강등하지
 * 않는 것과 같은 규율이다(`liveVenuePolicy` — "모름은 미상장이 아니다").
 *
 * ## 갈래 A 의 기본 위치는 **시계를 따른다**
 *
 * 정적으로 '정규장' 에 고정하면 지금보다 나빠진다 — 현재는 16:00 에 사다리가
 * 클릭 없이 시간외로 갈아치워진다(`DataWindow` 의 `singlePriceSnapshot ?? …`).
 * 그 편의를 유지한 채 되돌릴 수단만 얹는 것이 이 토글의 목적이다.
 *
 * ## ⚠ 수동 오버라이드 해제는 **경계 목록이 아니라 파생**이다
 *
 * `bookSessionEpoch` 는 `(KST 날짜, 기본 모드)` 쌍이다. 기본값이 바뀌는 순간
 * 자동으로 새 epoch 가 되므로 "16:00 과 자정" 이라는 경계를 어디에도 적지 않는다.
 * 시각을 손으로 두 곳에 적으면 갈린다 — `liveVenueSessionWindowLabel` 이 자기
 * docstring 에 그 위험을 적어 둔 것과 같은 형태의 함정이다.
 */
import { unixMsToKSTDate, unixMsToKSTHhmm } from '../util/time';
import type { LiveVenueOption } from '../state/liveVenue';

/** 사다리가 어느 장의 것인가. */
export type BookSessionMode = 'regular' | 'afterHours';

/** 하단 스트립 중앙에 무엇을 그릴지. */
export type BookSessionControl =
  /** 갈래 A — 두 라벨 + 선택된 쪽 밑줄. 밑줄이 곧 "누를 수 있다" 의 신호다. */
  | { kind: 'toggle'; regularLabel: string; afterHoursLabel: string }
  /** 갈래 B — 현재 국면 하나. 클릭 안 되는 두 라벨을 나란히 두면 "왜 안 눌리지" 가 된다. */
  | { kind: 'label'; label: string }
  /** 모름, 또는 이 창에서 세션 표시가 무의미한 상태(스팟 커서). */
  | { kind: 'none' };

/** 시간외 단일가 개시 — 갈래 A 기본값이 뒤집히는 유일한 일중 경계(HHMM). */
const AFTER_HOURS_SINGLE_PRICE_OPEN = 1600;
/** 시간외 단일가 종료. 이 뒤의 사다리는 얼어붙은 값이다(라벨이 그 사실을 말한다). */
const AFTER_HOURS_SINGLE_PRICE_CLOSE = 1800;

/**
 * 이 시각의 갈래 A 기본 모드.
 *
 *   00:00–16:00  정규장
 *   16:00–24:00  시간외
 *
 * 15:40–16:00(시간외 종가매매)을 시간외로 넘기지 **않는다** — 그 구간은 당일 종가
 * 단일 가격이라 호가 사다리라는 개념 자체가 없어서, 기본값으로 삼으면 사다리 없는
 * 화면이 기본이 된다. 그 구간의 시간외 신호는 총잔량(0E)뿐이고 그건 정규장 모드의
 * 하단 스트립이 이미 그린다.
 */
export function defaultBookSessionMode(nowMs: number = Date.now()): BookSessionMode {
  return unixMsToKSTHhmm(nowMs) >= AFTER_HOURS_SINGLE_PRICE_OPEN ? 'afterHours' : 'regular';
}

/**
 * 수동 오버라이드가 유효한 구간의 키 — 값이 바뀌면 오버라이드를 버린다.
 *
 * `(KST 날짜, 기본 모드)` 라서 16:00 과 자정에서 자동으로 넘어간다. 경계를 상수로
 * 열거하지 않는 것이 요점이다(모듈 docstring).
 */
export function bookSessionEpoch(nowMs: number = Date.now()): string {
  return `${unixMsToKSTDate(nowMs)}:${defaultBookSessionMode(nowMs)}`;
}

/**
 * 수동 오버라이드의 저장 형태 — **모드와 그 유효 구간이 한 값이다.**
 *
 * 둘을 떼어 두면 "언제 누른 건지" 를 잃어 만료를 판정할 수 없다. 인라인 리터럴로
 * 두 파일에 손으로 적으면 조용히 갈리므로(`LiveFrameVenue` 가 같은 이유로 명명
 * 타입이 됐다) 여기서 한 번만 정의한다.
 */
export type BookSessionOverride = { mode: BookSessionMode; epoch: string } | null;

/**
 * 오버라이드를 반영한 실효 모드. `override` 가 자기 epoch 를 달고 다니므로 여기서
 * 만료를 판정한다 — 호출부가 타이머로 지울 필요가 없다(탭이 잠들어 있어도 맞는다).
 */
export function resolveBookSessionMode(
  override: BookSessionOverride,
  nowMs: number = Date.now(),
): BookSessionMode {
  if (override !== null && override.epoch === bookSessionEpoch(nowMs)) return override.mode;
  return defaultBookSessionMode(nowMs);
}

/**
 * 갈래 A 의 시간외 라벨 — 16:00–18:00 만 '시간외 단일가'.
 *
 * ⚠ 이 문안은 **하중을 받는다.** 그 구간의 사다리는 벤더 상한이 5차선이라 10단
 * 격자의 바깥 5행이 비는데(`liveAfterHoursBook`), 그 빈 행이 "데이터 결손" 이 아니라
 * "그 시장에 없는 단계" 임을 말하는 장치가 이 라벨뿐이다. 토글이 되어도 그 국면에서는
 * 문안을 유지한다.
 */
export function krxAfterHoursLabel(
  nowMs: number = Date.now(),
  opts: { stored?: boolean } = {},
): string {
  // 저장본은 **더 이상 변하지 않는다** — 그 사실을 말하지 않으면 화면이 멈춘 값을
  // "지금 호가" 처럼 보인다. 얼어붙은 표시에 시각·상태를 붙이는 이 리포의 규율.
  if (opts.stored) return '시간외 · 마지막';
  const hhmm = unixMsToKSTHhmm(nowMs);
  const inSinglePrice =
    hhmm >= AFTER_HOURS_SINGLE_PRICE_OPEN && hhmm < AFTER_HOURS_SINGLE_PRICE_CLOSE;
  return inSinglePrice ? '시간외 단일가' : '시간외';
}

/**
 * 갈래 B 의 현재 국면 라벨 — NXT 세션표(`session_gate` 의 venue 별 단일가 표와 같은
 * 근거: 증권사 안내 4곳 일치, 2026-08-07 확인).
 *
 *   08:00–09:00  프리마켓      (08:50–09:00 은 KRX 시가단일가 중 거래정지 — 잔상 유지)
 *   09:00–15:30  정규장        (15:20–15:30 은 KRX 종가단일가 중 거래정지 — 잔상 유지)
 *   15:30–20:00  애프터마켓    (15:30–15:40 시가단일가 → 15:40 부터 접속매매)
 *   그 밖        애프터마켓 · 마지막
 *
 * 거래정지 10분에 별도 문안을 두지 않는 이유: 그때 화면에 떠 있는 것은 **직전 국면의
 * 마지막 사다리**이고, 라벨은 화면에 있는 것을 설명해야 한다.
 */
export function nxtPhaseLabel(nowMs: number = Date.now()): string {
  const hhmm = unixMsToKSTHhmm(nowMs);
  if (hhmm >= 800 && hhmm < 900) return '프리마켓';
  if (hhmm >= 900 && hhmm < 1530) return '정규장';
  if (hhmm >= 1530 && hhmm < 2000) return '애프터마켓';
  return '애프터마켓 · 마지막';
}

/**
 * 이 종목·이 창에 **세션 토글이 있는가**(= 갈래 A 인가).
 *
 * `bookSessionControl` 에서 떼어낸 이유는 순환 때문이다: 컨트롤은 "지금 그리는 것이
 * 저장본인가" 를 알아야 라벨을 정하는데, 그 답은 조회 결과에서 오고, 조회 여부는
 * 갈래가 정한다. 갈래는 **종목 능력만으로** 정해지고 데이터에 의존하지 않으므로
 * 여기서 먼저 답할 수 있다.
 */
export function hasBookSessionToggle(
  nxtEnabled: boolean | null | undefined,
  isSpot: boolean,
): boolean {
  return !isSpot && nxtEnabled === false;
}

/**
 * 하단 스트립 중앙에 그릴 것을 정한다.
 *
 * ## ⚠ 갈래 B 라벨 조건에 **venue 가 들어간다**
 *
 * "NXT 상장" 과 "지금 NXT 데이터를 보는 중" 은 다르다. venue 선택기에서 KRX 를
 * 고르면 `liveVenueAcceptsFrame` 이 NXT 태그 프레임을 전부 버리므로, 15:30 이후
 * 화면에는 KRX 15:30 정지본이 떠 있다. 거기에 '애프터마켓' 을 붙이면 라벨이
 * 화면과 다른 말을 한다 — 그래서 그 조합은 '정규장 · 마지막' 이다.
 *
 * `venue` 는 **유효 venue**(`useEffectiveVenue`)여야 한다. 선택값을 그대로 넘기면
 * NXT 미상장 종목에 UN 을 고른 경우가 갈래 판정과 어긋난다.
 */
export function bookSessionControl(args: {
  nxtEnabled: boolean | null | undefined;
  venue: LiveVenueOption;
  /** 스팟 커서(과거 시점) 중인가 — 그때는 세션 선택 자체가 무의미하다. */
  isSpot: boolean;
  /** 지금 그릴 시간외 호가가 **저장본**인가(`source === 'stored'`). 라벨이 갈린다. */
  afterHoursIsStored?: boolean;
  nowMs?: number;
}): BookSessionControl {
  const { nxtEnabled, venue, isSpot } = args;
  const nowMs = args.nowMs ?? Date.now();
  // 과거 시점 위에 "지금 어느 장인가" 를 얹지 않는다 — 증감 뱃지·시간외 폴링이
  // 스팟에서 꺼지는 것과 같은 규율(`DataWindow`).
  if (isSpot) return { kind: 'none' };
  if (nxtEnabled === true) {
    // KRX 를 고른 NXT 종목: 애프터마켓 프레임이 걸러지므로 그 라벨을 쓸 수 없다.
    if (venue === 'KRX') {
      return { kind: 'label', label: unixMsToKSTHhmm(nowMs) >= 1530 ? '정규장 · 마지막' : '정규장' };
    }
    return { kind: 'label', label: nxtPhaseLabel(nowMs) };
  }
  if (hasBookSessionToggle(nxtEnabled, isSpot)) {
    return {
      kind: 'toggle',
      regularLabel: '정규장',
      afterHoursLabel: krxAfterHoursLabel(nowMs, { stored: args.afterHoursIsStored }),
    };
  }
  return { kind: 'none' };
}

/** 토글에서 반대편 모드 — 클릭 핸들러가 쓴다. */
export function otherBookSessionMode(mode: BookSessionMode): BookSessionMode {
  return mode === 'regular' ? 'afterHours' : 'regular';
}
