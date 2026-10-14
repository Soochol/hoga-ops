import { useId, useState, type ReactNode } from 'react';
import { MAX_AMOUNT_MILLIONS, MAX_ORDER_QUANTITY, validOrderSettings,
  type OrderPresets, type OrderWindowSettings } from '../../state/orderWindowSettings';
import { playOrderReceiptSound, prepareOrderReceiptSound } from './orderReceiptSound';
import './OrderSettingsForm.css';

export function OrderSettingsSection({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return <section className="order-settings-section" aria-labelledby={id}>
    <h3 id={id} className="order-settings-section-title">{title}</h3>
    <div className="order-settings-section-fields">{children}</div>
  </section>;
}

export function OrderSettingsCheckboxRow({ label, icon, checked, onChange }: {
  label: string; icon?: ReactNode; checked: boolean; onChange: (checked: boolean) => void;
}) {
  return <label className="order-settings-option">
    <span className="order-settings-option-name">{icon}{label}</span>
    <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} />
  </label>;
}

function PresetInputs({ label, suffix, max, values, onChange }: {
  label: string; suffix: string; max: number; values: OrderPresets; onChange: (values: OrderPresets) => void;
}) {
  return <fieldset><legend>{label}</legend>
    <div className="order-settings-presets">{values.map((value, index) => <label key={index}>
      <input type="number" aria-label={`${label} ${index + 1}`} min="1" max={max} step="1" value={value}
        onChange={e => onChange(values.map((n, i) => i === index ? Number(e.target.value) : n) as OrderPresets)} />
      <span className="order-preset-unit" aria-hidden="true">{suffix}</span>
    </label>)}</div>
  </fieldset>;
}

/** Controlled draft: persistence and popover lifecycle belong to the order window. */
export function OrderSettingsForm({ draft, onChange, onApply, onCancel, busy }: {
  draft: OrderWindowSettings; onChange: (settings: OrderWindowSettings) => void;
  onApply: (settings: OrderWindowSettings) => void; onCancel: () => void; busy: boolean;
}) {
  const valid = validOrderSettings(draft);
  const [previewFailed, setPreviewFailed] = useState(false);
  return <form className="order-settings-form" onSubmit={e => {
    e.preventDefault();
    if (!busy && valid) {
      if (draft.orderReceiptSound) prepareOrderReceiptSound();
      onApply(draft);
    }
  }}>
    <div className="order-settings-body">
      <OrderSettingsSection title="주문 입력">
        <p className="mb-2 text-xs text-fg-dim">변경한 값은 적용 후 반영됩니다.</p>
        <PresetInputs label="수량 프리셋" suffix="주" max={MAX_ORDER_QUANTITY} values={draft.quantityPresets}
          onChange={quantityPresets => onChange({ ...draft, quantityPresets })} />
        <PresetInputs label="금액 프리셋" suffix="백만원" max={MAX_AMOUNT_MILLIONS} values={draft.amountPresets}
          onChange={amountPresets => onChange({ ...draft, amountPresets })} />
      </OrderSettingsSection>
      <OrderSettingsSection title="호가 표시">
        <OrderSettingsCheckboxRow label="내 평단가 표시"
          icon={<span className="order-settings-average-dot" aria-hidden="true" />}
          checked={draft.showAveragePrice} onChange={showAveragePrice => onChange({ ...draft, showAveragePrice })} />
      </OrderSettingsSection>
      <OrderSettingsSection title="주문 알림">
        <OrderSettingsCheckboxRow label="주문접수 소리" checked={draft.orderReceiptSound}
          onChange={orderReceiptSound => {
            if (orderReceiptSound) prepareOrderReceiptSound();
            onChange({ ...draft, orderReceiptSound });
          }} />
        <div className="order-settings-sound-preview">
          <button type="button" disabled={busy} onClick={async () => {
            setPreviewFailed(false);
            setPreviewFailed(!await playOrderReceiptSound());
          }}>소리 들어보기</button>
          <span className="text-xs text-fg-dim">매수·매도 주문접수 시 재생</span>
        </div>
        {previewFailed && <p role="status" className="text-xs text-fg-dim">소리를 재생할 수 없습니다. 브라우저의 소리 설정을 확인하세요.</p>}
      </OrderSettingsSection>
      {!valid && <p role="alert" className="text-error">프리셋은 허용 범위의 양의 정수로 입력하세요</p>}
    </div>
    <div className="order-surface-footer">
      <button type="button" onClick={onCancel}>취소</button>
      <button type="submit" className="order-primary" disabled={busy || !valid}>적용</button>
    </div>
  </form>;
}
