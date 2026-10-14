import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { nanoid } from 'nanoid';
import { createPortal } from 'react-dom';
import { ToastCard } from '../../ui/toast/ToastCard';
import { ToastViewport } from '../../ui/toast/ToastViewport';
import { ModalShell } from '../../ui/ModalShell';
import { PanelContextMenu } from '../../ui/PanelContextMenu';
import { useTextTooltip } from '../../ui/useTextTooltip';
import { useAnchoredPopover } from '../../util/useAnchoredPopover';
import { MAX_AMOUNT_MILLIONS, MAX_ORDER_QUANTITY, normalizeOrderSettings,
  quantityForAmount, validOrderInput, validOrderSettings, type OrderWindowSettings, type OrderPresets } from '../../state/orderWindowSettings';
import {
  tradingCommand, useTradingAccounts, useTradingState,
  type TossOrder, type TradingSide, type TradingCommand, type TradingCommandResponse,
  type CreateTradingOrder, type ModifyTradingOrder, type CancelTradingOrders, type TradingCancelResponse,
  type ReviewTradingCommand, type TradingReviewResponse, type TradingMode, type ResetPaperAccount, type TradingStateResponse,
} from '../../api/trading';
import { useLiveSeries } from '../../api/liveSeries';
import { useQuoteByCode } from '../../api/liveQuotes';
import { useLiveStockLimits } from '../../api/liveStockLimits';
import { useLiveKrxClose } from '../../api/liveKrxClose';
import { useLiveViStatus } from '../../api/liveViStatus';
import type { OrderbookSnapshot } from '../../api/types';
import { useWallClockSecond } from '../../util/useWallClockSecond';
import { fillTradeSummaryFromQuote, latestOrderbookSnapshot, latestTradeSummary } from '../liveSidebarAdapters';
import { editableOrder, groupPriceOrders, HIGH_VALUE_WON, holdingProfitWon, holdingPurchaseAmountWon, orderRemainder, orderSideLabel } from './orderRules';
import { realMsToYyyymmdd } from '../liveDateTime';
import { BookSummary, TotalQtyStrip } from './BookPanel';
import './OrderWindow.css';

const fmt = (n: number | string | null | undefined) => n == null ? '—' : Number(n).toLocaleString('ko-KR');
const EMPTY_ORDERS: TossOrder[] = [];
type Action = {
  type: 'create' | 'modify' | 'cancel' | 'bulk';
  base: TradingCommand;
  side: TradingSide | null;
  price: number;
  quantity: number | null;
  order?: TossOrder;
};
type Drag = { order: TossOrder; x: number; y: number; cursorX: number; cursorY: number; active: boolean; price: number | null; cancel: boolean; pointer: number; element: HTMLButtonElement };

export function OrderWindow({ code, name, settings, onSettingsChange }: {
  code: string; name: string; settings?: OrderWindowSettings; onSettingsChange?: (settings: OrderWindowSettings) => void;
}) {
  const [mode, setMode] = useState<TradingMode>('paper');
  const [selectedAccounts, selectAccount] = useState<Record<TradingMode, number>>({ paper: 0, live: 0 });
  const [localSettings, setLocalSettings] = useState(() => normalizeOrderSettings(settings));
  const preferences = settings ?? localSettings;
  const [quantity, setQuantity] = useState(() => preferences.quantityPresets[0]);
  const [amountMillions, setAmountMillions] = useState(() => preferences.amountPresets[0]);
  function applySettings(next: OrderWindowSettings) {
    const quantitySlot = preferences.quantityPresets.indexOf(quantity);
    const amountSlot = preferences.amountPresets.indexOf(amountMillions);
    if (quantitySlot >= 0) setQuantity(next.quantityPresets[quantitySlot]);
    if (amountSlot >= 0) setAmountMillions(next.amountPresets[amountSlot]);
    setLocalSettings(next); onSettingsChange?.(next);
  }
  return <OrderWindowContent key={`${mode}:${code}`} code={code} name={name} mode={mode} onModeChange={setMode}
    preferences={preferences} quantity={quantity} onQuantityChange={setQuantity} amountMillions={amountMillions}
    onAmountChange={setAmountMillions} onApplySettings={applySettings}
    chosenAccount={selectedAccounts[mode]} onAccountChange={account => selectAccount(previous => ({ ...previous, [mode]: account }))} />;
}

