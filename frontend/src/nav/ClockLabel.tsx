/** 상단 중앙 실시간 시계 — `2026-08-21 (금) 14:03:27` (KST, 초 단위).
 *
 * 시각 소스는 `useWallClockSecond` 이고, 그 훅이 정확도(NTP 상속 · 초 경계 정렬 ·
 * 가시성 복귀 재동기화)를 책임진다. 여기는 **표시 계약만** 맡는다.
 *
 * 표시 계약 세 가지:
 * - **항상 KST.** 브라우저 로컬 tz 를 쓰면 비-KST 워크스테이션에서 차트 x축·체결
 *   시각과 어긋난다(`DataWindow.formatKstClock` 과 같은 근거). KST 는 DST 가 없어
 *   `Asia/Seoul` 이 항상 UTC+9 로 확정이다 — `<time dateTime>` 의 `+09:00` 도 그래서 안전.
 * - **`font-data`.** Pretendard 숫자는 기본 프로포셔널이라(DESIGN.md 실측: 40px 에서
 *   `1` 이 `4` 보다 7px 좁다) tnum 없이는 라벨 폭이 **매초 흔들린다**. tnum 은
 *   `font-data` 유틸리티에 결속돼 있으므로 호출부에서 `tabular-nums` 를 따로 적지 않는다.
 * - **`role="timer"`.** 기본 `aria-live="off"` 인 live region 이라 스크린리더가 초마다
 *   읽어 대지 않는다(`aria-live="polite"` 를 달면 1초 간격 낭독 폭탄이 된다).
 */
import { useWallClockSecond } from '../util/useWallClockSecond';

/** ko-KR 기본 패턴은 `2026. 08. 21. (금) 14:03:27` 이고 ICU 버전에 따라 구분자가
 *  달라진다. 그래서 **부품으로 받아 직접 조립**한다 — 표시 형식이 런타임 ICU 가 아니라
 *  이 파일에 고정된다.
 *
 *  `hourCycle: 'h23'` 은 자정을 `24:00:05` 로 내는 h24 변종을 배제한다. ⚠ **이 리포의
 *  현재 ICU(node 78 · Chrome) 에서는 `hour12: false` 도 `00` 을 내므로 테스트가 둘을
 *  구별하지 못한다**(실측: 바꿔 끼워도 초록). 즉 증명된 가드가 아니라 로케일·ICU 변종에
 *  대한 무료 보험이다 — 여기 기대어 다른 곳에서 `hour12: false` 를 쓰지 말 것. */
const KST_PARTS = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

export interface ClockParts {
  /** `2026-08-21 (금)` */
  date: string;
  /** `14:03:27` */
  time: string;
  /** `<time dateTime>` 용 기계 판독 값 — `2026-08-21T14:03:27+09:00` */
  iso: string;
}

export function kstClockParts(ms: number): ClockParts {
  const parts = KST_PARTS.formatToParts(ms);
  const at = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? '';
  const [y, mo, d] = [at('year'), at('month'), at('day')];
  const [h, mi, s] = [at('hour'), at('minute'), at('second')];
  return {
    date: `${y}-${mo}-${d} (${at('weekday')})`,
    time: `${h}:${mi}:${s}`,
    iso: `${y}-${mo}-${d}T${h}:${mi}:${s}+09:00`,
  };
}

export default function ClockLabel() {
  const { date, time, iso } = kstClockParts(useWallClockSecond());
  return (
    <time
      role="timer"
      dateTime={iso}
      aria-label={`현재 시각 ${date} ${time} KST`}
      className="font-data inline-flex shrink-0 items-baseline gap-1.5 whitespace-nowrap text-xs"
    >
      <span className="text-fg-dim">{date}</span>
      <span className="text-fg">{time}</span>
    </time>
  );
}
