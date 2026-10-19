import { useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ToastAction, ToastCard } from '../../ui/toast/ToastCard';
import { ToastViewport } from '../../ui/toast/ToastViewport';
import { useToastTimer } from '../../ui/toast/useToastTimer';
import type { OrderNotice } from './orderFeedback';

export interface OrderReceipt { text: string; commandId: string; soundFailed?: boolean }

function OrderToastPortal({ children }: { children: ReactNode }) {
  const [host] = useState(() => document.getElementById('toast-viewport'));
  const content = <div className="order-toast">{children}</div>;
  return createPortal(host ? content : <ToastViewport>{content}</ToastViewport>, host ?? document.body);
}

export function OrderNoticeToast({ notice, receipt, busy, onDismiss, onExpireReceipt, onRetry }: {
  notice: OrderNotice | null; receipt: OrderReceipt | null; busy: boolean;
  onDismiss: () => void; onExpireReceipt: () => void; onRetry: () => void;
}) {
  const incoming = notice ?? receipt;
  const [shown, setShown] = useState(incoming);
  if (incoming && incoming !== shown) setShown(incoming);
  const content = incoming ?? shown;
  const isNotice = content != null && 'message' in content;
  const durationMs = isNotice ? content.persistent ? null : 8000 : 4000;
  const timer = useToastTimer({ visible: !!incoming, durationMs, resetKey: incoming,
    onExpire: notice ? onDismiss : onExpireReceipt });
  // Resolve the shared portal only after the app has mounted its viewport.
  // Retain it after dismissal so the common exit transition can finish.
  if (!content) return null;
  return <OrderToastPortal><ToastCard visible={!!incoming} variant={isNotice ? content.tone : content.soundFailed ? 'warn' : 'success'}
    role={isNotice ? 'alert' : 'status'} ariaLabel={isNotice ? '주문 알림' : '주문 접수 알림'}
    title={isNotice ? content.title : content?.text} onDismiss={isNotice ? onDismiss : undefined} dismissLabel="주문 알림 닫기"
    progress={timer.progress} {...timer.interactionProps}
    actions={isNotice && content.retry && <ToastAction disabled={busy} onClick={onRetry}>같은 요청 다시 확인</ToastAction>}>
    {isNotice ? content.message : undefined}
  </ToastCard></OrderToastPortal>;
}
