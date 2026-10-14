


/** ko-KR 기본 패턴은 `2026. 08. 21. (금) 14:03:27` 이고 ICU 버전에 따라 구분자가
 *  달라진다. 그래서 **부품으로 받아 직접 조립**한다 — 표시 형식이 런타임 ICU 가 아니라
 *  이 파일에 고정된다.
 *
 *  `hourCycle: 'h23'` 은 자정을 `24:00:05` 로 내는 h24 변종을 배제한다. ⚠ **이 리포의
 *  현재 ICU(node 78 · Chrome) 에서는 `hour12: false` 도 `00` 을 내므로 테스트가 둘을
 *  구별하지 못한다**(실측: 바꿔 끼워도 초록). 즉 증명된 가드가 아니라 로케일·ICU 변종에
 *  대한 무료 보험이다 — 여기 기대어 다른 곳에서 `hour12: false` 를 쓰지 말 것. */
export const KST_PARTS = new Intl.DateTimeFormat('ko-KR', {
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
