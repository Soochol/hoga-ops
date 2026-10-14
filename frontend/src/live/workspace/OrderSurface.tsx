import type { ReactNode } from 'react';
import './OrderSurface.css';

export function OrderSurfaceHeading({ children, onClose, closeLabel, actions }: {
  children: ReactNode; onClose: () => void; closeLabel: string; actions?: ReactNode;
}) {
  return <div className="order-surface-heading">
    <div className="order-surface-title">{children}</div>
    <div className="order-surface-actions">{actions}
      <button type="button" className="order-surface-icon" aria-label={closeLabel} onClick={onClose}><span aria-hidden="true">✕</span></button>
    </div>
  </div>;
}
