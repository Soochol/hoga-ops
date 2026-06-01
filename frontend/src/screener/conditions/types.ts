import type { ConditionLeaf } from '../../api/screener';

export interface CatalogEntry {
  label: string;
  defaultParams: ConditionLeaf['params'];
  ParamForm: React.FC<{ params: any; onChange: (p: any) => void }>;
  summarize: (p: any) => string;
}
