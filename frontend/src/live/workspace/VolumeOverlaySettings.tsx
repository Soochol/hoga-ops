import { IndicatorRangeRow } from '../indicators/IndicatorSettingsLayout';
import type { VolumeOverlayPrefs } from '../../state/chartDisplayPrefs';
import { SettingsRow } from '../settings/SettingsRow';
import ColorSwatchPicker from '../indicators/ColorSwatchPicker';
import { resolveTokensThemed } from '../../util/tokens';

const TOKEN_SPEC = { up: ['--price-up', '#F04452'], down: ['--price-down', '#3485FA'] } as const;

export function VolumeOverlaySettings({ prefs, onChange, disabled = false }: {
  prefs: VolumeOverlayPrefs; onChange: (patch: Partial<VolumeOverlayPrefs>) => void; disabled?: boolean;
}) {
  const patch = (values: Partial<VolumeOverlayPrefs>) => { if (!disabled) onChange(values); };
  const tokens = resolveTokensThemed(TOKEN_SPEC);
  return <fieldset disabled={disabled} className={`settings-dependent min-w-0 ${disabled ? 'opacity-50' : ''}`} key={String(disabled)}>
    <IndicatorRangeRow label="표시 높이" ariaLabel="거래량 표시 높이" value={prefs.volumeOverlayHeight} min={10} max={40}
      onChange={value => patch({ volumeOverlayHeight: value })} />
    <IndicatorRangeRow label="불투명도" ariaLabel="거래량 불투명도" value={100 - prefs.volumeOverlayTransparency}
      onChange={value => patch({ volumeOverlayTransparency: 100 - value })} />
    {([
      ['volumeOverlayUpColor', '상승봉 거래량 색상', tokens.up],
      ['volumeOverlayDownColor', '하락봉 거래량 색상', tokens.down],
    ] as const).map(([key, label, fallback]) => <SettingsRow key={key} label={label}>
      <div className="flex items-center gap-2">
        <ColorSwatchPicker color={prefs[key] || fallback} label={label} onChange={color => patch({ [key]: color })} />
        <button type="button" className="text-xs text-fg-dim disabled:opacity-50" disabled={!prefs[key]}
          aria-label={`${label} 테마 색상 사용`} onClick={() => patch({ [key]: '' })}>테마</button>
      </div>
    </SettingsRow>)}
  </fieldset>;
}
