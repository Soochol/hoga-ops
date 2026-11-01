import type { CalculationPolicy, ConditionLeaf, VolumeBasis } from '../api/screener';
import { SettingsGroup } from '../live/settings/SettingsGroup';
import { catalogEntry } from './catalog';
import { ConditionSettingsContext } from './ConditionFormLayout';
import { isRankCondition } from './rankConditions';
import { Select } from './Select';
import { VOLUME_TYPES } from './volumeLabels';

export function ConditionParameters({ leaf, calculationPolicy, onChange, settings = false }: {
  leaf: ConditionLeaf; calculationPolicy?: CalculationPolicy; onChange: (leaf: ConditionLeaf) => void; settings?: boolean;
}) {
  const ParamForm = catalogEntry(leaf.type).ParamForm;
  const form = <ParamForm params={leaf.params} onChange={(params: ConditionLeaf['params']) => {
    if (calculationPolicy === 'separate_bases_v2' && VOLUME_TYPES.has(leaf.type)) {
      const minute = 'timeframe' in params && params.timeframe?.endsWith('m');
      const basis = minute ? 'raw' : ('volume_basis' in params ? params.volume_basis : null)
        ?? ('volume_basis' in leaf.params ? leaf.params.volume_basis : null) ?? 'share_adjusted';
      onChange({ ...leaf, params: { ...params, volume_basis: basis } } as ConditionLeaf);
    } else onChange({ ...leaf, params } as ConditionLeaf);
  }} />;
  const volume = calculationPolicy === 'separate_bases_v2' && VOLUME_TYPES.has(leaf.type)
    && !('timeframe' in leaf.params && leaf.params.timeframe?.endsWith('m')) ?
    <Select<VolumeBasis> label="거래량 기준" value={('volume_basis' in leaf.params ? leaf.params.volume_basis : null) ?? 'share_adjusted'}
      options={[[ 'share_adjusted', '주식 수 단위 보정' ], ['raw', '실제 거래량']]}
      onChange={basis => onChange({ ...leaf, params: { ...leaf.params, volume_basis: basis } } as ConditionLeaf)} /> : null;
  const plain = leaf.type === 'price_range' || isRankCondition(leaf) || leaf.type.includes('depth');
  return <ConditionSettingsContext.Provider value={settings}>
    {settings && plain ? <SettingsGroup label="조건">{form}</SettingsGroup> : form}
    {volume && (settings ? <SettingsGroup label="수량">{volume}</SettingsGroup> : volume)}
  </ConditionSettingsContext.Provider>;
}
