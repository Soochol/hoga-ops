import { isRankCondition } from './rankConditions';
import type { ConditionLeaf } from '../api/screener';

export function conditionScope(leaf: ConditionLeaf): string {
  if (isRankCondition(leaf)) return '당일 시장 순위';
  if (leaf.type === 'ask_depth_renewal' || leaf.type === 'bid_depth_renewal') return '장중 전용';
  if (leaf.type.includes('_depth_')) return '잔량 데이터';
  return leaf.type === 'price_range' ? '가격 범위' : '봉 기준';
}
