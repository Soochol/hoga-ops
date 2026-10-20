import type { ConditionType } from '../api/screener';


/** 조건 추가 메뉴의 그룹·순서 — **이 목록이 메뉴에 실제로 그려지는 유일한 입력이다.**
 *  새 조건을 CONDITION_CATALOG 에만 더하면 타입 검사는 통과하지만 메뉴에는 영영
 *  나타나지 않는다(#1021 에서 실제로 그렇게 빠뜨렸다). catalog.test 가 이 목록과
 *  카탈로그가 같은 집합인지 단언하므로, 조건을 추가하면 여기도 반드시 채워야 한다. */
export const CONDITION_GROUPS: Array<[string, ConditionType[]]> = [
  ['가격', ['price_range']],
  ['거래대금', ['trade_value', 'trade_value_period']],
  ['신고가/거래량', ['new_high_today', 'new_high', 'new_high_vol_today', 'new_high_vol', 'high_off_peak']],
  ['호가 잔량', ['ask_depth_new_high', 'bid_depth_new_high',
    'ask_depth_new_high_period', 'bid_depth_new_high_period',
    'ask_depth_renewal', 'bid_depth_renewal']],
  ['이동평균', ['ma']],
  ['볼린저밴드', ['bollinger_breakout_today', 'bollinger_breakout']],
  ['등락률', ['change_pct']],
];
