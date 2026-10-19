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

type SectionId = (typeof SECTIONS)[number]['id'];

function OrderSettingsSection({ id, title, active, children }: { id: string; title: string; active: boolean; children: ReactNode }) {
  return <section id={id} data-current={active} className="order-settings-section" aria-labelledby={`${id}-heading`}>
    <h3 id={`${id}-heading`} className="order-settings-section-title">{title}</h3>
    <div className="order-settings-section-fields">{children}</div>
  </section>;
}

function OrderSettingsCheckboxRow({ label, icon, checked, onChange, disabled = false }: {
  label: string; icon?: ReactNode; checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean;
}) {
  return <label className="order-settings-option">
    <span className="order-settings-option-name">{icon}{label}</span>
    <input type="checkbox" aria-label={label} checked={checked} disabled={disabled} onChange={e => onChange(e.target.checked)} />
  </label>;
}

function PresetInputs({ label, suffix, max, values, onChange, disabled }: {
  label: string; suffix: string; max: number; values: OrderPresets; onChange: (values: OrderPresets) => void; disabled: boolean;
}) {
  return <fieldset><legend>{label.startsWith('수량') ? '수량' : '금액'} · {suffix}</legend>
    <div className="order-settings-presets">{values.map((value, index) => <label key={index}>
      <input type="number" aria-label={`${label} ${index + 1}`} min="1" max={max} step="1" disabled={disabled} value={Number.isNaN(value) ? '' : value}
        onChange={e => onChange(values.map((n, i) => i === index ? e.target.value === '' ? NaN : Number(e.target.value) : n) as OrderPresets)} />
    </label>)}</div>
  </fieldset>;
}

/** Incomplete number edits stay local; valid changes are saved by the order window. */
export function OrderSettingsForm({ draft, onChange, busy }: {
  draft: OrderWindowSettings; onChange: (settings: OrderWindowSettings) => void;
  busy: boolean;
}) {
  const valid = validOrderSettings(draft);
  const [previewFailed, setPreviewFailed] = useState(false);
  const navigationId = useId();
  const [activeSection, setActiveSection] = useState<SectionId>('input');
  const bodyRef = useRef<HTMLDivElement>(null);
  const scrollTop = useRef(0);
  function jump(id: SectionId) {
    const body = bodyRef.current;
    const section = document.getElementById(`${navigationId}-${id}`);
    if (body && section) {
      body.scrollTop += section.getBoundingClientRect().top - body.getBoundingClientRect().top - 12;
      // Keep the clicked item selected even when the target is near the end
      // and the browser clamps the requested scroll position.
      scrollTop.current = body.scrollTop;
    }
    setActiveSection(id);
  }
  return <form className="order-settings-form" onSubmit={e => e.preventDefault()}>
    <div className="order-surface-body">
      <nav aria-label="주문 설정 목차" className="order-surface-nav">
        {SECTIONS.map(section => <button key={section.id} type="button" className="order-surface-nav-item"
          aria-current={activeSection === section.id ? 'true' : undefined} aria-controls={`${navigationId}-${section.id}`}
          onClick={() => jump(section.id)}>{section.label}</button>)}
      </nav>
      <div className="order-settings-body" ref={bodyRef} onScroll={event => {
        const body = event.currentTarget;
        if (body.scrollTop === scrollTop.current) return;
        scrollTop.current = body.scrollTop;
        const top = body.getBoundingClientRect().top + 16;
        let next: SectionId = 'input';
        for (const section of SECTIONS) {
          const element = document.getElementById(`${navigationId}-${section.id}`);
          if (element && element.getBoundingClientRect().top <= top) next = section.id;
        }
        if (body.scrollTop > 0 && body.scrollHeight - body.scrollTop - body.clientHeight < 2) next = 'sound';
        setActiveSection(next);
      }}>
      <OrderSettingsSection id={`${navigationId}-input`} title="주문 입력" active={activeSection === 'input'}>
        <PresetInputs label="수량 프리셋" suffix="주" max={MAX_ORDER_QUANTITY} values={draft.quantityPresets} disabled={busy}
          onChange={quantityPresets => onChange({ ...draft, quantityPresets })} />
        <PresetInputs label="금액 프리셋" suffix="백만원" max={MAX_AMOUNT_MILLIONS} values={draft.amountPresets} disabled={busy}
          onChange={amountPresets => onChange({ ...draft, amountPresets })} />
        <OrderSettingsCheckboxRow label="종목별 주문수량 기억"
          checked={draft.rememberQuantity} disabled={busy} onChange={rememberQuantity => onChange({ ...draft, rememberQuantity })} />
      </OrderSettingsSection>
      <OrderSettingsSection id={`${navigationId}-display`} title="호가 표시" active={activeSection === 'display'}>
        <OrderSettingsCheckboxRow label="내 평단가 표시"
          icon={<span className="order-settings-average-dot" aria-hidden="true" />}
          checked={draft.showAveragePrice} disabled={busy} onChange={showAveragePrice => onChange({ ...draft, showAveragePrice })} />
      </OrderSettingsSection>
      <OrderSettingsSection id={`${navigationId}-sound`} title="주문 알림" active={activeSection === 'sound'}>
        <OrderSettingsCheckboxRow label="주문접수 소리" checked={draft.orderReceiptSound} disabled={busy}
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
    {!valid && <p role="alert" className="order-settings-error">프리셋은 허용 범위의 양의 정수만 저장됩니다.</p>}
  </form>;
}
