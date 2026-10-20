import type { ComponentType } from 'react';
import type { ConditionLeaf, ConditionType } from '../../api/screener';

export type ConditionParams<T extends ConditionType> = Extract<ConditionLeaf, { type: T }>['params'];
export interface CatalogEntry<T extends ConditionType = ConditionType> {
  label: string;
  help?: string;
  defaultParams: ConditionParams<T>;
  ParamForm: ComponentType<{ params: ConditionParams<T>; onChange: (params: ConditionParams<T>) => void }>;
  summarize: (params: ConditionParams<T>) => string;
}
