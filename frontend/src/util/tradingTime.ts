/** 장중 시각(HHMM 정수)과 사람이 읽는 HH:MM 문자열 사이의 공용 변환.
 *
 * 저장 단위는 그대로 HHMM 정수(예: 900 = 09:00)로 두고, 표시/입력만 HH:MM으로
 * 통일한다. 총잔량 급증 마커·신규 거래원 등장·시그널 알림 세 곳이 각자 다른
 * 포맷(900 / 0930 / 11:30)을 쓰던 것을 하나의 소스로 모은다(P1-9).
 *
 * 입력은 관대하게: "0930"(4자리 HHMM)도, "9:30"·"09:30"(콜론)도 모두 받는다.
 * 검증 창은 정규장 09:00–15:20(마감 동시호가 시작). 범위 밖이면 null. */

export const TRADING_TIME_MIN_HHMM = 900;
export const TRADING_TIME_MAX_HHMM = 1520;

export function formatHhmm(hhmm: number): string {
  const hours = String(Math.floor(hhmm / 100)).padStart(2, '0');
  const minutes = String(hhmm % 100).padStart(2, '0');
  return `${hours}:${minutes}`;
}

function validateHhmm(hours: number, minutes: number): number | null {
  if (
    !Number.isInteger(hours) ||
    !Number.isInteger(minutes) ||
    hours < 0 ||
    hours > 23 ||
    minutes < 0 ||
    minutes > 59
  ) {
    return null;
  }
  if (hours < 9 || hours > 15 || (hours === 15 && minutes > 20)) {
    return null;
  }
  return hours * 100 + minutes;
}

/** "0930" 또는 "9:30" 형태를 검증된 HHMM 정수로. 실패 시 null. */
export function parseTradingTimeInput(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (/^\d{3,4}$/.test(trimmed)) {
    const hhmm = Number(trimmed);
    return validateHhmm(Math.floor(hhmm / 100), hhmm % 100);
  }
  const [hoursRaw, minutesRaw] = trimmed.split(':');
  return validateHhmm(Number(hoursRaw), Number(minutesRaw));
}
