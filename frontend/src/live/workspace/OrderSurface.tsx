import type { ReactNode } from 'react';
import './OrderSurface.css';

export function OrderSurfaceHeading({ children, onClose, closeLabel, actions, scope }: {
  children: ReactNode; onClose: () => void; closeLabel: string; actions?: ReactNode; scope?: ReactNode;
}) {
  return <div className="order-surface-heading">
    <h2 className="order-surface-title">{children}</h2>
    <div className="order-surface-actions">{scope && <span className="order-surface-scope">{scope}</span>}{actions}
      <button type="button" className="order-surface-icon" aria-label={closeLabel} onClick={onClose}><span aria-hidden="true">✕</span></button>
    </div>
  </div>;
}
