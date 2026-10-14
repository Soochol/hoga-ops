import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { nanoid } from 'nanoid';
import { createPortal } from 'react-dom';
import { ToastCard } from '../../ui/toast/ToastCard';
import { ToastViewport } from '../../ui/toast/ToastViewport';
import { ModalShell } from '../../ui/ModalShell';
import { PanelContextMenu } from '../../ui/PanelContextMenu';
import { useTextTooltip } from '../../ui/useTextTooltip';
import { priceDirClass } from '../../ui/priceDir';
import { useOrderbookDeltaBadges } from '../../sidebar/orderbookDeltaBadges';
import { useAnchoredPopover } from '../../util/useAnchoredPopover';
import { MAX_AMOUNT_MILLIONS, MAX_ORDER_QUANTITY, normalizeOrderSettings,
  quantityForAmount, validOrderInput, validOrderSettings, type OrderWindowSettings, type OrderPresets } from '../../state/orderWindowSettings';
import {
  tradingCommand, useTradingAccounts, useTradingState,
  type TossOrder, type TradingSide, type TradingCommand, type TradingCommandResponse,
  type CreateTradingOrder, type ModifyTradingOrder, type CancelTradingOrders, type TradingCancelResponse,
  type ReviewTradingCommand, type TradingReviewResponse,
} from '../../api/trading';
import { useLiveSeries } from '../../api/liveSeries';
import { acceptTradingReplacement, pauseTradingRefresh } from '../../api/tradingRefresh';
import { useQuoteByCode } from '../../api/liveQuotes';
import { useLiveStockLimits } from '../../api/liveStockLimits';
import { useLiveKrxClose } from '../../api/liveKrxClose';
import { useLiveViStatus } from '../../api/liveViStatus';
import { useLiveVenueStore } from '../../state/liveVenue';
import type { OrderbookSnapshot } from '../../api/types';
import { useWallClockSecond } from '../../util/useWallClockSecond';
import { fillTradeSummaryFromQuote, latestOrderbookSnapshot, latestTradeSummary } from '../liveSidebarAdapters';
import { editableOrder, groupPriceOrders, HIGH_VALUE_WON, holdingProfitPercent, holdingProfitWon, holdingPurchaseAmountWon, orderRemainder, orderSideLabel } from './orderRules';
import { previousDayObExpired, realMsToYyyymmdd } from '../liveDateTime';
import { BookDayMarker, BookQtyDelta, BookSummary, ExpectedFillBanner, TotalQtyStrip } from './BookPanel';
import { recentBookTrades, resolveBookBaseline } from './bookDisplay';
import { useBookSessionDisplay } from './useBookSessionDisplay';
import { AccountTradingPanel, type AccountListTab } from './AccountTradingPanel';
import { OrderSurfaceHeading } from './OrderSurface';
import './OrderWindow.css';

const fmt = (n: number | string | null | undefined) => n == null ? '—' : Number(n).toLocaleString('ko-KR');
const EMPTY_ORDERS: TossOrder[] = [];
const mode = 'live' as const;
type Action = {
  type: 'create' | 'modify' | 'cancel' | 'bulk' | 'group';
  base: TradingCommand;
  side: TradingSide | null;
  price: number;
  quantity: number | null;
  order?: TossOrder;
  operation?: 'modify' | 'cancel';
  batch?: { order: TossOrder; base: TradingCommand }[];
};
const changesPrice = (action: Action) => action.type === 'create' || action.type === 'modify' || (action.type === 'group' && action.operation === 'modify');
type Drag = { orders: TossOrder[]; list: HTMLElement | null; x: number; y: number; cursorX: number; cursorY: number; active: boolean; price: number | null; cancel: boolean; pointer: number; element: HTMLElement };

function OrderToastPortal({ children }: { children: ReactNode }) {
  const [host] = useState(() => document.getElementById('toast-viewport'));
  const content = <div className="order-toast">{children}</div>;
  return createPortal(host ? content : <ToastViewport>{content}</ToastViewport>, host ?? document.body);
}

export function OrderWindow({ code, settings, onSettingsChange, onSelectSymbol }: {
  code: string; name: string; settings?: OrderWindowSettings; onSettingsChange?: (settings: OrderWindowSettings) => void; onSelectSymbol?: (code: string, name: string) => void;
}) {
  const [selectedAccount, selectAccount] = useState(0);
  const [localSettings, setLocalSettings] = useState(() => normalizeOrderSettings(settings));
  const preferences = settings ?? localSettings;
  const [quantity, setQuantity] = useState(() => preferences.quantityPresets[0]);
  const [amountMillions, setAmountMillions] = useState(() => preferences.amountPresets[0]);
  const [profitAsPercent, setProfitAsPercent] = useState(false);
  function applySettings(next: OrderWindowSettings) {
    const quantitySlot = preferences.quantityPresets.indexOf(quantity);
    const amountSlot = preferences.amountPresets.indexOf(amountMillions);
    if (quantitySlot >= 0) setQuantity(next.quantityPresets[quantitySlot]);
    if (amountSlot >= 0) setAmountMillions(next.amountPresets[amountSlot]);
    setLocalSettings(next); onSettingsChange?.(next);
  }
  return <OrderWindowContent key={code} code={code}
    preferences={preferences} quantity={quantity} onQuantityChange={setQuantity} amountMillions={amountMillions}
    onAmountChange={setAmountMillions} onApplySettings={applySettings}
    profitAsPercent={profitAsPercent} onToggleProfitDisplay={() => setProfitAsPercent(value => !value)}
    chosenAccount={selectedAccount} onAccountChange={selectAccount} onSelectSymbol={onSelectSymbol} />;
}