function OrderWindowContent({ code, name, mode, onModeChange, chosenAccount, onAccountChange,
  preferences, quantity, onQuantityChange, amountMillions, onAmountChange, onApplySettings }: {
  code: string; name: string; mode: TradingMode; onModeChange: (mode: TradingMode) => void;
  chosenAccount: number; onAccountChange: (account: number) => void; preferences: OrderWindowSettings;
  quantity: number; onQuantityChange: (quantity: number) => void; amountMillions: number; onAmountChange: (millions: number) => void;
  onApplySettings: (settings: OrderWindowSettings) => void;
}) {
  const client = useQueryClient();
  const accounts = useTradingAccounts(mode);
  const account = chosenAccount || accounts.data?.accounts[0]?.account_seq || 0;
  const state = useTradingState(account, code, mode);
  // Orders always use LIVE integrated quotes, independent of chart cursor/global venue.
  const live = useLiveSeries(code, 'UN');
  const quote = useQuoteByCode([code], 'UN').get(code);
  const limits = useLiveStockLimits(code);
  const now = useWallClockSecond();
  const todayKst = realMsToYyyymmdd(now);
  const krxClose = useLiveKrxClose(code, todayKst);
  const vi = useLiveViStatus(code, 'UN');
  const snapshot = useMemo(() => latestOrderbookSnapshot(live.latestOb ? [live.latestOb] : live.ob), [live.latestOb, live.ob]);
  const summary = useMemo(() => fillTradeSummaryFromQuote(latestTradeSummary(live.trade), quote), [live.trade, quote]);
  const [lockedBook, lockBook] = useState<OrderbookSnapshot | null>(null);
  const book = lockedBook ?? snapshot;
  const [settingsDraft, setSettingsDraft] = useState<OrderWindowSettings | null>(null);
  const [previewPrice, setPreviewPrice] = useState<number | null>(null);
  const [action, setAction] = useState<Action | null>(null);
  const [confirmedHigh, confirmHigh] = useState(false);
  const [reviewedUnknown, reviewUnknown] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const closeMenu = useCallback(() => setContextMenu(null), []);
  const [notice, setNotice] = useState<string | null>(null);
  const [failedRequest, setFailedRequest] = useState<{ action: Action; high: boolean } | null>(null);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 8_000);
    return () => window.clearTimeout(timer);
  }, [notice]);
  const [busy, setBusy] = useState(false);
  const [paperSettings, showPaperSettings] = useState(false);
  const [paperCash, setPaperCash] = useState(100_000_000);
  const [paperHolding, setPaperHolding] = useState(0);
  const [paperAverage, setPaperAverage] = useState(1);
  const [paperConfirmed, confirmPaperReset] = useState(false);
  const busyRef = useRef(false);
  const [pendingIds, setPending] = useState<Record<string, string>>({});
  const rootRef = useRef<HTMLDivElement>(null);
  const infoButtonRef = useRef<HTMLButtonElement>(null);
  const [compact, setCompact] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [spacious, setSpacious] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const infoId = useId();
  const closeInfo = useCallback(() => {
    setInfoOpen(false);
    infoButtonRef.current?.focus({ preventScroll: true });
  }, []);
  const { ref: infoRef, style: infoStyle } = useAnchoredPopover<HTMLDivElement>(infoOpen, infoButtonRef, closeInfo, 260);
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let previousWidth = 0;
    const measure = () => {
      const width = root.getBoundingClientRect().width;
      if (width <= 0) return;
      setCompact(width < 560);
      const scroll = root.querySelector<HTMLElement>('.order-scroll');
      const usableWidth = Math.min(width, scroll?.clientWidth || width);
      setExpanded(usableWidth >= 560);
      setSpacious(usableWidth >= 672);
      if (width !== previousWidth) setInfoOpen(false);
      previousWidth = width;
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    const scroll = root.querySelector('.order-scroll');
    if (scroll) observer.observe(scroll);
    return () => observer.disconnect();
  }, []);
  const [dragTarget, setDragTarget] = useState<number | null>(null);
  const [dragCancel, setDragCancel] = useState(false);
  const [draggingOrderId, setDraggingOrderId] = useState<string | null>(null);
  const drag = useRef<Drag | null>(null);
  const dragPreview = useRef<HTMLDivElement>(null);
  // Cursor motion updates only the floating preview, not the live order ladder.
  function positionDragPreview() {
    const node = dragPreview.current, current = drag.current;
    if (!node || !current) return;
    const x = Math.max(8, Math.min(current.cursorX + 12, window.innerWidth - node.offsetWidth - 8));
    const y = Math.max(8, Math.min(current.cursorY + 12, window.innerHeight - node.offsetHeight - 8));
    node.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  }
  useLayoutEffect(positionDragPreview, [draggingOrderId, dragTarget, dragCancel]);
  const toastHost = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => { toastHost.current = document.getElementById('toast-viewport'); }, []);
  const suppressClick = useRef(false);
  const ladder = useRef<HTMLDivElement>(null);
  const orders = state.data?.orders ?? EMPTY_ORDERS;
  const draggedOrder = draggingOrderId ? orders.find(o => o.orderId === draggingOrderId) ?? drag.current?.order : null;
  const latestOrders = useRef(orders);
  useLayoutEffect(() => { latestOrders.current = orders; }, [orders]);
  const groups = useMemo(() => groupPriceOrders(orders), [orders]);
  const fresh = !!snapshot && now - snapshot.ts_ms >= -5_000 && now - snapshot.ts_ms < 30_000;
  const ready = account > 0 && !!state.data && !state.isError && !busy;
  const prices = book ? [...book.ask].reverse().concat(book.bid) : [];
  const onScreen = new Set(prices.map(l => l.price));
  const outside = orders.filter(o => o.price == null || !onScreen.has(Number(o.price)));
  const maxQty = Math.max(1, ...prices.map(l => l.qty));
  const baseline = quote?.baseline_price ?? summary.prevClose;
  const estimatePrice = previewPrice ?? quote?.price ?? null;
  const amountMode = preferences.unit === 'amount';
  const inputValue = amountMode ? amountMillions : quantity;
  const presets = amountMode ? preferences.amountPresets : preferences.quantityPresets;
  const setInputValue = amountMode ? onAmountChange : onQuantityChange;
  const estimateQuantity = amountMode && estimatePrice != null ? quantityForAmount(amountMillions, estimatePrice) : null;
  const estimateAmount = estimatePrice != null && estimatePrice > 0 && Number.isSafeInteger(quantity) && quantity > 0
    && Number.isSafeInteger(estimatePrice * quantity) ? estimatePrice * quantity : null;
  const holdingQuantity = state.data && !state.isError ? Number(state.data.holding_quantity) : null;
  const buyingPower = state.data && !state.isError ? Number(state.data.buying_power) : null;
  const holdingProfit = holdingProfitWon(holdingQuantity, quote?.price ?? null, state.data?.average_purchase_price);
  const purchaseAmount = holdingPurchaseAmountWon(holdingQuantity, state.data?.average_purchase_price);
  const purchaseText = purchaseAmount == null ? '' : `매수금액 ${fmt(purchaseAmount)}원`;
  const quantityTip = useTextTooltip(purchaseText, 500);
  const averageTip = useTextTooltip(purchaseText, 500);
  useEffect(() => {
    quantityTip.hide(); averageTip.hide();
  }, [account, quantityTip.hide, averageTip.hide]);
  const currentOrder = action?.order ? orders.find(o => o.orderId === action.order?.orderId) ?? action.order : null;
  const actionQty = action?.quantity ?? (currentOrder ? orderRemainder(currentOrder) : 0);
  const highValue = mode === 'live' && !!action && ['create', 'modify'].includes(action.type) && action.price * actionQty >= HIGH_VALUE_WON;

  function base(): TradingCommand { return { account_seq: account, code, command_id: nanoid() }; }
  function closeAction() { setAction(null); closeMenu(); confirmHigh(false); }
  function pending(order: TossOrder) {
    const replacement = pendingIds[order.orderId];
    // Keep the old order disabled until it leaves OPEN, or a reject is confirmed.
    return !!replacement && !state.data?.recent_orders.some(o => o.orderId === replacement && ['CANCEL_REJECTED', 'REPLACE_REJECTED'].includes(o.status));
  }
  async function submit(next: Action, high = false) {
    if (busyRef.current) return;
    if (!account || next.base.account_seq !== account || next.base.code !== code) { setNotice('계좌·종목이 변경되었습니다. 다시 선택하세요.'); return; }
    if ((next.type === 'create' || next.type === 'modify') && !fresh) { setNotice('실시간 호가가 오래되었습니다. 갱신 후 주문하세요.'); return; }
    busyRef.current = true; setBusy(true); setNotice(null); setFailedRequest(null);
    try {
      if (next.type === 'bulk') {
        const body: CancelTradingOrders = { ...next.base, side: next.side };
        const result = await tradingCommand<TradingCancelResponse>('/cancel-all', body, mode);
        const rejected = result.results.filter(r => !r.accepted);
        if (rejected.length) setNotice(`취소 미접수 ${rejected.length}건${rejected.map(r => ` · ${r.message}`).join('')}`);
        setPending(prev => ({ ...prev, ...Object.fromEntries(result.results.filter(r => r.accepted).map(r => [r.order_id, r.operation_id ?? r.order_id])) }));
      } else {
        let response: TradingCommandResponse;
        if (next.type === 'create') {
          const body: CreateTradingOrder = { ...next.base, side: next.side!, price: next.price, quantity: next.quantity!, confirm_high_value: high };
          response = await tradingCommand<TradingCommandResponse>('/orders', body, mode);
        } else {
          const path = `/orders/${encodeURIComponent(next.order!.orderId)}/${next.type}`;
          if (next.type === 'modify') {
            const body: ModifyTradingOrder = { ...next.base, price: next.price, quantity: next.quantity, confirm_high_value: high };
            response = await tradingCommand<TradingCommandResponse>(path, body, mode);
          } else response = await tradingCommand<TradingCommandResponse>(path, next.base, mode);
          setPending(prev => ({ ...prev, [next.order!.orderId]: response.order_id }));
        }
      }
      closeAction();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '주문 처리 결과를 확인하세요.');
      // A failure never opens the removed new-order editor. Retry retains its ID.
      setFailedRequest({ action: next, high });
    } finally {
      await client.invalidateQueries({ queryKey: ['trading', mode, 'state', account] });
      busyRef.current = false; setBusy(false);
    }
  }

  function request(next: Action) {
    closeMenu(); confirmHigh(false);
    const qty = next.quantity ?? (next.order ? orderRemainder(next.order) : 0);
    const high = ['create', 'modify'].includes(next.type) && next.price * qty >= HIGH_VALUE_WON;
    setFailedRequest(null); setNotice(null);
    if (mode === 'live' && high) setAction(next);
    else { closeAction(); void submit(next, mode === 'paper' && high); }
  }
  async function reviewCommand(commandId: string) {
    if (!reviewedUnknown || busyRef.current) return;
    busyRef.current = true; setBusy(true);
    try {
      const body: ReviewTradingCommand = { ...base(), command_id: commandId, confirmed: true };
      await tradingCommand<TradingReviewResponse>(`/commands/${encodeURIComponent(commandId)}/review`, body, mode);
      closeAction(); reviewUnknown(false);
    } catch (error) { setNotice(error instanceof Error ? error.message : '내역 확인 기록 실패'); }
    finally { await client.invalidateQueries({ queryKey: ['trading', mode, 'state', account] }); busyRef.current = false; setBusy(false); }
  }
  async function resetPaper() {
    if (mode !== 'paper' || !paperConfirmed || busyRef.current) return;
    busyRef.current = true; setBusy(true);
    try {
      const body: ResetPaperAccount = { ...base(), cash: paperCash, holding_quantity: paperHolding, average_purchase_price: paperAverage, confirmed: true };
      await tradingCommand<TradingStateResponse>('/reset', body, 'paper');
      showPaperSettings(false); closeAction(); setPending({});
      setNotice(null); setFailedRequest(null);
    } catch (error) { setNotice(error instanceof Error ? error.message : '모의 계좌 초기화 실패'); }
    finally { await client.invalidateQueries({ queryKey: ['trading', 'paper', 'state', account] }); busyRef.current = false; setBusy(false); }
  }
  function create(side: TradingSide, price: number) {
    if (!validOrderInput(inputValue, preferences.unit)) { setNotice(amountMode ? '주문 금액은 1백만원 이상의 정수로 설정하세요.' : '주문 수량은 1주 이상의 정수로 설정하세요.'); return; }
    const qty = amountMode ? quantityForAmount(amountMillions, price) : quantity;
    if (qty === 0) { setNotice('입력한 금액으로 해당 호가에서 1주를 주문할 수 없습니다.'); return; }
    if (qty == null) { setNotice('주문 금액과 호가 가격을 확인하세요.'); return; }
    if (!Number.isSafeInteger(qty) || qty < 1 || qty > 1_000_000_000) { setNotice('주문 수량은 1주 이상의 정수로 설정하세요.'); return; }
    if (orders.some(o => o.side !== side)) { setNotice('반대 방향 미체결 주문을 먼저 취소하거나 체결 후 주문하세요.'); return; }
    request({ type: 'create', base: base(), side, price, quantity: qty });
  }

  function beginDrag(e: PointerEvent<HTMLButtonElement>, order: TossOrder) {
    if (e.button !== 0 || !editableOrder(order) || pending(order) || !ready) return;
    e.stopPropagation();
    drag.current = { order, x: e.clientX, y: e.clientY, cursorX: e.clientX, cursorY: e.clientY, active: false, price: null, cancel: false, pointer: e.pointerId, element: e.currentTarget };
    lockBook(snapshot); e.currentTarget.setPointerCapture(e.pointerId);
  }
  function moveDrag(e: PointerEvent<HTMLButtonElement>) {
    const d = drag.current;
    if (!d || d.pointer !== e.pointerId) return;
    if (!d.active && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 6) return;
    if (!d.active) { d.active = true; setDraggingOrderId(d.order.orderId); }
    d.cursorX = e.clientX; d.cursorY = e.clientY;
    positionDragPreview();
    const rect = ladder.current?.getBoundingClientRect();
    const viewport = ladder.current?.closest('.order-scroll')?.getBoundingClientRect();
    const windowBounds = ladder.current?.closest('.order-window')?.getBoundingClientRect();
    if (!rect || !viewport || !windowBounds) return;
    // The outer window also clips the ladder when its fixed columns are horizontally scrolled.
    const left = Math.max(rect.left, viewport.left, windowBounds.left), right = Math.min(rect.right, viewport.right, windowBounds.right);
    const top = Math.max(rect.top, viewport.top, windowBounds.top), bottom = Math.min(rect.bottom, viewport.bottom, windowBounds.bottom);
    d.cancel = e.clientX < left || e.clientX > right || e.clientY < top || e.clientY > bottom;
    const hit = document.elementFromPoint(e.clientX, e.clientY);
    const row = hit?.closest<HTMLElement>('[data-order-price]')
      ?? (hit?.closest('.order-summary-layer') && ladder.current?.contains(hit)
        ? [...ladder.current.querySelectorAll<HTMLElement>('[data-order-price]')].find(row => {
          const bounds = row.getBoundingClientRect();
          return e.clientY >= bounds.top && e.clientY < bounds.bottom;
        }) : null);
    const lane = hit?.closest<HTMLElement>('[data-order-side]');
    d.price = !d.cancel && row && ladder.current?.contains(row) && (!lane || lane.dataset.orderSide === d.order.side) ? Number(row.dataset.orderPrice) : null;
    setDragTarget(d.price); setDragCancel(d.cancel);
  }
  function endDrag(e?: PointerEvent<HTMLButtonElement>, aborted = false) {
    if (e && !aborted) moveDrag(e);
    const d = drag.current;
    if (!d || (e && e.pointerId !== d.pointer)) return;
    drag.current = null;
    if (d.element.hasPointerCapture(d.pointer)) d.element.releasePointerCapture(d.pointer);
    suppressClick.current = d.active; lockBook(null); setDragTarget(null); setDragCancel(false); setDraggingOrderId(null);
    if (aborted || !d.active) return;
    const order = latestOrders.current.find(o => o.orderId === d.order.orderId);
    if (!order || !editableOrder(order) || orderRemainder(order) === 0) { setNotice('드래그 중 주문 상태가 변경되었습니다. 최신 내역을 확인하세요.'); return; }
    if (d.cancel) request({ type: 'cancel', base: base(), side: order.side, price: 0, quantity: null, order });
    else if (d.price && d.price !== Number(order.price)) request({ type: 'modify', base: base(), side: order.side, price: d.price, quantity: null, order });
  }

  function orderChip(order: TossOrder, label: string, content?: string) {
    const blocked = !editableOrder(order) || pending(order);
    return <button key={order.orderId} className={`order-chip ${order.orderId === draggingOrderId ? 'order-chip-dragging' : ''}`} type="button"
      aria-label={label} title={`${orderSideLabel(order.side)} ${fmt(order.price)}원 · 잔여 ${fmt(orderRemainder(order))}주`}
      disabled={!ready || blocked} data-drag-order={!blocked ? order.orderId : undefined}
      onPointerDown={e => beginDrag(e, order)} onPointerMove={moveDrag} onPointerUp={endDrag}
      onPointerCancel={() => endDrag(undefined, true)} onLostPointerCapture={() => endDrag(undefined, true)}>
      {content ?? `${fmt(orderRemainder(order))}주`}{blocked ? ' · 처리 중' : ''}
    </button>;
  }
  function orderCell(side: TradingSide, price: number, rowKey: string) {
    const group = groups.get(`${side}:${price}`) ?? [];
    const opposite = orders.some(o => o.side !== side);
    const destination = draggedOrder?.side === side && dragTarget === price && price > 0;
    return <div className={`order-lane ${side === 'BUY' ? 'order-buy' : 'order-sell'} ${destination ? 'order-drag-destination' : ''}`} data-order-side={side}>
      {group.map((order, index) => orderChip(order, `${orderSideLabel(side)} ${fmt(price)}원 주문${group.length > 1 ? ` ${index + 1}` : ''}`))}
      <button type="button" className="order-add" aria-label={`${orderSideLabel(side)} ${fmt(price)}원 주문 추가 ${rowKey}`}
        title={`${orderSideLabel(side)} 주문 · 더블클릭`}
        disabled={!ready || !fresh || price <= 0 || opposite || !!settingsDraft || !!state.data?.unresolved_commands.length
          || (amountMode && (quantityForAmount(amountMillions, price) ?? 0) < 1)}
        onDoubleClick={() => create(side, price)} />
    </div>;
  }

  const trades = useMemo(() => {
    const recent: { price: number; qty: number }[] = [];
    for (let i = live.trade.length - 1; i >= 0 && recent.length < 9; i--) {
      const rows = live.trade[i].trades;
      if (!Array.isArray(rows)) continue;
      for (let j = rows.length - 1; j >= 0 && recent.length < 9; j--) {
        const row = rows[j] as { price: number; qty: number };
        recent.push(row);
      }
    }
    return recent;
  }, [live.trade]);
  const renderSummary = (height: number) => <BookSummary summary={summary} baselinePrice={baseline ?? null}
    onScreenPrices={onScreen} limits={limits.data} krxClose={krxClose.data?.date === todayKst ? krxClose.data.price : null}
    vi={vi.data?.vi} height={height} />;
  return <div ref={rootRef} className={`order-window font-data ${compact ? 'order-compact' : ''} ${expanded ? 'order-expanded' : ''} ${spacious ? 'order-spacious' : ''} ${draggingOrderId ? 'order-dragging' : ''} ${dragCancel ? 'order-drag-canceling' : ''}`} data-testid="order-window" onPointerDownCapture={() => { suppressClick.current = false; }}
    onClickCapture={e => { if (suppressClick.current) { e.preventDefault(); e.stopPropagation(); suppressClick.current = false; } }}
    onKeyDown={e => {
      if (e.key === 'Escape') {
        if (settingsDraft) { e.preventDefault(); e.stopPropagation(); setSettingsDraft(null); return; }
        if (drag.current || action || contextMenu) { e.preventDefault(); e.stopPropagation(); }
        endDrag(undefined, true); closeAction(); return;
      }
      if (!e.ctrlKey || e.repeat || busy || (e.target instanceof HTMLElement && ['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName))) return;
      if (['1', '2', '3'].includes(e.key)) { e.preventDefault(); setInputValue(presets[Number(e.key) - 1]); }
    }}>
    <div className="order-controls order-account-controls">
      <div className="order-account-group">
      <select aria-label="주문 모드" value={mode} disabled={busy || !!lockedBook} onChange={e => onModeChange(e.target.value as TradingMode)}>
        <option value="paper">로컬 모의 계좌</option><option value="live">토스 실계좌</option>
      </select>
      {mode === 'paper' && <button type="button" disabled={!ready || !!lockedBook} onClick={() => { closeAction(); showPaperSettings(!paperSettings); setPaperAverage(Math.max(1, quote?.price ?? 1)); confirmPaperReset(false); }}>모의 계좌 설정</button>}
      {accounts.data && accounts.data.accounts.length > 1 ? <select aria-label="주문 계좌" value={account} disabled={busy || !!lockedBook}
        onChange={e => { onAccountChange(Number(e.target.value)); closeAction(); setPending({}); setFailedRequest(null); setNotice(null); }}>
        {accounts.data.accounts.map(a => <option key={a.account_seq} value={a.account_seq}>{a.label}</option>)}
      </select> : <span className="text-fg-dim">{accounts.data?.accounts[0]?.label ?? '계좌 연결 대기'}</span>}
      </div>
      <div className="order-settings-group">
      <button type="button" aria-label="주문 설정" disabled={busy || !!lockedBook} onClick={() => { closeAction(); setSettingsDraft(normalizeOrderSettings(preferences)); }}>설정</button>
      <span className="order-buying-power" aria-label="매수 가능 금액"><span className="order-meta">매수 가능</span><span>{buyingPower != null && Number.isSafeInteger(buyingPower) && buyingPower >= 0 ? `${fmt(buyingPower)}원` : '—'}</span></span>
      {!expanded && <button ref={infoButtonRef} type="button" aria-label="종목 상세 정보" aria-haspopup="dialog" aria-expanded={infoOpen} aria-controls={infoOpen ? infoId : undefined}
        disabled={!!lockedBook} onClick={() => setInfoOpen(open => !open)}>정보</button>}
      </div>
    </div>
    <div className="order-controls order-quantity-controls">
      <div className="order-holdings-summary" role="group" aria-label="보유 종목 정보">
        <span className="order-field" aria-label="매입수량" aria-describedby={quantityTip.id} tabIndex={purchaseAmount == null ? undefined : 0}
          onMouseEnter={e => quantityTip.show(e.currentTarget)} onMouseLeave={quantityTip.hide}
          onFocus={e => quantityTip.show(e.currentTarget)} onBlur={quantityTip.hide}
          onKeyDown={e => { if (e.key === 'Escape') quantityTip.hide(); }}>
          <span className="order-field-value">{holdingQuantity != null && Number.isSafeInteger(holdingQuantity) && holdingQuantity >= 0 ? fmt(holdingQuantity) : '—'}</span>
        </span>
        <span className="order-field" aria-label="매입평단가" aria-describedby={averageTip.id} tabIndex={purchaseAmount == null ? undefined : 0}
          onMouseEnter={e => averageTip.show(e.currentTarget)} onMouseLeave={averageTip.hide}
          onFocus={e => averageTip.show(e.currentTarget)} onBlur={averageTip.hide}
          onKeyDown={e => { if (e.key === 'Escape') averageTip.hide(); }}>
          <span className="order-field-value">{holdingQuantity != null && holdingQuantity > 0 && state.data?.average_purchase_price != null ? fmt(Math.ceil(Number(state.data.average_purchase_price))) : '—'}</span>
        </span>
        <span className="order-field" aria-label="보유 종목 평가 수익"><span className={`order-field-value ${holdingProfit != null && holdingProfit > 0 ? 'text-price-up' : holdingProfit != null && holdingProfit < 0 ? 'text-price-down' : 'text-fg'}`}>{holdingProfit == null ? '—' : fmt(holdingProfit)}</span></span>
      </div>
      <div className="order-input-controls" role="group" aria-label="공통 주문 수량">
        <label className="order-field"><span className="order-field-value"><input type="number" aria-label={amountMode ? '신규 주문 금액' : '신규 주문 수량'} min="1" max={amountMode ? MAX_AMOUNT_MILLIONS : MAX_ORDER_QUANTITY} step="1" value={inputValue} onChange={e => setInputValue(Number(e.target.value))} />{amountMode ? '백만원' : '주'}</span></label>
        <div className="order-quantity-presets">
          {presets.map((value, index) => <button type="button" key={index} aria-pressed={inputValue === value} onClick={() => setInputValue(value)}>{fmt(value)}{amountMode ? '백만' : '주'}</button>)}
        </div>
        <span className="order-field" aria-label={amountMode ? '예상 주문 수량' : '예상 주문 금액'} title={previewPrice != null ? `${fmt(previewPrice)}원 기준` : undefined}>
          <span className="order-field-value">{amountMode ? estimateQuantity == null ? '—' : `${fmt(estimateQuantity)}주` : estimateAmount == null ? '—' : `${fmt(estimateAmount)}원`}
          </span>
        </span>
      </div>
    </div>
    {infoOpen && createPortal(<div ref={infoRef} id={infoId} role="dialog" aria-label="종목 상세 정보" className="order-info-popover font-data" style={infoStyle}>
      <div className="order-info-heading"><span>종목 정보</span><button type="button" aria-label="종목 정보 닫기" onClick={closeInfo}>닫기</button></div>
      {renderSummary(264)}
    </div>, document.body)}
    {quantityTip.tooltip}
    {averageTip.tooltip}
    {draggedOrder && createPortal(<div ref={dragPreview} role="status" aria-label="주문 드래그 미리보기"
      className={`order-drag-preview font-data ${draggedOrder.side === 'BUY' ? 'order-buy' : 'order-sell'} ${dragCancel ? 'order-drag-preview-cancel' : ''}`}>
      {fmt(orderRemainder(draggedOrder))}주
    </div>, document.body)}
    {settingsDraft && createPortal(<div className="order-settings-surface font-data" onKeyDown={e => {
      e.stopPropagation(); if (e.key === 'Escape') { e.preventDefault(); setSettingsDraft(null); }
    }}><ModalShell ariaLabel="주문 설정" title="주문 설정" width="w-[360px]" onClose={() => setSettingsDraft(null)}>
      <form onSubmit={e => { e.preventDefault(); if (!busy && validOrderSettings(settingsDraft)) { onApplySettings(settingsDraft); setSettingsDraft(null); } }}>
        <div className="order-settings-body">
          <fieldset><legend>주문 방식</legend><div className="order-settings-mode">
            <label><input type="radio" name="order-input-unit" value="quantity" checked={settingsDraft.unit === 'quantity'} onChange={() => setSettingsDraft({ ...settingsDraft, unit: 'quantity' })} />수량</label>
            <label><input type="radio" name="order-input-unit" value="amount" checked={settingsDraft.unit === 'amount'} onChange={() => setSettingsDraft({ ...settingsDraft, unit: 'amount' })} />금액</label>
          </div></fieldset>
          {(['quantity', 'amount'] as const).map(unit => <fieldset key={unit}><legend>{unit === 'quantity' ? '수량 프리셋 · 주' : '금액 프리셋 · 백만원'}</legend>
            <div className="order-settings-presets">{(unit === 'quantity' ? settingsDraft.quantityPresets : settingsDraft.amountPresets).map((value, index) => <label key={index}>
              <span className="order-meta">프리셋 {index + 1}</span><input type="number" aria-label={`${unit === 'quantity' ? '수량' : '금액'} 프리셋 ${index + 1}`} min="1" max={unit === 'quantity' ? MAX_ORDER_QUANTITY : MAX_AMOUNT_MILLIONS} step="1" value={value}
                onChange={e => { const key = unit === 'quantity' ? 'quantityPresets' : 'amountPresets'; setSettingsDraft({ ...settingsDraft, [key]: settingsDraft[key].map((n, i) => i === index ? Number(e.target.value) : n) as OrderPresets }); }} />
            </label>)}</div>
          </fieldset>)}
          <span className="order-meta">1백만원 = 100만원 · 양의 정수로 입력</span>
          {!validOrderSettings(settingsDraft) && <p role="alert" className="text-error">프리셋은 허용 범위의 양의 정수로 입력하세요</p>}
        </div>
        <div className="order-settings-footer"><button type="button" onClick={() => setSettingsDraft(null)}>취소</button><button type="submit" disabled={busy || !validOrderSettings(settingsDraft)}>적용</button></div>
      </form>
    </ModalShell></div>, document.body)}
    {paperSettings && mode === 'paper' && <div className="order-editor" role="group" aria-label="모의 계좌 초기화">
      <label>가상 현금<input aria-label="모의 초기 현금" type="number" min="0" max="1000000000000" step="1" value={paperCash} onChange={e => setPaperCash(Number(e.target.value))} />원</label>
      <label>{name} 초기 보유<input aria-label="모의 초기 보유 수량" type="number" min="0" max="1000000000" step="1" value={paperHolding} onChange={e => setPaperHolding(Number(e.target.value))} />주</label>
      <label>평균 매입<input aria-label="모의 초기 평균 매입가" type="number" min="1" max="1000000000" step="1" value={paperAverage} onChange={e => setPaperAverage(Number(e.target.value))} />원</label>
      <label><input type="checkbox" checked={paperConfirmed} onChange={e => confirmPaperReset(e.target.checked)} />모든 종목의 모의 주문·보유 내역을 지우고 초기화합니다</label>
      <button type="button" disabled={busy || !paperConfirmed || !Number.isSafeInteger(paperCash) || paperCash < 0 || paperCash > 1_000_000_000_000 || !Number.isSafeInteger(paperHolding) || paperHolding < 0 || paperHolding > 1_000_000_000 || !Number.isSafeInteger(paperAverage) || paperAverage < 1 || paperAverage > 1_000_000_000} onClick={() => void resetPaper()}>모의 계좌 초기화</button>
      <button type="button" disabled={busy} onClick={() => showPaperSettings(false)}>닫기</button>
    </div>}
    {!accounts.data?.configured && !accounts.isLoading && <p className="order-notice">토스증권 Open API의 CLIENT_ID·CLIENT_SECRET을 서버에 설정하면 계좌가 연결됩니다.</p>}
    {(accounts.error || state.error) && <p role="alert" className="order-notice text-error">{String((accounts.error ?? state.error) instanceof Error ? (accounts.error ?? state.error as Error)?.message : '계좌 조회 실패')}</p>}
    {!!state.data?.unresolved_commands.length && <div className="order-editor"><span role="alert" className="text-error">결과가 불명확한 요청이 있습니다.</span>
      <label><input type="checkbox" checked={reviewedUnknown} onChange={e => reviewUnknown(e.target.checked)} />토스 앱·WTS에서 실제 주문·체결 여부를 확인했습니다</label>
      {state.data.unresolved_commands.map(id => <button type="button" key={id} disabled={!reviewedUnknown || busy} onClick={() => void reviewCommand(id)}>요청 {id.slice(0, 8)} 확인 완료</button>)}
    </div>}
    <div className="order-scroll" role="region" aria-label="실시간 호가 주문 사다리">
      <div className={`order-ladder ${dragCancel ? 'order-cancel-active' : ''}`} ref={ladder}
        onContextMenu={e => { e.preventDefault(); e.stopPropagation(); if (!drag.current && !action && !settingsDraft) setContextMenu({ x: e.clientX, y: e.clientY }); }}
        onPointerLeave={() => setPreviewPrice(null)}
        onBlurCapture={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setPreviewPrice(null); }}>
        {prices.length === 0 ? <p className="order-notice">실시간 호가 없음</p> : prices.map((level, index) => {
          const key = `${index < 10 ? 'ask' : 'bid'}-${level.price}-${index}`;
          const pct = baseline && level.price > 0 ? (level.price / baseline - 1) * 100 : null;
          return <div className={`order-row ${index === 10 ? 'order-divider' : ''} ${dragTarget === level.price ? 'order-target' : ''}`} data-order-price={level.price} key={key}
            onPointerEnter={() => setPreviewPrice(level.price > 0 ? level.price : null)}
            onFocusCapture={() => setPreviewPrice(level.price > 0 ? level.price : null)}>
            {orderCell('SELL', level.price, key)}
            {index < 10 ? <div className="order-depth order-ask" style={{ '--order-depth': level.qty / maxQty } as React.CSSProperties}><span>{fmt(level.qty)}</span></div>
              : <div className="order-info"><span className={index === 10 ? 'order-meta' : undefined}>{index === 10 ? '체결강도' : fmt(trades[index - 11]?.price)}</span><span>{index === 10 ? summary.fillStrengthPct == null ? '—' : `${fmt(summary.fillStrengthPct)}%` : fmt(trades[index - 11]?.qty)}</span></div>}
            <div className={`order-price ${quote?.price === level.price ? 'order-current' : ''} ${pct == null || pct === 0 ? '' : pct > 0 ? 'text-price-up' : 'text-price-down'}`}><span>{level.price > 0 ? fmt(level.price) : '—'}</span><small>{pct == null ? '—' : `${pct > 0 ? '+' : ''}${pct.toFixed(2)}%`}</small></div>
            {index < 10 ? <div className="order-summary-slot" />
              : <div className="order-depth order-bid" style={{ '--order-depth': level.qty / maxQty } as React.CSSProperties}><span>{fmt(level.qty)}</span></div>}
            {orderCell('BUY', level.price, key)}
          </div>;
        })}
        {expanded && <div className="order-summary-layer">{renderSummary(240)}</div>}
      </div>
      {outside.length > 0 && <div className="order-outside">{outside.map(o => <div key={o.orderId} className={o.side === 'BUY' ? 'order-buy' : 'order-sell'}>
        {orderChip(o, `호가 밖 ${orderSideLabel(o.side)} ${fmt(o.price)}원 주문`, `${orderSideLabel(o.side)} ${fmt(o.price)}원 · ${fmt(orderRemainder(o))}주`)}
      </div>)}</div>}
    </div>
    {book && <TotalQtyStrip totals={{ ask: book.tot_ask, bid: book.tot_bid }} maskRatio={book.tot_ask + book.tot_bid === 0}
      afterHoursTotals={null} afterHoursLabel="시간외" sessionControl={{ kind: 'none' }} sessionMode="regular" />}
    {contextMenu && <PanelContextMenu point={contextMenu} label="주문 취소" onClose={closeMenu}>
      {([{ label: '매수 모두 취소', side: 'BUY' }, { label: '매도 모두 취소', side: 'SELL' }, { label: '전체 주문 취소', side: null }] as const).map(item =>
        <button key={item.label} type="button" role="menuitem" className="block w-full px-3 py-1.5 text-left text-sm hover:bg-bg-input-hover disabled:opacity-50"
          disabled={!ready || !orders.some(order => (item.side == null || order.side === item.side) && editableOrder(order) && !pending(order))}
          onClick={() => request({ type: 'bulk', base: base(), side: item.side, price: 0, quantity: null })}>{item.label}</button>)}
    </PanelContextMenu>}
    {action && highValue && createPortal(<div className="order-settings-surface font-data"><ModalShell ariaLabel="고액 주문 확인" title="고액 주문 확인" width="w-[360px]" onClose={closeAction}>
      <div className="order-editor" role="group" aria-label="고액 주문 확인">
        <span>{orderSideLabel(action.side!)} {fmt(actionQty)}주 · {fmt(action.price * actionQty)}원</span>
        <label><input type="checkbox" checked={confirmedHigh} onChange={e => confirmHigh(e.target.checked)} />1억원 이상 주문 금액을 확인했습니다</label>
        <button type="button" disabled={busy || !confirmedHigh || (action.type === 'modify' && !!currentOrder && (!editableOrder(currentOrder) || pending(currentOrder)))}
          onClick={() => void submit(action, true)}>확인 후 주문</button>
        <button type="button" disabled={busy} onClick={closeAction}>닫기</button>
      </div>
    </ModalShell></div>, document.body)}
    {notice && (() => {
      const card = <ToastCard visible variant="error" role="alert" ariaLabel="주문 알림">
        <div className="flex items-start justify-between gap-2"><span>{notice}</span>
          <button type="button" aria-label="주문 알림 닫기" onClick={() => setNotice(null)}>닫기</button></div>
        {failedRequest && <button type="button" disabled={busy} onClick={() => void submit(failedRequest.action, failedRequest.high)}>같은 요청 다시 확인</button>}
      </ToastCard>;
      const host = toastHost.current;
      return host ? createPortal(card, host) : createPortal(<ToastViewport>{card}</ToastViewport>, document.body);
    })()}
  </div>;
}
