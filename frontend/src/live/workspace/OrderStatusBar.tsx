import { useCallback, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTextTooltip } from '../../ui/useTextTooltip';
import { useToastTimer } from '../../ui/toast/useToastTimer';
import { useAnchoredPopover } from '../../util/useAnchoredPopover';
import { OrderSurfaceHeading } from './OrderSurface';
import type { OrderNotice } from './orderFeedback';
import './OrderStatusBar.css';

export interface OrderReceipt { text: string; commandId: string; soundFailed?: boolean }

export function OrderStatusBar({ notice, receipt, busy, onDismiss, onExpireReceipt, onRetry, children }: {
  notice: OrderNotice | null; receipt: OrderReceipt | null; busy: boolean;
  onDismiss: () => void; onExpireReceipt: () => void; onRetry: () => void;
  children?: ReactNode;
}) {
  const incoming = notice ?? receipt;
  // A new result never opens details or takes focus by itself.
  const [detail, setDetail] = useState({ incoming, open: false });
  if (detail.incoming !== incoming) setDetail({ incoming, open: false });
  const open = incoming != null && detail.incoming === incoming && detail.open;
  const messageRef = useRef<HTMLButtonElement>(null);
  const detailId = useId();
  const closeDetails = useCallback(() => {
    setDetail(current => ({ ...current, open: false }));
    messageRef.current?.focus({ preventScroll: true });
  }, []);
  const { ref, style } = useAnchoredPopover<HTMLDivElement>(open, messageRef, closeDetails, 360);
  useLayoutEffect(() => {
    if (!open) return;
    const layer = ref.current;
    const trigger = messageRef.current;
    return () => {
      if (document.activeElement === document.body || layer?.contains(document.activeElement)) trigger?.focus({ preventScroll: true });
    };
  }, [open, ref]);
  const text = notice?.message ?? receipt?.text ?? '주문 대기';
  const tooltip = useTextTooltip(incoming && !open ? `${notice ? `${notice.title} · ` : ''}${text}` : '', 500, 'order-tooltip');
  const durationMs = open || notice?.persistent ? null : notice ? 8000 : 4000;
  const timer = useToastTimer({ visible: !!incoming, durationMs, resetKey: incoming,
    onExpire: notice ? onDismiss : onExpireReceipt });
  const showDetails = () => {
    if (!incoming) return;
    tooltip.hide(); setDetail({ incoming, open: true });
  };
  const dismiss = () => {
    setDetail(current => ({ ...current, open: false })); tooltip.hide();
    if (notice) onDismiss(); else onExpireReceipt();
  };
  const tone = notice?.tone ?? (receipt ? receipt.soundFailed ? 'warn' : 'success' : 'neutral');
  return <>
    <div className={`order-status-bar order-status-${tone}`} data-testid="order-status-bar"
      role={notice ? 'alert' : 'status'} aria-label={notice ? '주문 알림' : receipt ? '주문 접수 알림' : '주문 상태'}
      {...timer.interactionProps}>
      <span className="order-status-icon" aria-hidden="true" data-symbol={notice ? '!' : receipt ? '✓' : '·'} />
      {notice && <span className="sr-only">{notice.title}</span>}
      <button ref={messageRef} type="button" className="order-status-message" disabled={!incoming}
        aria-label="주문 알림 상세 보기" aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? detailId : undefined}
        aria-describedby={tooltip.id} onClick={showDetails}
        onMouseEnter={e => tooltip.show(e.currentTarget)} onMouseLeave={tooltip.hide}
        onFocus={e => tooltip.showOnFocus(e.currentTarget)} onBlur={tooltip.hide}>
        {text}
      </button>
      {(notice?.retry || children) && <button type="button" className="order-status-action" onClick={showDetails}>내역 확인</button>}
      <button type="button" className="order-status-dismiss" aria-label="주문 알림 닫기"
        style={{ visibility: incoming && !notice?.persistent ? 'visible' : 'hidden' }} onClick={dismiss}><span aria-hidden="true" data-symbol="×" /></button>
    </div>
    {tooltip.tooltip}
    {open && createPortal(<div ref={ref} id={detailId} role="dialog" aria-label="주문 알림 상세"
      className="order-status-detail order-surface font-data" style={style}
      onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeDetails(); } }}>
      <OrderSurfaceHeading onClose={closeDetails} closeLabel="주문 알림 상세 닫기">{notice?.title ?? '주문 접수 알림'}</OrderSurfaceHeading>
      <div className="order-status-detail-body">
        <p>{text}</p>
        {notice?.retry && <button type="button" disabled={busy} onClick={() => { closeDetails(); onRetry(); }}>같은 요청 다시 확인</button>}
        {children}
      </div>
    </div>, document.body)}
  </>;
}
