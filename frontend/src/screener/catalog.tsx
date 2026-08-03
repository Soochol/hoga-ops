import { nanoid } from 'nanoid';
import type { ConditionLeaf, ConditionType } from '../api/screener';
import { trade_value } from './conditions/trade_value';
import { trade_value_period } from './conditions/trade_value_period';
import { new_high_today } from './conditions/new_high_today';
import { new_high } from './conditions/new_high';
import { new_high_vol_today } from './conditions/new_high_vol_today';
import { new_high_vol } from './conditions/new_high_vol';
import { high_off_peak } from './conditions/high_off_peak';
import { change_pct } from './conditions/change_pct';
import { price_range } from './conditions/price_range';
import { ma } from './conditions/ma';
import { ask_depth_new_high } from './conditions/ask_depth_new_high';
import { bid_depth_new_high } from './conditions/bid_depth_new_high';
import { ask_depth_renewal } from './conditions/ask_depth_renewal';
import { bid_depth_renewal } from './conditions/bid_depth_renewal';
import type { CatalogEntry } from './conditions/types';

// 조건 추가 메뉴의 순서는 ConditionBuilder 의 CONDITION_GROUPS 가 소유한다. 여기에
// 평평한 순서 배열(구 CONDITION_ORDER)을 함께 두었더니, 그쪽만 채우고 그룹 목록을
// 빠뜨려도 테스트가 통과해 조건이 메뉴에서 사라지는 일이 있었다(#1021). 렌더에 쓰이지
// 않는 두 번째 순서 목록은 두지 않는다.
export const CONDITION_CATALOG: Record<ConditionType, CatalogEntry> = {
  trade_value, trade_value_period, new_high_today, new_high,
  new_high_vol_today, new_high_vol, high_off_peak, ask_depth_new_high, bid_depth_new_high,
  ask_depth_renewal, bid_depth_renewal, change_pct, price_range, ma,
};

export function makeLeaf(type: ConditionType): ConditionLeaf {
  return { id: nanoid(8), type, params: structuredClone(CONDITION_CATALOG[type].defaultParams) } as ConditionLeaf;
}
