import { useId, useRef, useState, type ReactNode } from 'react';
import { MAX_AMOUNT_MILLIONS, MAX_ORDER_QUANTITY, validOrderSettings,
  type OrderPresets, type OrderWindowSettings } from '../../state/orderWindowSettings';
import { playOrderReceiptSound, prepareOrderReceiptSound } from './orderReceiptSound';
import { SettingsEditor, SettingsEditorNavItem } from '../settings/SettingsEditor';
import { SettingsRow, ToggleSwitch } from '../settings/SettingsRow';
import './OrderSettingsForm.css';

const SECTIONS = [
  { id: 'input', label: '주문 입력' },
  { id: 'display', label: '호가 표시' },
  { id: 'sound', label: '주문 알림' },
] as const;

type SectionId = (typeof SECTIONS)[number]['id'];

function OrderSettingsSection({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return <section id={id} className="order-settings-section" aria-labelledby={`${id}-heading`}>
    <h3 id={`${id}-heading`} className="order-settings-section-title">{title}</h3>
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
export function OrderSettingsForm({ draft, onChange, busy, onClose }: {
  draft: OrderWindowSettings; onChange: (settings: OrderWindowSettings) => void;
  busy: boolean; onClose: () => void;
}) {
  const valid = validOrderSettings(draft);
  const [previewFailed, setPreviewFailed] = useState(false);
  const navigationId = useId();
  const [activeSection, setActiveSection] = useState<SectionId>('input');
  const bodyRef = useRef<HTMLFormElement>(null);
  const scrollTop = useRef(0);
  function jump(id: SectionId) {
    const body = bodyRef.current;
    const section = document.getElementById(`${navigationId}-${id}`);
    if (body && section) {
      const inset = Number.parseFloat(window.getComputedStyle(body).paddingTop) || 0;
      body.scrollTop += section.getBoundingClientRect().top - body.getBoundingClientRect().top - inset;
      // Keep the clicked item selected even when the target is near the end
      // and the browser clamps the requested scroll position.
      scrollTop.current = body.scrollTop;
    }
    setActiveSection(id);
  }
  return <SettingsEditor title="주문 설정" onClose={onClose} closeLabel="주문 설정 닫기" testId="order-settings-shell" className="order-settings-editor"
    sidebar={<nav aria-label="주문 설정 목차" className="order-settings-nav">
      {SECTIONS.map(section => <SettingsEditorNavItem key={section.id} active={activeSection === section.id} aria-controls={`${navigationId}-${section.id}`}
        onClick={() => jump(section.id)}>{section.label}</SettingsEditorNavItem>)}
    </nav>}>
      <form className="settings-editor-content order-settings-body" ref={bodyRef} onSubmit={event => event.preventDefault()} onScroll={event => {
        const body = event.currentTarget;
        if (body.scrollTop === scrollTop.current) return;
        scrollTop.current = body.scrollTop;
        const inset = Number.parseFloat(window.getComputedStyle(body).paddingTop) || 0;
        const top = body.getBoundingClientRect().top + inset + 4;
        let next: SectionId = 'input';
        for (const section of SECTIONS) {
          const element = document.getElementById(`${navigationId}-${section.id}`);
          if (element && element.getBoundingClientRect().top <= top) next = section.id;
        }
        if (body.scrollTop > 0 && body.scrollHeight - body.scrollTop - body.clientHeight < 2) next = 'sound';
        setActiveSection(next);
      }}>
      <OrderSettingsSection id={`${navigationId}-input`} title="주문 입력">
        <PresetInputs label="수량 프리셋" suffix="주" max={MAX_ORDER_QUANTITY} values={draft.quantityPresets} disabled={busy}
          onChange={quantityPresets => onChange({ ...draft, quantityPresets })} />
        <PresetInputs label="금액 프리셋" suffix="백만원" max={MAX_AMOUNT_MILLIONS} values={draft.amountPresets} disabled={busy}
          onChange={amountPresets => onChange({ ...draft, amountPresets })} />
        <OrderSettingsToggleRow label="종목별 주문수량 기억"
          checked={draft.rememberQuantity} disabled={busy} onChange={rememberQuantity => onChange({ ...draft, rememberQuantity })} />
      </OrderSettingsSection>
      <OrderSettingsSection id={`${navigationId}-display`} title="호가 표시">
        <OrderSettingsToggleRow label="내 평단가 표시"
          icon={<span className="order-settings-average-dot" aria-hidden="true" />}
          checked={draft.showAveragePrice} disabled={busy} onChange={showAveragePrice => onChange({ ...draft, showAveragePrice })} />
      </OrderSettingsSection>
      <OrderSettingsSection id={`${navigationId}-sound`} title="주문 알림">
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
  </SettingsEditor>;
}
