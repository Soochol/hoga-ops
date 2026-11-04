import { useEffect, useId, useState, type ReactNode } from 'react';
import { EMPTY_COST_RATES, validCostRates } from '../../state/orderCostRates';
import { sellCostScope, SELL_COST_HELP, type SellCostContext } from './orderValuationCosts';
import { MAX_AMOUNT_MILLIONS, MAX_ORDER_QUANTITY, validOrderSettings,
  type OrderPresets, type OrderWindowSettings } from '../../state/orderWindowSettings';
import { playOrderReceiptSound, playOrderSound, prepareOrderReceiptSound, subscribeOrderReceiptSoundRecovery } from './orderReceiptSound';
import { SettingsRow, ToggleSwitch } from '../settings/SettingsRow';
import { TooltipButton } from '../../ui/TextTooltip';
import { AppIcon } from '../../ui/AppIcon';
import { WindowSettingsEditor, WindowSettingsGroup } from './WindowSettingsEditor';
import './OrderSettingsForm.css';

function OrderSettingsToggleRow({ label, icon, actions, checked, onChange, disabled = false }: {
  label: string; icon?: ReactNode; actions?: ReactNode; checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean;
}) {
  const controlId = useId();
  return <SettingsRow controlId={controlId} label={<span className="inline-flex items-center gap-1">{icon}{label}</span>} disabled={disabled} className={actions ? 'order-settings-action-row' : ''}>
    <div className="order-settings-toggle-controls">{actions}
      <ToggleSwitch id={controlId} label={label} checked={checked} disabled={disabled} onClick={() => onChange(!checked)} />
    </div>
  </SettingsRow>;
}

function PresetInputs({ label, suffix, max, values, onChange, disabled }: {
  label: string; suffix: string; max: number; values: OrderPresets; onChange: (values: OrderPresets) => void; disabled: boolean;
}) {
  const wide = values.some(value => String(value).length > 7);
  return <SettingsRow label={`${label.startsWith('수량') ? '수량' : '금액'} · ${suffix}`} className={`order-settings-presets-row${wide ? ' order-settings-presets-wide' : ''}`} disabled={disabled}>
    <div className="order-settings-presets" role="group" aria-label={label}>{values.map((value, index) =>
      <input key={index} type="number" className="ui-field font-data" aria-label={`${label} ${index + 1}`} min="1" max={max} step="1" disabled={disabled} value={Number.isNaN(value) ? '' : value}
        onChange={e => onChange(values.map((n, i) => i === index ? e.target.value === '' ? NaN : Number(e.target.value) : n) as OrderPresets)} />
    )}</div>
  </SettingsRow>;
}

