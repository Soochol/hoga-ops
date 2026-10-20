import { useId, useState, type ReactNode } from 'react';
import { MAX_AMOUNT_MILLIONS, MAX_ORDER_QUANTITY, validOrderSettings,
  type OrderPresets, type OrderWindowSettings } from '../../state/orderWindowSettings';
import { playOrderReceiptSound, prepareOrderReceiptSound } from './orderReceiptSound';
import '../settings/SettingsEditor.css';
import { SettingsRow, ToggleSwitch } from '../settings/SettingsRow';
import './OrderSettingsForm.css';

function OrderSettingsSection({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return <section id={id} className="settings-editor-group order-settings-section" aria-labelledby={`${id}-heading`}>
    <h4 id={`${id}-heading`} className="order-settings-section-title">{title}</h4>
    {children}
  </section>;
}

function OrderSettingsToggleRow({ label, icon, actions, checked, onChange, disabled = false }: {
  label: string; icon?: ReactNode; actions?: ReactNode; checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean;
}) {
  return <SettingsRow label={<span className="inline-flex items-center gap-1.5">{icon}{label}</span>} disabled={disabled} className={actions ? 'order-settings-action-row' : ''}>
    <div className="order-settings-toggle-controls">{actions}
      <ToggleSwitch label={label} checked={checked} disabled={disabled} onClick={() => onChange(!checked)} />
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

/** Incomplete number edits stay local; valid changes are saved by the order window. */
export function OrderSettingsForm({ draft, onChange, busy }: {
  draft: OrderWindowSettings; onChange: (settings: OrderWindowSettings) => void;
  busy: boolean;
}) {
  const valid = validOrderSettings(draft);
  const [previewFailed, setPreviewFailed] = useState(false);
  const sectionId = useId();
  return <div className="settings-editor window-settings-editor order-settings-editor" data-testid="order-settings-shell">
    <form className="settings-editor-content order-settings-body" onSubmit={event => event.preventDefault()}>
      <OrderSettingsSection id={`${sectionId}-input`} title="주문 입력">
        <PresetInputs label="수량 프리셋" suffix="주" max={MAX_ORDER_QUANTITY} values={draft.quantityPresets} disabled={busy}
          onChange={quantityPresets => onChange({ ...draft, quantityPresets })} />
        <PresetInputs label="금액 프리셋" suffix="백만원" max={MAX_AMOUNT_MILLIONS} values={draft.amountPresets} disabled={busy}
          onChange={amountPresets => onChange({ ...draft, amountPresets })} />
        <OrderSettingsToggleRow label="종목별 주문수량 기억"
          checked={draft.rememberQuantity} disabled={busy} onChange={rememberQuantity => onChange({ ...draft, rememberQuantity })} />
      </OrderSettingsSection>
      <OrderSettingsSection id={`${sectionId}-display`} title="호가 표시">
        <OrderSettingsToggleRow label="내 평단가 표시"
          icon={<span className="order-settings-average-dot" aria-hidden="true" />}
          checked={draft.showAveragePrice} disabled={busy} onChange={showAveragePrice => onChange({ ...draft, showAveragePrice })} />
      </OrderSettingsSection>
      <OrderSettingsSection id={`${sectionId}-sound`} title="주문 알림">
        <OrderSettingsToggleRow label="주문접수 소리" checked={draft.orderReceiptSound} disabled={busy}
          onChange={orderReceiptSound => {
            if (orderReceiptSound) prepareOrderReceiptSound();
            onChange({ ...draft, orderReceiptSound });
          }} actions={
          <button type="button" className="ui-choice" disabled={busy} onClick={async () => {
            setPreviewFailed(false);
            setPreviewFailed(!await playOrderReceiptSound());
          }}>소리 들어보기</button>
          } />
        {previewFailed && <p role="status" className="text-xs text-fg-dim">소리를 재생할 수 없습니다. 브라우저의 소리 설정을 확인하세요.</p>}
      </OrderSettingsSection>
      {!valid && <p role="alert" className="mt-3 text-xs text-error">프리셋은 허용 범위의 양의 정수만 저장됩니다.</p>}
      </form>
    <footer className="settings-editor-footer">
      <span role="status"><span className="settings-editor-saved" aria-hidden>✓</span> {valid ? '변경 즉시 반영' : '유효한 값만 즉시 반영'}</span>
    </footer>
  </div>;
}
