/**
 * 「분봉으로」의 **목적지 판정** — 어느 날로 가는가, 그리고 갈 수 있는가.
 *
 * 소비자가 둘이라 따로 뗀다: 헤더 버튼(호버 미리보기 + 클릭)과 `g` 단축키. 둘이
 * 각자 판정하면 **버튼은 막았는데 단축키는 보내는** 상태가 생기고, 그 어긋남은
 * 화면에 안 보인다(눌러 보기 전엔 모른다).
 *
 * 컴포넌트 파일이 아니라 여기 있는 이유는 react-refresh 규약이다 — 이 리포는 훅·
 * 순수 함수와 컴포넌트를 한 파일에 섞지 않는다(`windowViewContext.ts` 의 그 절).
 */
import { earliestAllowedMinuteDate, realMsToYyyymmdd, todayKstYyyymmdd } from './liveDateTime';

export type JumpDestination = {
  /** 목적지 YYYYMMDD(KST). */
  date: string;
  /**
   * 분봉 보유 한계(키움 실측 13개월) 밖 — 백필해도 빈 응답만 온다.
   *
   * 여기서 막는 것이 **친절이 아니라 정확성**이다: 보내 놓고 소비 창이 빈 차트를
   * 보여주면 사용자는 "고장" 과 "원래 없는 데이터" 를 구별할 수 없다.
   */
  outOfRetention: boolean;
};

/** 실시각 → 목적지 판정. 값이 없거나 유한하지 않으면 null. */
export function jumpDestinationOf(toMs: number | null): JumpDestination | null {
  if (toMs === null || !Number.isFinite(toMs)) return null;
  const date = realMsToYyyymmdd(toMs);
  return { date, outOfRetention: date < earliestAllowedMinuteDate(todayKstYyyymmdd()) };
}