function OrderWindowContent({ code, chosenAccount, onAccountChange, onSelectSymbol,
  preferences, quantity, onQuantityChange, amountMillions, onAmountChange, onApplySettings, profitAsPercent, onToggleProfitDisplay }: {
  code: string;
  chosenAccount: number; onAccountChange: (account: number) => void; preferences: OrderWindowSettings;
  quantity: number; onQuantityChange: (quantity: number) => void; amountMillions: number; onAmountChange: (millions: number) => void;
  onApplySettings: (settings: OrderWindowSettings) => void; onSelectSymbol?: (code: string, name: string) => void;
  profitAsPercent: boolean; onToggleProfitDisplay: () => void;
}) {
  const client = useQueryClient();
  const accounts = useTradingAccounts(mode);
  const account = chosenAccount || accounts.data?.accounts[0]?.account_seq || 0;
  const state = useTradingState(account, code, mode);
  // Display follows the 10-level book's venue; broker orders remain SOR.
  const venue = useLiveVenueStore(s => s.venue);
  const live = useLiveSeries(code, venue);
  const quote = useQuoteByCode([code], venue).get(code);
  const limits = useLiveStockLimits(code);
  const now = useWallClockSecond();
  const todayKst = realMsToYyyymmdd(now);
  const krxClose = useLiveKrxClose(code, todayKst);
  const latestSnapshot = useMemo(() => {
    const snap = latestOrderbookSnapshot(live.latestOb ? [live.latestOb] : live.ob);
    return snap !== null && previousDayObExpired(snap.ts_ms, now, venue) ? null : snap;
  }, [live.latestOb, live.ob, now, venue]);
  const lastValidSnapshot = useMemo(() => latestOrderbookSnapshot(live.lastValidOb ? [live.lastValidOb] : []), [live.lastValidOb]);
  const preAuctionSnapshot = useMemo(() => latestOrderbookSnapshot(live.preAuctionOb ? [live.preAuctionOb] : []), [live.preAuctionOb]);
  const { snapshot, storedLadder, activeSinglePrice, singlePriceFills, afterHoursBook, effectiveVenue,
    afterHoursTotals, afterHoursLabel, sessionControl, sessionMode, selectSessionMode } = useBookSessionDisplay({
    code, venue, nowMs: now, todayKst, isSpot: false, regularSnapshot: latestSnapshot,
    latestSnapshot, lastValidSnapshot, preAuctionSnapshot, afterHours: live.afterHours,
  });
  const vi = useLiveViStatus(code, effectiveVenue);
  const summary = useMemo(() => fillTradeSummaryFromQuote(latestTradeSummary(live.trade), quote), [live.trade, quote]);
  const [lockedBook, lockBook] = useState<OrderbookSnapshot | null>(null);
  const book = lockedBook ?? snapshot;
  const deltaBadges = useOrderbookDeltaBadges(live.ob, !lockedBook && !storedLadder);
  const [settingsDraft, setSettingsDraft] = useState<OrderWindowSettings | null>(null);
  const [previewPrice, setPreviewPrice] = useState<number | null>(null);
  const [action, setAction] = useState<Action | null>(null);
  const [confirmedHigh, confirmHigh] = useState(false);
  const [reviewedUnknown, reviewUnknown] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; side?: TradingSide; price?: number } | null>(null);
  const closeMenu = useCallback(() => setContextMenu(null), []);
  const [notice, setNotice] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<{ text: string; sending: boolean } | null>(null);
  useEffect(() => {
    if (!receipt || receipt.sending) return;
    const timer = window.setTimeout(() => setReceipt(null), 4_000);
    return () => window.clearTimeout(timer);
  }, [receipt]);
  const [failedRequest, setFailedRequest] = useState<{ action: Action; high: boolean } | null>(null);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 8_000);
    return () => window.clearTimeout(timer);
  }, [notice]);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [pendingIds, setPending] = useState<Record<string, string>>({});
  const [accountTab, setAccountTab] = useState<AccountListTab | null>(null);
  const accountAnchor = useRef<HTMLDivElement>(null);
  const closeAccountPanel = useCallback(() => setAccountTab(null), []);
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
      const usableWidth = width - (scroll ? scroll.offsetWidth - scroll.clientWidth : 0);
      setExpanded(usableWidth >= 560);
      setSpacious(usableWidth >= 696);
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
  const [draggingOrders, setDraggingOrders] = useState<TossOrder[]>([]);
  const draggingOrderId = draggingOrders[0]?.orderId ?? null;
  const drag = useRef<Drag | null>(null);
  const dragPreview = useRef<HTMLDivElement>(null);
  // Cursor motion updates only the floating preview, not the live order ladder.
  const positionDragPreview = useCallback(() => {
    const node = dragPreview.current, current = drag.current;
    if (!node || !current) return;
    const x = Math.max(8, Math.min(current.cursorX + 12, window.innerWidth - node.offsetWidth - 8));
    const y = Math.max(8, Math.min(current.cursorY + 12, window.innerHeight - node.offsetHeight - 8));
    node.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  }, []);
  useLayoutEffect(positionDragPreview, [positionDragPreview, draggingOrderId, dragTarget, dragCancel]);
  const suppressClick = useRef(false);
  const suppressDoubleClick = useRef(false);
  const ladder = useRef<HTMLDivElement>(null);
  const resetDrag = useCallback(() => {
    const current = drag.current;
    drag.current = null;
    if (current?.element.hasPointerCapture(current.pointer)) current.element.releasePointerCapture(current.pointer);
    suppressClick.current = current?.active ?? false;
    if (current?.active) suppressDoubleClick.current = true;
    lockBook(null); setDragTarget(null); setDragCancel(false); setDraggingOrders([]);
  }, []);
  const displayKey = `${venue}:${effectiveVenue}:${sessionMode}:${activeSinglePrice !== null}`;
  const previousDisplayKey = useRef(displayKey);
  useLayoutEffect(() => {
    if (previousDisplayKey.current === displayKey) return;
    previousDisplayKey.current = displayKey;
    resetDrag(); suppressClick.current = false;
    setPreviewPrice(null); setAction(null); confirmHigh(false); closeMenu();
  }, [displayKey, resetDrag, closeMenu]);
  const orders = state.data?.orders ?? EMPTY_ORDERS;
  const draggedOrder = draggingOrders[0] ?? null;
  const latestOrders = useRef(orders);
  useLayoutEffect(() => { latestOrders.current = orders; }, [orders]);
  const groups = useMemo(() => groupPriceOrders(orders), [orders]);
  // Legacy single-price books are display-only; these commands are LIMIT/DAY.
  const fresh = !storedLadder && activeSinglePrice === null && !!snapshot && now - snapshot.ts_ms >= -5_000 && now - snapshot.ts_ms < 30_000;
  const ready = account > 0 && !!state.data && !state.isError && !busy;
  const asks = book?.ask.filter(level => Number.isFinite(level.price) && level.price > 0).reverse() ?? [];
  const bids = book?.bid.filter(level => Number.isFinite(level.price) && level.price > 0) ?? [];
  const prices = asks.concat(bids);
  const showInlineSummary = expanded && asks.length >= 10;
  const onScreen = new Set(prices.map(l => l.price));
  const outside = orders.filter(o => o.price == null || !onScreen.has(Number(o.price)));
  const maxQty = Math.max(1, ...prices.map(l => l.qty));
  const displayTotals = afterHoursTotals ?? { ask: book?.tot_ask ?? 0, bid: book?.tot_bid ?? 0 };
  const baseline = resolveBookBaseline({ isPastDateLadder: false, ladderBaseline: null,
    singlePriceActive: activeSinglePrice !== null, singlePriceClose: afterHoursBook.data?.close_price ?? null,
    liveBaseline: quote?.change_pct_source === 'unavailable' ? null : (quote?.baseline_price ?? null) });
  const estimatePrice = previewPrice ?? quote?.price ?? null;
  const amountMode = preferences.unit === 'amount';
  const inputValue = amountMode ? amountMillions : quantity;
  const presets = amountMode ? preferences.amountPresets : preferences.quantityPresets;
  const setInputValue = amountMode ? onAmountChange : onQuantityChange;
  const estimateQuantity = amountMode && estimatePrice != null ? quantityForAmount(amountMillions, estimatePrice) : null;
  const estimateAmount = estimatePrice != null && estimatePrice > 0 && Number.isSafeInteger(quantity) && quantity > 0
    && Number.isSafeInteger(estimatePrice * quantity) ? estimatePrice * quantity : null;
  const holdingQuantity = state.data?.holding_quantity != null && !state.balancesError ? Number(state.data.holding_quantity) : null;
  const canFillHoldingQuantity = holdingQuantity != null && validOrderInput(holdingQuantity, 'quantity');
  const buyingPower = state.data?.buying_power != null && !state.balancesError ? Number(state.data.buying_power) : null;
  const holdingProfit = holdingProfitWon(holdingQuantity, quote?.price ?? null, state.data?.average_purchase_price);
  const profitPercent = holdingProfitPercent(holdingQuantity, quote?.price ?? null, state.data?.average_purchase_price);
  const canToggleProfit = holdingQuantity != null && holdingQuantity > 0 && holdingProfit != null && profitPercent != null;
  const profitAmountText = holdingQuantity === 0 || holdingProfit == null ? '—' : fmt(holdingProfit);
  const profitPercentText = holdingProfit == null || profitPercent == null ? '—' : `${profitPercent.toFixed(2)}%`;
  const profitText = profitAsPercent ? profitPercentText : profitAmountText;
  const purchaseAmount = holdingPurchaseAmountWon(holdingQuantity, state.data?.average_purchase_price);
  const purchaseText = purchaseAmount == null ? '' : `매수금액 ${fmt(purchaseAmount)}원`;
  const quantityTip = useTextTooltip(purchaseText, 500, 'order-tooltip');
  const averageTip = useTextTooltip(purchaseText, 500, 'order-tooltip');
  useEffect(() => {
    quantityTip.hide(); averageTip.hide();
  }, [account, quantityTip.hide, averageTip.hide]);
  const currentOrder = action?.order ? orders.find(o => o.orderId === action.order?.orderId) ?? action.order : null;
  const actionQty = action?.quantity ?? (currentOrder ? orderRemainder(currentOrder) : 0);
  const highValue = !!action && changesPrice(action) && action.price * actionQty >= HIGH_VALUE_WON;

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
    if (changesPrice(next) && !fresh) { setNotice('실시간 호가가 오래되었습니다. 갱신 후 주문하세요.'); return; }
    busyRef.current = true; setBusy(true); setNotice(null); setFailedRequest(null);
    const resumeRefresh = pauseTradingRefresh(client, mode, account);
    const label = next.type === 'create' ? '주문' : (next.operation ?? next.type) === 'modify' ? '정정' : '취소';
    setReceipt({ text: `${label} 요청 중`, sending: true });
    let retryAction = next;
    let accepted = true;
    try {
      if (next.type === 'group') {
        const failed: NonNullable<Action['batch']> = [];
        const messages: string[] = [];
        for (const item of next.batch ?? []) {
          try {
            const body = next.operation === 'modify' ? { ...item.base, price: next.price, quantity: null, confirm_high_value: high } : item.base;
            const response = await tradingCommand<TradingCommandResponse>(`/orders/${encodeURIComponent(item.order.orderId)}/${next.operation}`, body, mode);
            if (next.operation === 'modify') acceptTradingReplacement(client, mode, account, code, item.order.orderId, response.order_id);
            setPending(prev => ({ ...prev, [item.order.orderId]: response.order_id }));
          } catch (error) {
            failed.push(item);
            messages.push(error instanceof Error ? error.message : '처리 결과 확인 필요');
          }
        }
        if (failed.length) {
          retryAction = { ...next, batch: failed };
          throw new Error(`${next.operation === 'cancel' ? '취소' : '정정'} 미접수 ${failed.length}건 · ${messages.join(' · ')}`);
        }
      } else if (next.type === 'bulk') {
        const body: CancelTradingOrders = { ...next.base, side: next.side };
        const result = await tradingCommand<TradingCancelResponse>('/cancel-all', body, mode);
        const rejected = result.results.filter(r => !r.accepted);
        accepted = rejected.length === 0;
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
          if (next.type === 'modify') acceptTradingReplacement(client, mode, account, code, next.order!.orderId, response.order_id);
          setPending(prev => ({ ...prev, [next.order!.orderId]: response.order_id }));
        }
      }
      closeAction();
      setReceipt(accepted ? { text: `${label} 요청 접수됨`, sending: false } : null);
    } catch (error) {
      setReceipt(null);
      setNotice(error instanceof Error ? error.message : '주문 처리 결과를 확인하세요.');
      if (next.type === 'group') closeAction();
      // A failure never opens the removed new-order editor. Retry retains its ID.
      setFailedRequest({ action: retryAction, high });
    } finally {
      busyRef.current = false; setBusy(false);
      resumeRefresh();
    }
  }

  function request(next: Action) {
    closeMenu(); confirmHigh(false);
    const qty = next.quantity ?? (next.order ? orderRemainder(next.order) : 0);
    const high = changesPrice(next) && next.price * qty >= HIGH_VALUE_WON;
    setFailedRequest(null); setNotice(null);
    if (high) setAction(next);
    else { closeAction(); void submit(next); }
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
  function create(side: TradingSide, price: number) {
    if (!validOrderInput(inputValue, preferences.unit)) { setNotice(amountMode ? '주문 금액은 1백만원 이상의 정수로 설정하세요.' : '주문 수량은 1주 이상의 정수로 설정하세요.'); return; }
    const qty = amountMode ? quantityForAmount(amountMillions, price) : quantity;
    if (qty === 0) { setNotice('입력한 금액으로 해당 호가에서 1주를 주문할 수 없습니다.'); return; }
    if (qty == null) { setNotice('주문 금액과 호가 가격을 확인하세요.'); return; }
    if (!Number.isSafeInteger(qty) || qty < 1 || qty > 1_000_000_000) { setNotice('주문 수량은 1주 이상의 정수로 설정하세요.'); return; }
    if (orders.some(o => o.side !== side)) { setNotice('반대 방향 미체결 주문을 먼저 취소하거나 체결 후 주문하세요.'); return; }
    request({ type: 'create', base: base(), side, price, quantity: qty });
  }

  function beginDrag(e: PointerEvent<HTMLElement>, candidates: TossOrder[], list = false) {
    const targets = candidates.filter(order => editableOrder(order) && !pending(order) && orderRemainder(order) > 0);
    if (e.button !== 0 || !targets.length || !ready) return;
    e.stopPropagation();
    drag.current = { orders: targets, list: list ? e.currentTarget.closest('[data-order-list]') : null, x: e.clientX, y: e.clientY, cursorX: e.clientX, cursorY: e.clientY, active: false, price: null, cancel: false, pointer: e.pointerId, element: e.currentTarget };
    lockBook(snapshot ?? null); e.currentTarget.setPointerCapture(e.pointerId);
  }
  function moveDrag(e: PointerEvent<HTMLElement>) {
    const d = drag.current;
    if (!d || d.pointer !== e.pointerId) return;
    if (!d.active && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 6) return;
    if (!d.active) { d.active = true; setDraggingOrders(d.orders); }
    d.cursorX = e.clientX; d.cursorY = e.clientY;
    positionDragPreview();
    if (d.list) {
      const bounds = d.list.getBoundingClientRect();
      if (e.clientX >= bounds.left && e.clientX <= bounds.right && e.clientY >= bounds.top && e.clientY <= bounds.bottom) {
        d.cancel = false; d.price = null;
        setDragTarget(null); setDragCancel(false);
        return;
      }
    }
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
    d.price = !d.cancel && row && ladder.current?.contains(row) && (!lane || lane.dataset.orderSide === d.orders[0].side) ? Number(row.dataset.orderPrice) : null;
    setDragTarget(d.price); setDragCancel(d.cancel);
  }
  function endDrag(e?: PointerEvent<HTMLElement>, aborted = false) {
    if (e && !aborted) moveDrag(e);
    const d = drag.current;
    if (!d || (e && e.pointerId !== d.pointer)) return;
    resetDrag();
    if (aborted || !d.active) return;
    const targets = d.orders.flatMap(original => {
      const order = latestOrders.current.find(o => o.orderId === original.orderId);
      return order && order.side === original.side && order.price === original.price && editableOrder(order) && !pending(order) && orderRemainder(order) > 0 ? [order] : [];
    });
    if (!targets.length) { setNotice('드래그 중 주문 상태가 변경되었습니다. 최신 내역을 확인하세요.'); return; }
    const operation = d.cancel ? 'cancel' : d.price && d.price !== Number(targets[0].price) ? 'modify' : null;
    if (!operation) return;
    const price = operation === 'cancel' ? 0 : d.price!;
    if (targets.length === 1) request({ type: operation, base: base(), side: targets[0].side, price, quantity: null, order: targets[0] });
    else request({ type: 'group', operation, base: base(), side: targets[0].side, price,
      quantity: targets.reduce((sum, order) => sum + orderRemainder(order), 0), batch: targets.map(order => ({ order, base: base() })) });
  }

  function orderChip(order: TossOrder, label: string, content?: string) {
    const blocked = !editableOrder(order) || pending(order);
    return <button key={order.orderId} className={`order-chip ${order.orderId === draggingOrderId ? 'order-chip-dragging' : ''}`} type="button"
      aria-label={label} title={`${orderSideLabel(order.side)} ${fmt(order.price)}원 · 잔여 ${fmt(orderRemainder(order))}주`}
      disabled={!ready || blocked} data-drag-order={!blocked ? order.orderId : undefined}
      onPointerDown={e => beginDrag(e, [order])} onPointerMove={moveDrag} onPointerUp={endDrag}
      onPointerCancel={() => endDrag(undefined, true)} onLostPointerCapture={() => endDrag(undefined, true)}>
      {content ?? fmt(orderRemainder(order))}{blocked ? ' · 처리 중' : ''}
    </button>;
  }
  function orderCell(side: TradingSide, price: number, rowKey: string) {
    const group = groups.get(`${side}:${price}`) ?? [];
    const opposite = orders.some(o => o.side !== side);
    const destination = draggedOrder?.side === side && dragTarget === price && price > 0;
    const canCreate = ready && fresh && price > 0 && !opposite && !settingsDraft && !state.data?.unresolved_commands.length
      && (!amountMode || (quantityForAmount(amountMillions, price) ?? 0) >= 1);
    const canDrag = ready && group.some(order => editableOrder(order) && !pending(order));
    return <button type="button" className={`order-lane ${side === 'BUY' ? 'order-buy' : 'order-sell'} ${destination ? 'order-drag-destination' : ''}`}
      data-order-side={side} aria-label={`${orderSideLabel(side)} ${fmt(price)}원 주문 추가 ${rowKey}`}
      title={`${orderSideLabel(side)} 주문 · 더블클릭으로 추가${group.length ? ' · 드래그로 정정·취소' : ''}`}
      disabled={!canCreate && !canDrag}
      onDoubleClick={() => { if (canCreate && !suppressClick.current) create(side, price); }}
      onPointerDown={e => beginDrag(e, group)}
      onContextMenu={e => {
        if (!group.length) return;
        e.preventDefault(); e.stopPropagation();
        if (!drag.current && !action && !settingsDraft) setContextMenu({ x: e.clientX, y: e.clientY, side, price });
      }}
      onPointerMove={moveDrag} onPointerUp={endDrag}
      onPointerCancel={() => endDrag(undefined, true)} onLostPointerCapture={() => endDrag(undefined, true)}>
      {group.length > 0 && <span className={`order-quantity ${!canDrag ? 'order-quantity-blocked' : ''} ${draggingOrders.some(order => group.some(item => item.orderId === order.orderId)) ? 'order-chip-dragging' : ''}`}
        aria-label={`${orderSideLabel(side)} ${fmt(price)}원 주문${group.length > 1 ? ' 합계' : ''}`}
        data-drag-order={group.some(order => editableOrder(order) && !pending(order)) ? group.map(order => order.orderId).join(',') : undefined}>
        {fmt(group.reduce((sum, order) => sum + orderRemainder(order), 0))}{group.some(order => !editableOrder(order) || pending(order)) ? ' · 처리 중' : ''}
      </span>}
    </button>;
  }

  const recentTrades = useMemo(() => recentBookTrades(live.trade, 9), [live.trade]);
  const trades = activeSinglePrice !== null ? singlePriceFills.slice(0, 9) : recentTrades;
  const lastPrice = activeSinglePrice !== null ? (afterHoursBook.data?.cur_price ?? null) : (recentTrades[0]?.price ?? null);
  const renderSummary = (height: number) => <BookSummary summary={summary} baselinePrice={baseline ?? null}
    limits={limits.data} krxClose={krxClose.data?.date === todayKst ? krxClose.data.price : null}
    vi={vi.data?.vi} height={height} />;
  return <div ref={rootRef} className={`order-window font-data ${compact ? 'order-compact' : ''} ${expanded ? 'order-expanded' : ''} ${spacious ? 'order-spacious' : ''} ${draggingOrderId ? 'order-dragging' : ''} ${dragCancel ? 'order-drag-canceling' : ''}`} data-testid="order-window" onPointerDownCapture={() => { suppressClick.current = false; }}
    onClickCapture={e => {
      if (suppressClick.current) { e.preventDefault(); e.stopPropagation(); suppressClick.current = false; }
      else if (e.detail === 1) suppressDoubleClick.current = false;
    }}
    onDoubleClickCapture={e => {
      if (suppressDoubleClick.current) { e.preventDefault(); e.stopPropagation(); suppressDoubleClick.current = false; }
    }}
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
      <div className="order-account-group" ref={accountAnchor}>
      {accounts.data && accounts.data.accounts.length > 1 ? <select aria-label="주문 계좌" value={account} disabled={busy || !!lockedBook}
        onChange={e => { onAccountChange(Number(e.target.value)); closeAction(); setPending({}); setFailedRequest(null); setNotice(null); }}>
        {accounts.data.accounts.map(a => <option key={a.account_seq} value={a.account_seq}>{a.label}</option>)}
      </select> : <span className="order-account-label text-fg-dim" title={accounts.data?.accounts[0]?.label}>{accounts.data?.accounts[0]?.label ?? '계좌 연결 대기'}</span>}
      {(['orders', 'holdings'] as const).map(tab => <button key={tab} type="button" aria-haspopup="dialog" aria-expanded={accountTab === tab}
        disabled={!account || !!lockedBook || busy} onClick={() => { closeAction(); setAccountTab(accountTab === tab ? null : tab); }}>
        {tab === 'orders' ? '미체결 주문' : '보유종목'}
      </button>)}
      </div>
      <div className="order-settings-group">
      <button type="button" aria-label="주문 설정" disabled={busy || !!lockedBook} onClick={() => { closeAction(); setSettingsDraft(normalizeOrderSettings(preferences)); }}>설정</button>
      {!showInlineSummary && <button ref={infoButtonRef} type="button" aria-label="종목 상세 정보" aria-haspopup="dialog" aria-expanded={infoOpen} aria-controls={infoOpen ? infoId : undefined}
        disabled={!!lockedBook} onClick={() => setInfoOpen(open => !open)}>정보</button>}
      </div>
    </div>
    <AccountTradingPanel key={account} account={account} accountLabel={accounts.data?.accounts.find(item => item.account_seq === account)?.label ?? '계좌 연결 대기'}
      tab={accountTab} anchorRef={accountAnchor} onTabChange={setAccountTab} onClose={closeAccountPanel} onSelectSymbol={onSelectSymbol} />
    <div className="order-controls order-overview-controls">
      <span className="order-buying-power" aria-label="매수 가능 금액"><span className="order-meta">매수 가능</span><span className="order-field-value">{buyingPower != null && Number.isSafeInteger(buyingPower) && buyingPower >= 0 ? `${fmt(buyingPower)}원` : '—'}</span></span>
      <div className="order-holdings-summary" role="group" aria-label="보유 종목 정보">
        <button type="button" className="order-field order-holding-quantity" aria-label="매입수량" aria-describedby={quantityTip.id}
          disabled={!canFillHoldingQuantity} onClick={() => {
            if (!canFillHoldingQuantity || holdingQuantity == null) return;
            if (amountMode) onApplySettings({ ...preferences, unit: 'quantity' });
            onQuantityChange(holdingQuantity);
            quantityTip.hide();
          }}
          onMouseEnter={e => quantityTip.show(e.currentTarget)} onMouseLeave={quantityTip.hide}
          onFocus={e => quantityTip.show(e.currentTarget)} onBlur={quantityTip.hide}
          onKeyDown={e => { if (e.key === 'Escape') quantityTip.hide(); }}>
          <span className="order-meta" aria-hidden="true">보유</span><span className="order-field-value">{holdingQuantity != null && Number.isSafeInteger(holdingQuantity) && holdingQuantity >= 0 ? fmt(holdingQuantity) : '—'}</span>
        </button>
        <span className="order-field" aria-label="매입평단가" aria-describedby={averageTip.id} tabIndex={purchaseAmount == null ? undefined : 0}
          onMouseEnter={e => averageTip.show(e.currentTarget)} onMouseLeave={averageTip.hide}
          onFocus={e => averageTip.show(e.currentTarget)} onBlur={averageTip.hide}
          onKeyDown={e => { if (e.key === 'Escape') averageTip.hide(); }}>
          <span className="order-meta" aria-hidden="true">평단가</span><span className="order-field-value">{holdingQuantity != null && holdingQuantity > 0 && state.data?.average_purchase_price != null ? fmt(Math.ceil(Number(state.data.average_purchase_price))) : '—'}</span>
        </span>
        <span className="order-field" aria-label="보유 종목 평가 수익"><span className="order-meta" aria-hidden="true">평가손익</span>
          <button type="button" className="order-profit-toggle" aria-label="평가손익 표시 전환" aria-pressed={profitAsPercent}
            data-profit-amount={profitAmountText} data-profit-percent={profitPercentText}
            title={`더블클릭하여 ${profitAsPercent ? '금액' : '수익률(%)'}으로 전환`} disabled={!canToggleProfit}
            onDoubleClick={onToggleProfitDisplay} onKeyDown={event => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                if (!event.repeat && canToggleProfit) onToggleProfitDisplay();
              }
            }}>
            <span className={`order-field-value ${holdingProfit != null && holdingProfit > 0 ? 'text-price-up' : holdingProfit != null && holdingProfit < 0 ? 'text-price-down' : 'text-fg'}`}>{profitText}</span>
          </button>
        </span>
      </div>
    </div>
    <div className="order-controls order-quantity-controls">
      <div className="order-input-controls" role="group" aria-label="공통 주문 수량">
        <div className="order-input-mode order-surface-segment" role="group" aria-label="주문 입력 방식">
          {(['amount', 'quantity'] as const).map(unit => <button key={unit} type="button" aria-pressed={preferences.unit === unit} disabled={busy || !!lockedBook}
            onClick={() => { closeAction(); onApplySettings({ ...preferences, unit }); }}>{unit === 'amount' ? '금액' : '수량'}</button>)}
        </div>
        <label className="order-input-field"><input type="number" aria-label={amountMode ? '신규 주문 금액' : '신규 주문 수량'} min="1" max={amountMode ? MAX_AMOUNT_MILLIONS : MAX_ORDER_QUANTITY} step="1" value={inputValue} onChange={e => setInputValue(Number(e.target.value))} /><span className="order-meta">{amountMode ? '백만원' : '주'}</span></label>
        <div className="order-quantity-presets">
          {presets.map((value, index) => <button type="button" key={index} aria-pressed={inputValue === value} onClick={() => setInputValue(value)}>{fmt(amountMode ? value * 100 : value)}{amountMode ? '만' : '주'}</button>)}
        </div>
        <span className="order-field order-estimate" aria-label={amountMode ? '예상 주문 수량' : '예상 주문 금액'} title={estimatePrice != null ? `${fmt(estimatePrice)}원 기준` : undefined}>
          <span className="order-meta" aria-hidden="true">{amountMode ? '예상' : '금액'}</span>
          <span className="order-field-value">{amountMode ? estimateQuantity == null ? '—' : `${fmt(estimateQuantity)}주` : estimateAmount == null ? '—' : `${fmt(estimateAmount)}원`}
          </span>
        </span>
      </div>
    </div>
    {infoOpen && createPortal(<div ref={infoRef} id={infoId} role="dialog" aria-label="종목 상세 정보" className="order-info-popover order-surface font-data" style={infoStyle}>
      <OrderSurfaceHeading closeLabel="종목 정보 닫기" onClose={closeInfo}>종목 정보</OrderSurfaceHeading>
      <div className="order-info-body">{renderSummary(264)}</div>
    </div>, document.body)}
    {quantityTip.tooltip}
    {averageTip.tooltip}
    {draggedOrder && createPortal(<div ref={dragPreview} role="status" aria-label="주문 드래그 미리보기"
      className={`order-drag-preview font-data ${draggedOrder.side === 'BUY' ? 'order-buy' : 'order-sell'} ${dragCancel ? 'order-drag-preview-cancel' : ''}`}>
      {fmt(draggingOrders.reduce((sum, order) => sum + orderRemainder(order), 0))}
    </div>, document.body)}
    {settingsDraft && createPortal(<div className="order-settings-surface font-data" onKeyDown={e => {
      e.stopPropagation(); if (e.key === 'Escape') { e.preventDefault(); setSettingsDraft(null); }
    }}><ModalShell ariaLabel="주문 설정" width="w-[360px]" onClose={() => setSettingsDraft(null)}>
      <div className="order-modal order-settings-modal"><OrderSurfaceHeading closeLabel="주문 설정 닫기" onClose={() => setSettingsDraft(null)}>주문 설정</OrderSurfaceHeading>
      <form onSubmit={e => { e.preventDefault(); if (!busy && validOrderSettings(settingsDraft)) { onApplySettings(settingsDraft); setSettingsDraft(null); } }}>
        <div className="order-settings-body">
          {(['quantity', 'amount'] as const).map(unit => <fieldset key={unit}><legend>{unit === 'quantity' ? '수량 프리셋' : '금액 프리셋'}</legend>
            <div className="order-settings-presets">{(unit === 'quantity' ? settingsDraft.quantityPresets : settingsDraft.amountPresets).map((value, index) => <label key={index}>
              <input type="number" aria-label={`${unit === 'quantity' ? '수량' : '금액'} 프리셋 ${index + 1}`} min="1" max={unit === 'quantity' ? MAX_ORDER_QUANTITY : MAX_AMOUNT_MILLIONS} step="1" value={value}
                onChange={e => { const key = unit === 'quantity' ? 'quantityPresets' : 'amountPresets'; setSettingsDraft({ ...settingsDraft, [key]: settingsDraft[key].map((n, i) => i === index ? Number(e.target.value) : n) as OrderPresets }); }} />
              <span className="order-preset-unit" aria-hidden="true">{unit === 'quantity' ? '주' : '백만원'}</span>
            </label>)}</div>
          </fieldset>)}
          {!validOrderSettings(settingsDraft) && <p role="alert" className="text-error">프리셋은 허용 범위의 양의 정수로 입력하세요</p>}
        </div>
        <div className="order-surface-footer"><button type="button" onClick={() => setSettingsDraft(null)}>취소</button><button type="submit" className="order-primary" disabled={busy || !validOrderSettings(settingsDraft)}>적용</button></div>
      </form>
      </div>
    </ModalShell></div>, document.body)}
    {!accounts.data?.configured && !accounts.isLoading && <p className="order-notice">토스증권 Open API의 CLIENT_ID·CLIENT_SECRET을 서버에 설정하면 계좌가 연결됩니다.</p>}
    {(accounts.error || state.error) && <p role="alert" className="order-notice text-error">{String((accounts.error ?? state.error) instanceof Error ? (accounts.error ?? state.error as Error)?.message : '계좌 조회 실패')}</p>}
    {!!state.data?.unresolved_commands.length && <div className="order-editor"><span role="alert" className="text-error">결과가 불명확한 요청이 있습니다.</span>
      <label><input type="checkbox" checked={reviewedUnknown} onChange={e => reviewUnknown(e.target.checked)} />토스 앱·WTS에서 실제 주문·체결 여부를 확인했습니다</label>
      {state.data.unresolved_commands.map(id => <button type="button" key={id} disabled={!reviewedUnknown || busy} onClick={() => void reviewCommand(id)}>요청 {id.slice(0, 8)} 확인 완료</button>)}
    </div>}
    <ExpectedFillBanner price={book?.exp_price ?? 0} qty={book?.exp_qty ?? 0} baselinePrice={baseline} />
    <div className="order-scroll" role="region" aria-label="실시간 호가 주문 사다리">
      <div className={`order-ladder ${dragCancel ? 'order-cancel-active' : ''}`} ref={ladder}
        onContextMenu={e => { e.preventDefault(); e.stopPropagation(); if (!drag.current && !action && !settingsDraft) setContextMenu({ x: e.clientX, y: e.clientY }); }}
        onPointerLeave={() => setPreviewPrice(null)}
        onBlurCapture={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setPreviewPrice(null); }}>
        {prices.length === 0 ? <p className="order-notice">실시간 호가 없음</p> : prices.map((level, index) => {
          const isAsk = index < asks.length;
          const bidIndex = index - asks.length;
          const firstBid = bidIndex === 0;
          const key = `${isAsk ? 'ask' : 'bid'}-${level.price}-${index}`;
          const pct = baseline && level.price > 0 ? (level.price / baseline - 1) * 100 : null;
          const trade = bidIndex > 0 ? trades[bidIndex - 1] : undefined;
          const tradePriceColor = trade && baseline != null && baseline > 0 ? priceDirClass(trade.price - baseline) : 'text-fg-dim';
          return <div className={`order-row ${firstBid ? 'order-divider' : ''} ${dragTarget === level.price ? 'order-target' : ''}`} data-order-price={level.price} key={key}
            onPointerEnter={() => setPreviewPrice(level.price > 0 ? level.price : null)}
            onFocusCapture={() => setPreviewPrice(level.price > 0 ? level.price : null)}>
            {orderCell('SELL', level.price, key)}
            {isAsk ? <div className="order-depth order-ask" style={{ '--order-depth': level.qty / maxQty } as React.CSSProperties}><span className="order-depth-values"><BookQtyDelta badge={deltaBadges?.get(`a:${level.price}`) ?? null} /><span className="order-depth-qty">{fmt(level.qty)}</span></span></div>
              : <div className="order-info"><span className={firstBid ? 'order-meta' : tradePriceColor}>{firstBid ? '체결강도' : fmt(trade?.price)}</span><span className={trade ? priceDirClass(trade.side) : undefined}>{firstBid ? summary.fillStrengthPct == null ? '—' : `${fmt(summary.fillStrengthPct)}%` : fmt(trade?.qty)}</span></div>}
            <div className={`order-price ${lastPrice === level.price ? 'order-current' : ''} ${pct == null || pct === 0 ? '' : pct > 0 ? 'text-price-up' : 'text-price-down'}`}><span className="order-price-value"><BookDayMarker price={level.price} summary={summary} />{level.price > 0 ? fmt(level.price) : '—'}</span><small>{pct == null ? '—' : `${pct > 0 ? '+' : ''}${pct.toFixed(2)}%`}</small></div>
            {isAsk ? <div className="order-summary-slot" />
              : <div className="order-depth order-bid" style={{ '--order-depth': level.qty / maxQty } as React.CSSProperties}><span className="order-depth-values"><BookQtyDelta badge={deltaBadges?.get(`b:${level.price}`) ?? null} /><span className="order-depth-qty">{fmt(level.qty)}</span></span></div>}
            {orderCell('BUY', level.price, key)}
          </div>;
        })}
        {trades.slice(Math.max(0, bids.length - 1)).map((trade, index) => <div className="order-row" key={`trade-${index}`}>
          <div /><div className="order-info"><span className={baseline != null && baseline > 0 ? priceDirClass(trade.price - baseline) : 'text-fg-dim'}>{fmt(trade.price)}</span><span className={priceDirClass(trade.side)}>{fmt(trade.qty)}</span></div>
        </div>)}
        {showInlineSummary && <div className="order-summary-layer">{renderSummary(240)}</div>}
      </div>
      {outside.length > 0 && <div className="order-outside">{outside.map(o => <div key={o.orderId} className={o.side === 'BUY' ? 'order-buy' : 'order-sell'}>
        {orderChip(o, `호가 밖 ${orderSideLabel(o.side)} ${fmt(o.price)}원 주문`, `${orderSideLabel(o.side)} ${fmt(o.price)}원 · ${fmt(orderRemainder(o))}`)}
      </div>)}</div>}
    </div>
    {(book || afterHoursTotals || sessionControl.kind !== 'none') && <TotalQtyStrip totals={displayTotals} maskRatio={displayTotals.ask + displayTotals.bid === 0}
      afterHoursTotals={afterHoursTotals} afterHoursLabel={afterHoursLabel} sessionControl={sessionControl} sessionMode={sessionMode}
      onSelectSessionMode={selectSessionMode} />}
    {contextMenu?.side && contextMenu.price != null ? <PanelContextMenu point={contextMenu}
      label={`${orderSideLabel(contextMenu.side)} ${fmt(contextMenu.price)}원 주문 목록`} showLabel={false} onClose={closeMenu} className="order-surface order-context-surface">
      <OrderSurfaceHeading closeLabel="가격별 주문 목록 닫기" onClose={closeMenu}><span className={contextMenu.side === 'BUY' ? 'text-price-up' : 'text-price-down'}>{orderSideLabel(contextMenu.side)}</span> · {fmt(contextMenu.price)}원</OrderSurfaceHeading>
      <div data-order-list className="order-list font-data">
        <div className="order-list-summary"><span>{groups.get(`${contextMenu.side}:${contextMenu.price}`)?.length ?? 0}건</span><span>총 {fmt((groups.get(`${contextMenu.side}:${contextMenu.price}`) ?? []).reduce((sum, order) => sum + orderRemainder(order), 0))}</span></div>
        {(groups.get(`${contextMenu.side}:${contextMenu.price}`) ?? []).map((order, index) =>
          <button key={order.orderId} type="button" role="menuitem"
            className={`order-list-item ${order.side === 'BUY' ? 'order-buy' : 'order-sell'} ${draggingOrderId === order.orderId ? 'order-chip-dragging' : ''}`}
            aria-label={`주문 ${index + 1} · ${fmt(orderRemainder(order))}주`}
            disabled={!ready || !editableOrder(order) || pending(order)}
            onPointerDown={e => beginDrag(e, [order], true)} onPointerMove={moveDrag} onPointerUp={endDrag}
            onPointerCancel={() => endDrag(undefined, true)} onLostPointerCapture={() => endDrag(undefined, true)}>
            <span>주문 {index + 1}</span><strong>{fmt(orderRemainder(order))}</strong>
          </button>)}
        {!(groups.get(`${contextMenu.side}:${contextMenu.price}`)?.length) && <p className="order-list-hint">미체결 주문 없음</p>}
        <p className="order-list-hint">개별 주문을 밖으로 드래그하면 해당 주문 취소</p>
      </div>
    </PanelContextMenu> : contextMenu && <PanelContextMenu point={contextMenu} label="주문 취소" showLabel={false} onClose={closeMenu} className="order-surface order-context-surface">
      <OrderSurfaceHeading closeLabel="주문 취소 메뉴 닫기" onClose={closeMenu}>주문 취소</OrderSurfaceHeading>
      {([{ label: '매수 모두 취소', side: 'BUY' }, { label: '매도 모두 취소', side: 'SELL' }, { label: '전체 주문 취소', side: null }] as const).map(item =>
        <button key={item.label} type="button" role="menuitem" aria-label={item.label} className="order-cancel-menu-item"
          disabled={!ready || !orders.some(order => (item.side == null || order.side === item.side) && editableOrder(order) && !pending(order))}
          onClick={() => request({ type: 'bulk', base: base(), side: item.side, price: 0, quantity: null })}><span>{item.label}</span><span className="order-meta">{orders.filter(order => (item.side == null || order.side === item.side) && editableOrder(order) && !pending(order)).length}건</span></button>)}
    </PanelContextMenu>}
    {action && highValue && createPortal(<div className="order-settings-surface font-data"><ModalShell ariaLabel="고액 주문 확인" width="w-[360px]" onClose={closeAction}>
      <div className="order-modal"><OrderSurfaceHeading closeLabel="고액 주문 확인 닫기" onClose={closeAction}>고액 주문 확인</OrderSurfaceHeading>
      <div className="order-confirm-body" role="group" aria-label="고액 주문 확인">
        <div className="order-confirm-row"><span className={action.side === 'BUY' ? 'text-price-up' : 'text-price-down'}>{orderSideLabel(action.side!)}</span><span>{fmt(actionQty)}주</span></div>
        <div className="order-confirm-row"><span className="order-meta">주문 가격</span><span>{fmt(action.price)}원</span></div>
        <div className="order-confirm-row"><span className="order-meta">주문 금액</span><strong>{fmt(action.price * actionQty)}원</strong></div>
        <label><input type="checkbox" checked={confirmedHigh} onChange={e => confirmHigh(e.target.checked)} />1억원 이상 주문 금액을 확인했습니다</label>
      </div>
      <div className="order-surface-footer">
        <button type="button" disabled={busy} onClick={closeAction}>취소</button>
        <button type="button" className="order-primary" disabled={busy || !confirmedHigh || (action.type === 'modify' && !!currentOrder && (!editableOrder(currentOrder) || pending(currentOrder)))}
          onClick={() => void submit(action, true)}>확인 후 주문</button>
      </div>
      </div>
    </ModalShell></div>, document.body)}
    {(notice || receipt) && <OrderToastPortal>{notice ? <ToastCard visible variant="error" role="alert" ariaLabel="주문 알림">
        <div className="flex items-start justify-between gap-2"><span>{notice}</span>
          <button type="button" aria-label="주문 알림 닫기" onClick={() => setNotice(null)}>닫기</button></div>
        {failedRequest && <button type="button" disabled={busy} onClick={() => void submit(failedRequest.action, failedRequest.high)}>같은 요청 다시 확인</button>}
      </ToastCard> : <ToastCard visible variant={receipt?.sending ? 'neutral' : 'success'} role="status" ariaLabel="주문 접수 알림">
        {receipt?.text}
      </ToastCard>}</OrderToastPortal>}
  </div>;
}
