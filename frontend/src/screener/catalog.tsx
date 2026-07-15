import { nanoid } from 'nanoid';
import type { ConditionLeaf, ConditionType } from '../api/screener';
import { trade_value } from './conditions/trade_value';
import { trade_value_period } from './conditions/trade_value_period';
import { new_high_today } from './conditions/new_high_today';
import { new_high } from './conditions/new_high';
import { new_high_vol_today } from './conditions/new_high_vol_today';
import { new_high_vol } from './conditions/new_high_vol';
import { change_pct } from './conditions/change_pct';
import { price_range } from './conditions/price_range';
import { ma } from './conditions/ma';
import { ask_depth_new_high } from './conditions/ask_depth_new_high';
import { bid_depth_new_high } from './conditions/bid_depth_new_high';
import type { CatalogEntry } from './conditions/types';

export const CONDITION_ORDER: ConditionType[] =
  ['trade_value', 'trade_value_period', 'new_high_today', 'new_high',
   'new_high_vol_today', 'new_high_vol', 'ask_depth_new_high', 'bid_depth_new_high',
   'change_pct', 'price_range', 'ma'];

export const CONDITION_CATALOG: Record<ConditionType, CatalogEntry> = {
  trade_value, trade_value_period, new_high_today, new_high,
  new_high_vol_today, new_high_vol, ask_depth_new_high, bid_depth_new_high,
  change_pct, price_range, ma,
};

export function makeLeaf(type: ConditionType): ConditionLeaf {
  return { id: nanoid(8), type, params: structuredClone(CONDITION_CATALOG[type].defaultParams) } as ConditionLeaf;
}