/** Incomplete presets stay local; cost edits persist as unknown until both rates are valid. */
export function OrderSettingsForm({ draft, onChange, busy, costContext, accountLabel }: {
  costContext: SellCostContext; accountLabel: string;
  draft: OrderWindowSettings; onChange: (settings: OrderWindowSettings) => void;
  busy: boolean;
}) {
  useEffect(() => {
    // Preview also works with every sound toggle off. Warm the device on opening
    // the settings, then retain it until the preview controls are closed.
    const release = subscribeOrderReceiptSoundRecovery();
    prepareOrderReceiptSound();
    return release;
  }, []);
  const valid = validOrderSettings(draft);
  const scope = sellCostScope(costContext);
  const rates = scope ? draft.sellCostProfiles[scope] ?? EMPTY_COST_RATES : EMPTY_COST_RATES;
  const costRateId = useId();
  function changeRate(key: 'commissionPercent' | 'taxPercent', value: string) {
    if (!scope) return;
    const profiles = { ...draft.sellCostProfiles };
    delete profiles[scope];
    profiles[scope] = { ...rates, [key]: value };
    onChange({ ...draft, sellCostProfiles: Object.fromEntries(Object.entries(profiles).slice(-64)) });
  }
  const [previewFailed, setPreviewFailed] = useState(false);
  return <WindowSettingsEditor className="order-settings-editor" data-testid="order-settings-shell" footer={
    <span role="status"><span className="window-settings-saved" aria-hidden>✓</span> {valid ? '변경 즉시 반영' : '유효한 값만 즉시 반영'}</span>
  }>
    <form className="order-settings-body" onSubmit={event => event.preventDefault()}>
      <WindowSettingsGroup title="주문 입력">
        <PresetInputs label="수량 프리셋" suffix="주" max={MAX_ORDER_QUANTITY} values={draft.quantityPresets} disabled={busy}
          onChange={quantityPresets => onChange({ ...draft, quantityPresets })} />
        <PresetInputs label="금액 프리셋" suffix="백만원" max={MAX_AMOUNT_MILLIONS} values={draft.amountPresets} disabled={busy}
          onChange={amountPresets => onChange({ ...draft, amountPresets })} />
        <OrderSettingsToggleRow label="종목별 주문수량 기억"
          checked={draft.rememberQuantity} disabled={busy} onChange={rememberQuantity => onChange({ ...draft, rememberQuantity })} />
      </WindowSettingsGroup>
      <WindowSettingsGroup title="호가 표시">
        <OrderSettingsToggleRow label="내 평단가 표시"
          icon={<span className="order-settings-average-dot" aria-hidden="true" />}
          checked={draft.showAveragePrice} disabled={busy} onChange={showAveragePrice => onChange({ ...draft, showAveragePrice })} />
        <OrderSettingsToggleRow label="호가·잔량 구분선"
          checked={draft.showPriceSeparators} disabled={busy} onChange={showPriceSeparators => onChange({ ...draft, showPriceSeparators })} />
        <OrderSettingsToggleRow label="호가 등락률 표시"
          checked={draft.showPriceChangePercent} disabled={busy} onChange={showPriceChangePercent => onChange({ ...draft, showPriceChangePercent })} />
      </WindowSettingsGroup>
      <WindowSettingsGroup title="평가 비용">
        <OrderSettingsToggleRow label="수수료·세금 반영" checked={draft.reflectSellCosts} disabled={busy}
          onChange={reflectSellCosts => onChange({ ...draft, reflectSellCosts })} />
        {draft.reflectSellCosts && <>
          <p className="window-settings-hint">사용자 입력 추정치 · 이 창의 보유종목 평가와 손익에만 적용</p>
          <p className="window-settings-hint">{accountLabel} · {costContext.symbol?.market ?? '상장시장 미확인'} · {costContext.venue} 시세 / {costContext.route} 주문 · {costContext.date} (KST)</p>
          {scope ? <>
            {(['commissionPercent', 'taxPercent'] as const).map(key => {
              const label = key === 'commissionPercent' ? '매도 수수료율 (%)' : '매도 거래세 합계율 (%)';
              return <SettingsRow key={key} label={label} controlId={`${costRateId}-${key}`} disabled={busy} className="order-settings-rate-row">
                <input id={`${costRateId}-${key}`} className="ui-field font-data" type="text" inputMode="decimal" maxLength={16}
                  value={rates[key]} disabled={busy} placeholder="미확인" onChange={event => changeRate(key, event.target.value)} />
              </SettingsRow>;
            })}
            <p className="window-settings-hint">증권사에서 확인한 오늘의 일반주식 적용률을 입력하세요. 거래세는 농특세를 포함합니다. 빈칸은 미확인, 0은 면제 확인입니다. 각 0~100%, 소수 6자리, 합계 100% 이하.</p>
            {!validCostRates(rates) && <p role="status" className="window-settings-validation">비용 확인 필요 · 두 적용률을 확인할 때까지 예상 평가를 표시하지 않습니다.</p>}
          </> : <p role="status" className="window-settings-validation">ETF·ETN은 보유기간 과세를 확인할 수 없어 지원하지 않습니다. 계좌·상품·상장시장 미확인도 예상 평가를 표시하지 않습니다.</p>}
          <p className="window-settings-hint">{SELL_COST_HELP} 다음 KST 날짜에는 다시 확인합니다.</p>
        </>}
      </WindowSettingsGroup>
      <WindowSettingsGroup title="주문 알림">
        <OrderSettingsToggleRow label="주문·정정 접수 소리" checked={draft.orderReceiptSound} disabled={busy}
          onChange={orderReceiptSound => {
            if (orderReceiptSound) prepareOrderReceiptSound();
            onChange({ ...draft, orderReceiptSound });
          }} actions={
          <button type="button" className="ui-icon-button" aria-label="소리 들어보기" data-tooltip="주문·정정 접수 소리 들어보기" disabled={busy} onClick={async () => {
            setPreviewFailed(false);
            setPreviewFailed(!await playOrderReceiptSound());
          }}><AppIcon name="play" size={12} /></button>
          } />
        {(['BUY', 'SELL'] as const).map(side => {
          const key = side === 'BUY' ? 'buyFillSound' : 'sellFillSound';
          const label = side === 'BUY' ? '매수 체결 소리' : '매도 체결 소리';
          return <OrderSettingsToggleRow key={key} label={label} checked={draft[key]} disabled={busy}
            onChange={enabled => {
              if (enabled) prepareOrderReceiptSound();
              onChange({ ...draft, [key]: enabled });
            }} actions={<TooltipButton type="button" className="ui-icon-button" disabled={busy} aria-label={`${label} 들어보기`}
              title={side === 'BUY' ? '소프트 코드 · 0.5초' : '레이더 · 0.5초'} onClick={async () => {
                setPreviewFailed(false);
                setPreviewFailed(!await playOrderSound(side === 'BUY' ? 'buy-fill' : 'sell-fill'));
              }}><AppIcon name="play" size={12} /></TooltipButton>} />;
        })}
        {previewFailed && <p role="status" className="text-xs text-fg-dim">소리를 재생할 수 없습니다. 브라우저의 소리 설정을 확인하세요.</p>}
      </WindowSettingsGroup>
      {!valid && <p role="alert" className="window-settings-validation">프리셋은 허용 범위의 양의 정수만 저장됩니다.</p>}
      </form>
  </WindowSettingsEditor>;
}
