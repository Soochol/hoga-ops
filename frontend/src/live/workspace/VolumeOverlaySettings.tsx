import { useWindowSettingsStore } from '../../state/windowSettings';
import { DEFAULT_CHART_DISPLAY_PREFS, type VolumeOverlayStyle } from '../../state/chartDisplayPrefs';
import { SettingsRow } from '../settings/SettingsRow';
import ColorSwatchPicker from '../indicators/ColorSwatchPicker';
import { resolveTokensThemed } from '../../util/tokens';

const TOKEN_SPEC = { up: ['--price-up', '#F04452'], down: ['--price-down', '#3485FA'] } as const;

export function VolumeOverlaySettings({ windowId }: { windowId: string }) {
  const prefs = useWindowSettingsStore(s => s.byWindow[windowId]?.chart) ?? DEFAULT_CHART_DISPLAY_PREFS;
  if (!prefs.volumeOverlayEnabled) return null;
  const patch = (values: Partial<VolumeOverlayStyle>) => useWindowSettingsStore.getState().patch(windowId, 'chart', values);
  const tokens = resolveTokensThemed(TOKEN_SPEC);
  return <details className="settings-dependent">
    <summary aria-label="거래량을 캔들에 겹쳐 표시 세부 설정">세부 설정</summary>
    {([
      ['volumeOverlayTransparency', '거래량 투명도', 0, 100],
      ['volumeOverlayHeight', '거래량 표시 높이', 10, 40],
    ] as const).map(([key, label, min, max]) => <SettingsRow key={key} label={label}>
      <div className="flex items-center gap-2">
        <input type="range" aria-label={label} min={min} max={max} step={1} value={prefs[key]}
          className="w-24 accent-accent" onChange={event => patch({ [key]: Number(event.target.value) })} />
        <output className="text-sm text-fg tabular-nums w-10 text-right">{prefs[key]}%</output>
      </div>
    </SettingsRow>)}
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
  </details>;
}
