import { useId, useRef, useState, type ReactNode } from 'react';
import { MAX_AMOUNT_MILLIONS, MAX_ORDER_QUANTITY, validOrderSettings,
  type OrderPresets, type OrderWindowSettings } from '../../state/orderWindowSettings';
import { playOrderReceiptSound, prepareOrderReceiptSound } from './orderReceiptSound';
import './OrderSettingsForm.css';

const SECTIONS = [
  { id: 'input', label: '주문 입력' },
  { id: 'display', label: '호가 표시' },
  { id: 'sound', label: '주문 알림' },
] as const;

export function OrderSettingsSection({ id, title, description, children }: { id: string; title: string; description: string; children: ReactNode }) {
  return <section id={id} className="order-settings-section" aria-labelledby={`${id}-heading`}>
    <h3 id={`${id}-heading`} className="order-settings-section-title">{title}</h3>
    <p className="order-surface-description">{description}</p>
    <div className="order-settings-section-fields">{children}</div>
  </section>;
}

export function OrderSettingsCheckboxRow({ label, description, icon, checked, onChange }: {
  label: string; description?: string; icon?: ReactNode; checked: boolean; onChange: (checked: boolean) => void;
}) {
  return <label className="order-settings-option">
    <span><span className="order-settings-option-name">{icon}{label}</span>
      {description && <span className="order-settings-option-description">{description}</span>}</span>
    <input type="checkbox" aria-label={label} checked={checked} onChange={e => onChange(e.target.checked)} />
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
  const navigationId = useId();
  const bodyRef = useRef<HTMLDivElement>(null);
  const [activeSection, setActiveSection] = useState<string>('input');
  return <form className="order-settings-form" onSubmit={e => {
    e.preventDefault();
    if (!busy && valid) {
      if (draft.orderReceiptSound) prepareOrderReceiptSound();
      onApply(draft);
    }
  }}>
    <div className="order-surface-body">
      <nav aria-label="주문 설정 목차" className="order-surface-nav">
        <span className="order-surface-nav-label">설정</span>
        {SECTIONS.map(section => <button key={section.id} type="button" className="order-surface-nav-item"
          aria-current={activeSection === section.id ? 'true' : undefined} aria-controls={`${navigationId}-${section.id}`}
          onClick={() => {
            setActiveSection(section.id);
            document.getElementById(`${navigationId}-${section.id}`)?.scrollIntoView({ block: 'start' });
          }}>{section.label}</button>)}
      </nav>
      <div className="order-settings-body" ref={bodyRef} onScroll={() => {
        const body = bodyRef.current;
        if (!body) return;
        const top = body.getBoundingClientRect().top;
        let next: string = 'input';
        for (const section of SECTIONS) {
          const element = document.getElementById(`${navigationId}-${section.id}`);
          if (element && element.getBoundingClientRect().top <= top + 32) next = section.id;
        }
        if (body.scrollHeight - body.scrollTop - body.clientHeight < 2) next = 'sound';
        setActiveSection(current => current === next ? current : next);
      }}>
      <OrderSettingsSection id={`${navigationId}-input`} title="주문 입력" description="자주 쓰는 수량과 금액을 미리 정합니다.">
        <PresetInputs label="수량 프리셋" suffix="주" max={MAX_ORDER_QUANTITY} values={draft.quantityPresets}
          onChange={quantityPresets => onChange({ ...draft, quantityPresets })} />
        <PresetInputs label="금액 프리셋" suffix="백만원" max={MAX_AMOUNT_MILLIONS} values={draft.amountPresets}
          onChange={amountPresets => onChange({ ...draft, amountPresets })} />
        <OrderSettingsCheckboxRow label="종목별 주문수량 기억"
          description="다른 종목을 봤다가 돌아오면 마지막 입력한 수량을 불러옵니다. 같은 창·계좌에서 창을 열어둔 동안만 기억합니다."
          checked={draft.rememberQuantity} onChange={rememberQuantity => onChange({ ...draft, rememberQuantity })} />
      </OrderSettingsSection>
      <OrderSettingsSection id={`${navigationId}-display`} title="호가 표시" description="호가창에 표시할 정보를 선택합니다.">
        <OrderSettingsCheckboxRow label="내 평단가 표시" description="평단가에 빨간 점을 표시합니다."
          icon={<span className="order-settings-average-dot" aria-hidden="true" />}
          checked={draft.showAveragePrice} onChange={showAveragePrice => onChange({ ...draft, showAveragePrice })} />
      </OrderSettingsSection>
      <OrderSettingsSection id={`${navigationId}-sound`} title="주문 알림" description="매수·매도 주문접수를 소리로 알립니다.">
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
        </div>
        {previewFailed && <p role="status" className="text-xs text-fg-dim">소리를 재생할 수 없습니다. 브라우저의 소리 설정을 확인하세요.</p>}
      </OrderSettingsSection>
      </div>
    </div>
    <div className="order-surface-footer">
      {valid ? <span className="order-surface-footer-note">적용을 눌러 저장합니다.</span>
        : <span role="alert" className="order-settings-error">프리셋은 허용 범위의 양의 정수로 입력하세요</span>}
      <button type="button" onClick={onCancel}>취소</button>
      <button type="submit" className="order-primary" disabled={busy || !valid}>적용</button>
    </div>
  </form>;
}
