import type { TradingAccountId } from '../../api/trading';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useSymbols } from '../../capture/useSymbols';
import { nanoid } from 'nanoid';
import { createPortal } from 'react-dom';
import { ModalShell } from '../../ui/ModalShell';
import { PanelContextMenu } from '../../ui/PanelContextMenu';
import { GripIcon } from '../../ui/RailActionIcons';
import { useTextTooltip } from '../../ui/useTextTooltip';
import { TextTooltip } from '../../ui/TextTooltip';
import { BookAmountTooltip, BookPriceAmount } from './BookPriceAmount';
import { useBookPriceLayout } from './useBookPriceLayout';
import { useOrderColumnLayout } from './useOrderColumnLayout';
import { priceDirClass } from '../../ui/priceDir';
import { useOrderbookDeltaBadges } from '../../sidebar/orderbookDeltaBadges';
import { useAnchoredPopover } from '../../util/useAnchoredPopover';
import { MAX_ORDER_QUANTITY, normalizeOrderSettings,
  quantityForAmount, validOrderInput, type OrderWindowSettings } from '../../state/orderWindowSettings';
import {
  tradingCommand, useTradingAccounts, useTradingState,
  type TossOrder, type TradingSide, type TradingCommand, type TradingCommandResponse,
  type CreateTradingOrder, type ModifyTradingOrder, type CancelTradingOrders, type TradingCancelResponse,
  type ReviewTradingCommand, type TradingReviewResponse,
} from '../../api/trading';
import { useLiveSeries } from '../../api/liveSeries';
import { useLiveRestOrderbook } from '../../api/liveRestOrderbook';
import { hasBookPrices } from '../../api/livePreAuctionBook';
import { acceptTradingReplacement, pauseTradingRefresh } from '../../api/tradingRefresh';
import { useQuoteByCode } from '../../api/liveQuotes';
import { useLiveStockLimits } from '../../api/liveStockLimits';
import { usePreopenClose } from '../../api/preopenClose';
import { useLiveKrxClose } from '../../api/liveKrxClose';
import { useLiveKrxPreviousClose } from '../../api/liveKrxPreviousClose';
import { useLiveViStatus } from '../../api/liveViStatus';
import { useLiveVenueStore } from '../../state/liveVenue';
import { useWallClockSecond } from '../../util/useWallClockSecond';
import { unixMsToKSTHhmm } from '../../util/time';
import { fillTradeSummaryFromQuote, latestOrderbookSnapshot, latestTradeSummary } from '../liveSidebarAdapters';
import { editableOrder, groupPriceOrders, HIGH_VALUE_WON, holdingBookMarker, holdingProfitPercent, holdingProfitWon, holdingPurchaseAmountWon, orderRemainder, orderSideLabel } from './orderRules';
import { realMsToYyyymmdd, regularSessionOpenMs } from '../liveDateTime';
import { BookDayMarker, BookQtyDelta, BookSummary, TotalQtyStrip } from './BookPanel';
import { resolveBookBaseline } from './bookDisplay';
import { useRecentBookTrades } from './useRecentBookTrades';
import { tradeHighlightBackground, useTradeHighlight } from '../tradeHighlight';
import { bookDayMarkers } from './bookDayMarkers';
import { useBookSessionDisplay } from './useBookSessionDisplay';
import { useOrderbookAvailability } from '../useOrderbookAvailability';
import { BookAvailabilityState } from './BookAvailabilityState';
import { RestOrderbookEmpty, RestOrderbookSource } from './RestOrderbookState';
import { AccountTradingPanel, type AccountListTab } from './AccountTradingPanel';
import { OrderSurfaceHeading } from './OrderSurface';
import { OrderSettingsForm } from './OrderSettingsForm';
import { WindowHeaderAction } from './WindowHeaderAction';
import { WindowSettingsPopover } from './WindowSettingsPopover';
import { useOrderQuantity } from './useOrderQuantity';
import { orderPriceRange } from './orderPriceRange';
import { useOrderPriceExplorer } from './useOrderPriceExplorer';
import { newOrderIssue, orderFailure, type OrderNotice } from './orderFeedback';
import { OrderStatusBar, type OrderReceipt } from './OrderStatusBar';
import { notifyOrderReceiptAccepted, prepareOrderReceiptSound, subscribeOrderReceiptSoundRecovery } from './orderReceiptSound';
import { useOrderFillSound } from './useOrderFillSound';
import './OrderWindow.css';

const fmt = (n: number | string | null | undefined) => n == null ? '—' : Number(n).toLocaleString('ko-KR');
const accountDisplayLabel = (label?: string) => label?.replace(' · 실전 ·', ' ·') ?? '계좌 연결 대기';
const EMPTY_ORDERS: TossOrder[] = [];
const UNRESOLVED_NOTICE: OrderNotice = {
  title: '주문 결과 확인 필요', message: '결과가 불명확한 요청이 있습니다. 해당 증권사의 주문·체결 내역을 확인하세요.',
  tone: 'error', persistent: true,
};
const mode = 'live' as const;
const MAX_CONCURRENT_GROUP_CANCELS = 10;
type Action = {
  type: 'create' | 'modify' | 'cancel' | 'bulk' | 'group';
  base: TradingCommand;
  side: TradingSide | null;
  price: number;
  quantity: number | null;
  order?: TossOrder;
  operation?: 'modify' | 'cancel';
  batch?: { order: TossOrder; base: TradingCommand }[];
  keepOrderList?: boolean;
  orderType?: 'LIMIT' | 'PREOPEN_CLOSE';
};
const changesPrice = (action: Action) => action.type === 'create' || action.type === 'modify' || (action.type === 'group' && action.operation === 'modify');
const cancelsOrders = (action: Action) => action.type === 'cancel' || (action.type === 'group' && action.operation === 'cancel');
const orderKey = (account: TradingAccountId, id: string) => JSON.stringify([account, id]);
type CancelFailure = { action: Action; notice: OrderNotice };
type Drag = { orders: TossOrder[]; list: HTMLElement | null; x: number; y: number; cursorX: number; cursorY: number; active: boolean; price: number | null; cancel: boolean; pointer: number; element: HTMLElement };

export function OrderWindow({ code, name, settings, onSettingsChange, onSelectSymbol, selectedAccountId, onResolvedAccount, onOpenExecutions }: {
  selectedAccountId?: TradingAccountId; onResolvedAccount?: (account: TradingAccountId) => void; onOpenExecutions?: (account: TradingAccountId) => void;
  code: string; name: string; settings?: OrderWindowSettings; onSettingsChange?: (settings: OrderWindowSettings) => void; onSelectSymbol?: (code: string, name: string) => void;
}) {
  const [selectedAccount, selectAccount] = useState<TradingAccountId | null>(selectedAccountId ?? null);
  const [localSettings, setLocalSettings] = useState(() => normalizeOrderSettings(settings));
  const preferences = settings ?? localSettings;
  const accounts = useTradingAccounts(mode);
  const account = selectedAccount ?? accounts.data?.accounts[0]?.account_seq ?? 0;
  useEffect(() => { if (account) onResolvedAccount?.(account); }, [account, onResolvedAccount]);
  if (selectedAccount === null && accounts.data?.accounts.length) selectAccount(accounts.data.accounts[0].account_seq);
  useEffect(() => {
    if (preferences.orderReceiptSound || preferences.buyFillSound || preferences.sellFillSound) return subscribeOrderReceiptSoundRecovery();
  }, [preferences.orderReceiptSound, preferences.buyFillSound, preferences.sellFillSound]);
  const [quantity, setQuantity] = useOrderQuantity(code, account, preferences.rememberQuantity, preferences.quantityPresets[0]);
  const [profitAsPercent, setProfitAsPercent] = useState(false);
  function applySettings(next: OrderWindowSettings) {
    const quantitySlot = quantity == null ? -1 : preferences.quantityPresets.indexOf(quantity);
    if (quantitySlot >= 0) setQuantity(next.quantityPresets[quantitySlot]);
    setLocalSettings(next); onSettingsChange?.(next);
  }
  return <OrderWindowContent key={code} code={code} name={name}
    preferences={preferences} quantity={quantity} onQuantityChange={setQuantity} onApplySettings={applySettings}
    profitAsPercent={profitAsPercent} onToggleProfitDisplay={() => setProfitAsPercent(value => !value)}
    accounts={accounts} account={account} onAccountChange={selectAccount} onSelectSymbol={onSelectSymbol} onOpenExecutions={onOpenExecutions} />;
}

function OrderWindowContent({ code, name, accounts, account, onAccountChange, onSelectSymbol, onOpenExecutions,
  preferences, quantity, onQuantityChange, onApplySettings, profitAsPercent, onToggleProfitDisplay }: {
  code: string; name: string;
  accounts: ReturnType<typeof useTradingAccounts>; account: TradingAccountId; onAccountChange: (account: TradingAccountId) => void; preferences: OrderWindowSettings;
  quantity: number | null; onQuantityChange: (quantity: number | null) => void;
  onApplySettings: (settings: OrderWindowSettings) => void; onSelectSymbol?: (code: string, name: string) => void;
  onOpenExecutions?: (account: TradingAccountId) => void;
  profitAsPercent: boolean; onToggleProfitDisplay: () => void;
}) {
  const client = useQueryClient();
  const state = useTradingState(account, code, mode);
  useOrderFillSound(account, code, state.data, preferences.buyFillSound, preferences.sellFillSound);
  const activeAccount = accounts.data?.accounts.find(item => item.account_seq === account);
  const [chosenRoute, chooseRoute] = useState<'SOR' | 'KRX' | 'NXT'>('SOR');
  const routes = activeAccount?.routes;
  const orderRoute = routes?.includes(chosenRoute) ? chosenRoute : routes?.[0] ?? 'SOR';
  // Display venue and the account's explicit order route are independent.
  const venue = useLiveVenueStore(s => s.venue);
  const live = useLiveSeries(code, venue);
  const quote = useQuoteByCode([code], venue).get(code);
  const limits = useLiveStockLimits(code);
  const symbols = useSymbols();
  const now = useWallClockSecond();
  const todayKst = realMsToYyyymmdd(now);
  const morningClock = unixMsToKSTHhmm(now);
  const preopenSubject = symbols.data?.symbols.find(item => item.code === code)?.nxt_enabled === false && venue !== 'NXT';
  const preopen = usePreopenClose(account, code, todayKst, preopenSubject && morningClock >= 800
    && morningClock < 1000 && activeAccount?.broker === 'kiwoom');
  const preopenQuote = preopen.data?.account_ref === account && preopen.data.code === code
    && preopen.data.trading_date === todayKst && now - preopen.data.fetched_at_ms < 30_000
    && now - preopen.data.fetched_at_ms >= -5_000 ? preopen.data : undefined;
  const preopenPrice = preopenQuote?.price ?? null;
  const preopenEnd = preopen.data?.account_ref === account && preopen.data.trading_date === todayKst
    ? preopen.data.ends_at_ms : regularSessionOpenMs(todayKst) - 20 * 60_000;
  const showPreopen = preopenSubject && morningClock >= 800 && now < preopenEnd;
  const preopenEnded = now >= preopenEnd;
  const preopenReason = !activeAccount ? '주문 계좌를 선택하세요.' : activeAccount.broker !== 'kiwoom' ? '토스 OpenAPI는 장전 시간외 종가 주문을 지원하지 않습니다.'
    : preopenEnded ? '장전 종가 거래가 종료되었습니다.' : preopen.error ? preopen.error.message : !preopenQuote ? '장전 종가 주문 조건을 확인하고 있습니다.'
    : !preopenQuote.supported ? preopenQuote.reason ?? '장전 종가 미지원 종목입니다.'
    : now < preopenQuote.starts_at_ms ? `장전 종가는 ${new Date(preopenQuote.starts_at_ms).toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false })}에 시작합니다.`
    : now >= preopenQuote.ends_at_ms ? '장전 종가 거래가 종료되었습니다.'
    : !preopenQuote.can_order ? preopenQuote.reason ?? '장전 종가 주문 조건을 확인하세요.'
    : preopenPrice == null ? '장전 종가 적용 가격을 확인할 수 없습니다.' : null;
  const krxClose = useLiveKrxClose(code, todayKst);
  const krxPreviousClose = useLiveKrxPreviousClose(code, todayKst);
  const latestSnapshot = useMemo(() => latestOrderbookSnapshot(live.latestOb ? [live.latestOb] : live.ob),
    [live.latestOb, live.ob]);
  const lastValidSnapshot = useMemo(() => latestOrderbookSnapshot(live.lastValidOb ? [live.lastValidOb] : []), [live.lastValidOb]);
  const preAuctionSnapshot = useMemo(() => latestOrderbookSnapshot(live.preAuctionOb ? [live.preAuctionOb] : []), [live.preAuctionOb]);
  const { snapshot, storedLadder, activeSinglePrice, singlePriceFills, afterHoursBook, effectiveVenue, aftermarketExclusion,
    allowRestBook, morningReset, afterHoursTotals, afterHoursLabel, sessionControl, sessionMode, selectSessionMode } = useBookSessionDisplay({
    code, venue, nowMs: now, todayKst, isSpot: false, regularSnapshot: latestSnapshot,
    latestSnapshot, lastValidSnapshot, preAuctionSnapshot, afterHours: live.afterHours,
  });
  const vi = useLiveViStatus(code, effectiveVenue);
  const needsRestBook = allowRestBook && !hasBookPrices(snapshot) && activeSinglePrice === null
    && !(sessionControl.kind === 'toggle' && sessionMode === 'afterHours');
  const rest = useLiveRestOrderbook(code, effectiveVenue, needsRestBook && !live.isLoading);
  const loadingLastBook = live.isLoading || rest.isLoading;
  // A dated WS ladder always wins. REST clocks have no date and can never
  // establish order freshness, even when the HTTP request just succeeded.
  const restBook = needsRestBook && rest.data?.code === code && rest.data.venue === effectiveVenue
    ? rest.data.book : null;
  const { availability: bookAvailability, retry: retryBook } = useOrderbookAvailability({ code, venue: effectiveVenue,
    live, bookMs: snapshot?.ts_ms, nowMs: now, exclusion: aftermarketExclusion,
    enabled: (!storedLadder || snapshot == null) && activeSinglePrice === null && afterHoursTotals === null
      && !(sessionControl.kind === 'toggle' && sessionMode === 'afterHours') });
  const summary = useMemo(() => fillTradeSummaryFromQuote(latestTradeSummary(live.trade), quote), [live.trade, quote]);
  const [dragInProgress, setDragInProgress] = useState(false);
  const book = restBook ?? snapshot;
  const deltaBadges = useOrderbookDeltaBadges(live.ob, !storedLadder && !restBook);
  const [settingsDraft, setSettingsDraft] = useState<OrderWindowSettings | null>(null);
  const closeSettings = useCallback(() => {
    setSettingsDraft(null);
  }, []);
  const [action, setAction] = useState<Action | null>(null);
  const [confirmedHigh, confirmHigh] = useState(false);
  const [reviewedUnknown, reviewUnknown] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; side?: TradingSide; price?: number; preopen?: boolean } | null>(null);
  const closeMenu = useCallback(() => setContextMenu(null), []);
  const [noticeState, setNoticeState] = useState<(OrderNotice & { account: TradingAccountId }) | null>(null);
  const [cancelFailures, setCancelFailures] = useState<CancelFailure[]>([]);
  const cancelFailure = cancelFailures.find(item => item.action.base.account_seq === account);
  const notice = cancelFailure?.notice ?? (noticeState?.account === account ? noticeState : null);
  const [receipt, setReceipt] = useState<OrderReceipt | null>(null);
  function setNotice(value: string | OrderNotice | null) {
    if (value) setReceipt(null);
    setNoticeState(value == null ? null : {
      ...(typeof value === 'string' ? { title: '주문 확인 필요', message: value, tone: 'warn' as const } : value), account,
    });
  }
  const [failedRequest, setFailedRequest] = useState<{ action: Action; high: boolean } | null>(null);
  const [exclusiveBusy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const cancellingRef = useRef(new Set<string>());
  const [cancelling, setCancelling] = useState<ReadonlySet<string>>(() => new Set());
  const busy = exclusiveBusy || cancelling.size > 0;
  const [pendingIds, setPending] = useState<Record<string, string>>({});
  const [accountTab, setAccountTab] = useState<AccountListTab | null>(null);
  const accountAnchor = useRef<HTMLDivElement>(null);
  const closeAccountPanel = useCallback(() => setAccountTab(null), []);
  const rootRef = useRef<HTMLDivElement>(null);
  const priceViewportRef = useRef<HTMLDivElement>(null);
  const infoButtonRef = useRef<HTMLButtonElement>(null);
  const [compact, setCompact] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [spacious, setSpacious] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [infoPage, setInfoPage] = useState<0 | 1>(0);
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
      // Internal scrollbars depend on these layouts. Basing the breakpoint on
      // their client width can toggle the summary and scrollbars every frame.
      setExpanded(width >= 560);
      setSpacious(width >= 696);
      if (width !== previousWidth) setInfoOpen(false);
      previousWidth = width;
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
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
    setDragInProgress(false); setDragTarget(null); setDragCancel(false); setDraggingOrders([]);
  }, []);
  const displayKey = `${venue}:${effectiveVenue}:${sessionMode}:${activeSinglePrice !== null}:${account}`;
  const previousDisplayKey = useRef(displayKey);
  useLayoutEffect(() => {
    if (previousDisplayKey.current === displayKey) return;
    previousDisplayKey.current = displayKey;
    resetDrag(); suppressClick.current = false;
    setAction(null); confirmHigh(false); closeMenu();
  }, [displayKey, resetDrag, closeMenu]);
  const allOrders = state.data?.orders ?? EMPTY_ORDERS;
  const orders = useMemo(() => allOrders.filter(order => order.orderType !== 'PREOPEN_CLOSE'), [allOrders]);
  const draggedOrder = draggingOrders[0] ?? null;
  const latestOrders = useRef(orders);
  useLayoutEffect(() => { latestOrders.current = orders; }, [orders]);
  const groups = useMemo(() => groupPriceOrders(orders), [orders]);
  const sideOrders = useMemo(() => {
    const active = orders.filter(order => order.symbol === code && orderRemainder(order) > 0);
    return { SELL: active.filter(order => order.side === 'SELL'), BUY: active.filter(order => order.side === 'BUY') };
  }, [orders, code]);
  const contextOrders = contextMenu?.side
    ? contextMenu.preopen ? allOrders.filter(order => order.orderType === 'PREOPEN_CLOSE' && order.side === contextMenu.side)
    : contextMenu.price == null ? sideOrders[contextMenu.side] : groups.get(`${contextMenu.side}:${contextMenu.price}`) ?? EMPTY_ORDERS
    : EMPTY_ORDERS;
  // Legacy single-price books are display-only; these commands are LIMIT/DAY.
  const fresh = !restBook && !storedLadder && activeSinglePrice === null && !!snapshot && now - snapshot.ts_ms >= -5_000 && now - snapshot.ts_ms < 30_000;
  const ready = !!account && !!activeAccount && !!state.data && !state.isError && !exclusiveBusy && activeAccount.order_enabled !== false;
  const availability = {
    accountsLoading: accounts.isLoading, configured: accounts.data?.configured === true, account,
    accountError: accounts.error ?? (!accounts.data?.accounts.length && Object.keys(accounts.data?.errors ?? {}).length
      ? new Error(Object.values(accounts.data?.errors ?? {}).join(' / ')) : null),
    stateReady: !!state.data && !state.isError, stateError: state.error,
    unresolved: !!state.data?.unresolved_commands.length || cancelFailures.some(item => item.action.base.account_seq === account && item.notice.persistent), settingsOpen: !!settingsDraft,
    locked: dragInProgress, stored: !!restBook || (storedLadder && snapshot != null), singlePrice: activeSinglePrice !== null,
    hasBook: !!book, fresh, quantity,
    bookIssue: bookAvailability ? { title: '주문 대기', message: bookAvailability.message, tone: 'warn' as const } : undefined,
    brokerBlocked: account && !activeAccount ? '선택 계좌의 연결을 확인하세요.'
      : activeAccount?.order_enabled === false ? activeAccount.blocked_reason ?? '이 계좌의 주문 경로를 확인하세요.' : null,
  };
  const creationIssue = newOrderIssue(availability);
  const preopenAvailability = { ...availability, fixedPrice: true,
    fixedPriceIssue: preopenReason ? { title: '장전 종가 주문 불가', message: preopenReason, tone: 'neutral' as const } : null };
  const preopenCreationIssue = newOrderIssue(preopenAvailability);
  const asks = book?.ask.filter(level => Number.isFinite(level.price) && level.price > 0).reverse() ?? [];
  const bids = book?.bid.filter(level => Number.isFinite(level.price) && level.price > 0) ?? [];
  const masterSymbol = symbols.data?.symbols.find(symbol => symbol.code === code);
  const securityType = masterSymbol?.security_type ?? 'stock';
  const currentLimits = limits.data?.code === code && realMsToYyyymmdd(limits.data.fetched_at_ms) === todayKst;
  const lowerLimit = currentLimits ? limits.data?.lower_limit : null;
  const upperLimit = currentLimits ? limits.data?.upper_limit : null;
  const hasMasterSymbol = masterSymbol != null;
  const fullRange = useMemo(() => activeSinglePrice === null && hasMasterSymbol ? orderPriceRange(lowerLimit, upperLimit, securityType) : null,
    [lowerLimit, upperLimit, securityType, activeSinglePrice, hasMasterSymbol]);
  const currentPrice = quote?.price ?? null;
  const explorerPrice = currentPrice ?? bids[0]?.price ?? asks.at(-1)?.price ?? null;
  const explorer = useOrderPriceExplorer(`${displayKey}:${todayKst}:${morningReset}`, fullRange, explorerPrice, busy || dragInProgress || !!settingsDraft || !!action, priceViewportRef);
  const prices = explorer.enabled ? explorer.prices.map(price => ({ price, qty: 0 })) : asks.concat(bids);
  const dayMarkers = bookDayMarkers(prices.map(level => level.price), summary);
  const showInlineSummary = !explorer.enabled && (expanded || prices.length === 0);
  const onScreen = new Set(prices.map(l => l.price));
  const maxQty = Math.max(1, ...asks.concat(bids).map(l => l.qty));
  const displayTotals = (restBook ? null : afterHoursTotals) ?? { ask: book?.tot_ask ?? 0, bid: book?.tot_bid ?? 0 };
  const baseline = resolveBookBaseline({ isPastDateLadder: false, ladderBaseline: null,
    singlePriceActive: activeSinglePrice !== null, singlePriceClose: afterHoursBook.data?.close_price ?? null,
    liveBaseline: quote?.change_pct_source === 'unavailable' ? null : (quote?.baseline_price ?? null) });
  const priceLayout = useBookPriceLayout(explorer.enabled && fullRange
    ? [...prices, { price: fullRange.priceAt(0) }, { price: fullRange.priceAt(fullRange.count - 1) }] : prices, code, true, baseline, preferences.showPriceChangePercent);
  const estimatePrice = showPreopen && preopenPrice != null ? preopenPrice : quote?.price ?? null;
  const amountPresets = preferences.unit === 'amount';
  const presets = amountPresets ? preferences.amountPresets : preferences.quantityPresets;
  const canConvertAmount = estimatePrice != null && Number.isSafeInteger(estimatePrice) && estimatePrice > 0;
  function applyPreset(value: number) {
    if (!amountPresets) { onQuantityChange(value); setNotice(null); return; }
    const converted = canConvertAmount ? quantityForAmount(value, estimatePrice) : null;
    if (converted == null || converted > MAX_ORDER_QUANTITY) {
      setNotice('현재가와 금액을 확인한 후 수량을 환산하세요.'); return;
    }
    onQuantityChange(converted);
    setNotice(converted === 0 ? '입력한 금액으로 현재가에서 1주를 주문할 수 없습니다.' : null);
  }
  const estimateAmount = quantity != null && estimatePrice != null && estimatePrice > 0 && Number.isSafeInteger(quantity) && quantity > 0
    && Number.isSafeInteger(estimatePrice * quantity) ? estimatePrice * quantity : null;
  const holdingQuantity = state.data?.holding_quantity?.trim() && !state.balancesError ? Number(state.data.holding_quantity) : null;
  const hasHolding = holdingQuantity != null && Number.isSafeInteger(holdingQuantity) && holdingQuantity > 0;
  const averagePrice = Number(state.data?.average_purchase_price);
  const averagePriceDisplay = hasHolding && Number.isFinite(averagePrice) && averagePrice > 0
    ? fmt(Math.ceil(averagePrice)) : '';
  const averageMarker = preferences.showAveragePrice
    ? holdingBookMarker(holdingQuantity, state.data?.average_purchase_price, onScreen) : { price: null, outside: false };
  const averageMarkerIndex = prices.findIndex(level => level.price === averageMarker.price);
  const [averageWhole, averageFraction] = (state.data?.average_purchase_price ?? '').split('.');
  const averagePriceText = averageWhole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (averageFraction ? `.${averageFraction}` : '');
  const averageMarkerLabel = averageMarker.price == null ? '' : `내 평단가 ${averagePriceText}원${
    Number(averageWhole) === averageMarker.price && (!averageFraction || /^0+$/.test(averageFraction)) ? '' : ` · 가장 가까운 호가 ${fmt(averageMarker.price)}원`}`;
  // The server's sellable quantity already excludes outstanding sell orders.
  const sellableQuantity = state.data?.sellable_quantity?.trim() && !state.balancesError ? Number(state.data.sellable_quantity) : null;
  // Zero is a known balance and can clear the input; submitting an order still requires >= 1.
  const canFillHoldingQuantity = holdingQuantity != null && Number.isSafeInteger(holdingQuantity)
    && holdingQuantity >= 0 && holdingQuantity <= MAX_ORDER_QUANTITY
    && sellableQuantity != null && Number.isSafeInteger(sellableQuantity)
    && sellableQuantity >= 0 && sellableQuantity <= holdingQuantity;
  const buyingPower = state.data?.buying_power != null && state.data.buying_power.trim() !== '' && !state.balancesError ? Number(state.data.buying_power) : null;
  const holdingProfit = holdingProfitWon(holdingQuantity, quote?.price ?? null, state.data?.average_purchase_price);
  const profitPercent = holdingProfitPercent(holdingQuantity, quote?.price ?? null, state.data?.average_purchase_price);
  const canToggleProfit = holdingQuantity != null && holdingQuantity > 0 && holdingProfit != null && profitPercent != null;
  const profitAmountText = !hasHolding || holdingProfit == null ? '' : fmt(holdingProfit);
  const profitPercentText = !hasHolding || holdingProfit == null || profitPercent == null ? '' : `${profitPercent.toFixed(2)}%`;
  const profitText = profitAsPercent ? profitPercentText : profitAmountText;
  const purchaseAmount = holdingPurchaseAmountWon(holdingQuantity, state.data?.average_purchase_price);
  const purchaseText = purchaseAmount == null ? '' : `매수금액 ${fmt(purchaseAmount)}원`;
  const quantityTip = useTextTooltip(purchaseText, 500, 'order-tooltip');
  const averageTip = useTextTooltip(purchaseText, 500, 'order-tooltip');
  const profitTip = useTextTooltip(canToggleProfit ? profitAsPercent ? `${profitAmountText}원` : profitPercentText : '', 500, 'order-tooltip');
  const { hide: hideQuantityTip } = quantityTip;
  const { hide: hideAverageTip } = averageTip;
  const { hide: hideProfitTip } = profitTip;
  useEffect(() => {
    hideQuantityTip(); hideAverageTip(); hideProfitTip();
  }, [account, hideQuantityTip, hideAverageTip, hideProfitTip]);
  const currentOrder = action?.order ? orders.find(o => o.orderId === action.order?.orderId) ?? action.order : null;
  const actionQty = action?.quantity ?? (currentOrder ? orderRemainder(currentOrder) : 0);
  const highValue = !!action && changesPrice(action) && action.price * actionQty >= HIGH_VALUE_WON;

  function base(): TradingCommand { return { account_seq: account, code, command_id: nanoid() }; }
  function resetAction() { setAction(null); confirmHigh(false); }
  function closeAction() { resetAction(); closeMenu(); }
  function awaitingResult(order: TossOrder) {
    const replacement = pendingIds[orderKey(account, order.orderId)];
    // Keep the old order disabled until it leaves OPEN, or a reject is confirmed.
    return !!replacement && !state.data?.recent_orders.some(o => o.orderId === replacement && ['CANCEL_REJECTED', 'REPLACE_REJECTED'].includes(o.status));
  }
  function pending(order: TossOrder) {
    return cancellingRef.current.has(orderKey(account, order.orderId)) || awaitingResult(order)
      || cancelFailures.some(item => item.action.base.account_seq === account && item.action.order?.orderId === order.orderId && item.notice.persistent);
  }
  function recordCancelFailure(next: Action, failure: OrderNotice) {
    const price = next.order?.price;
    const notice = { ...failure, message: `${orderSideLabel(next.side!)} ${price == null ? '시장가' : `${fmt(price)}원`} · ${failure.message}` };
    setCancelFailures(prev => [...prev.filter(item => item.action.base.command_id !== next.base.command_id), { action: next, notice }]);
  }
  function dismissNotice() {
    if (cancelFailure) setCancelFailures(prev => prev.filter(item => item !== cancelFailure));
    else setNotice(null);
  }
  async function submit(next: Action, high = false) {
    if (busyRef.current) return;
    const cancellingOrders = cancelsOrders(next);
    // New orders and cancel-all keep their existing exclusive submission boundary.
    if (!cancellingOrders && cancellingRef.current.size && next.type !== 'modify' && next.type !== 'group') return;
    if (!account || next.base.account_seq !== account || next.base.code !== code) { setNotice('계좌·종목이 변경되었습니다. 다시 선택하세요.'); return; }
    const targets = next.batch ?? (next.order ? [{ order: next.order, base: next.base }] : []);
    if (targets.some(item => cancellingRef.current.has(orderKey(account, item.order.orderId)) || awaitingResult(item.order)
      || cancelFailures.some(failure => failure.action.base.account_seq === account && failure.action.order?.orderId === item.order.orderId
        && failure.notice.persistent && failure.action.base.command_id !== item.base.command_id))) return;
    const issue = next.type === 'create' ? newOrderIssue({ ...(next.orderType === 'PREOPEN_CLOSE' ? preopenAvailability : availability), quantity: next.quantity,
      unresolved: cancelFailures.some(item => item.action.base.account_seq === account && item.notice.persistent)
        || !!state.data?.unresolved_commands.some(id => id !== next.base.command_id) })
      : changesPrice(next) && !fresh ? newOrderIssue({ ...availability, settingsOpen: false, locked: false }) : null;
    if (issue) { setNotice(issue); return; }
    const announceReceipt = changesPrice(next) && preferences.orderReceiptSound;
    if (announceReceipt) prepareOrderReceiptSound();
    if (cancellingOrders) {
      // Reserve every target synchronously, before either React or the broker responds.
      for (const item of targets) cancellingRef.current.add(orderKey(account, item.order.orderId));
      setCancelling(new Set(cancellingRef.current));
      setCancelFailures(prev => prev.filter(item => !targets.some(target => target.base.command_id === item.action.base.command_id)));
    } else { busyRef.current = true; setBusy(true); }
    setNotice(null); setFailedRequest(null);
    const resumeRefresh = pauseTradingRefresh(client, mode, account);
    const label = next.type === 'create' ? '주문' : (next.operation ?? next.type) === 'modify' ? '정정' : '취소';
    setReceipt(null);
    let retryAction = next;
    let groupFailure: OrderNotice | null = null;
    let accepted = true;
    let firstAcceptedCommandId: string | null = null;
    try {
      if (next.type === 'group') {
        const failed: NonNullable<Action['batch']> = [];
        let uncertain = false;
        const messages: string[] = [];
        const batch = next.batch ?? [];
        let nextIndex = 0;
        const submitOrders = async () => {
          while (nextIndex < batch.length) {
            const item = batch[nextIndex++];
            try {
              const body = next.operation === 'modify' ? { ...item.base, price: next.price, quantity: null, confirm_high_value: high } : item.base;
              const response = await tradingCommand<TradingCommandResponse>(`/orders/${encodeURIComponent(item.order.orderId)}/${next.operation}`, body, mode);
              firstAcceptedCommandId ??= item.base.command_id;
              if (next.operation === 'modify') acceptTradingReplacement(client, mode, account, code, item.order.orderId, response.order_id);
              setPending(prev => ({ ...prev, [orderKey(account, item.order.orderId)]: response.order_id }));
            } catch (error) {
              const failure = orderFailure(error, label);
              if (cancellingOrders) recordCancelFailure({ type: 'cancel', base: item.base, order: item.order,
                side: item.order.side, price: 0, quantity: null, keepOrderList: true },
              { ...failure, message: `취소 미접수 1건 · ${failure.message}` });
              if (failure.retry) failed.push(item);
              uncertain ||= !!failure.persistent;
              messages.push(error instanceof Error ? error.message : '처리 결과 확인 필요');
            }
          }
        };
        // Refill each completed cancel slot immediately; grouped replacements keep their order.
        await Promise.all(Array.from({ length: Math.min(batch.length, cancellingOrders ? MAX_CONCURRENT_GROUP_CANCELS : 1) }, submitOrders));
        if (messages.length) {
          if (cancellingOrders) accepted = false;
          else {
            retryAction = { ...next, batch: failed };
            groupFailure = { title: `${label} ${uncertain ? '결과 확인 필요' : '접수 불가'}`,
              message: `${label} 미접수 ${messages.length}건 · ${messages.join(' · ')}`, tone: uncertain ? 'error' : 'warn',
              persistent: uncertain, retry: failed.length > 0 };
            throw new Error(groupFailure.message);
          }
        }
      } else if (next.type === 'bulk') {
        const body: CancelTradingOrders = { ...next.base, side: next.side };
        const result = await tradingCommand<TradingCancelResponse>('/cancel-all', body, mode);
        const rejected = result.results.filter(r => !r.accepted);
        accepted = rejected.length === 0;
        if (rejected.length) {
          const uncertain = rejected.some(r => r.code === 'order-outcome-unknown' || r.code === 'unresolved-order-exists');
          setNotice({ title: uncertain ? '취소 결과 확인 필요' : '취소 접수 불가', tone: uncertain ? 'error' : 'warn',
            persistent: uncertain, message: `취소 미접수 ${rejected.length}건${rejected.map(r => ` · ${r.message}`).join('')}` });
        }
        setPending(prev => ({ ...prev, ...Object.fromEntries(result.results.filter(r => r.accepted).map(r => [orderKey(account, r.order_id), r.operation_id ?? r.order_id])) }));
      } else {
        let response: TradingCommandResponse;
        if (next.type === 'create') {
          const body: CreateTradingOrder = { ...next.base, side: next.side!, price: next.price, quantity: next.quantity!, confirm_high_value: high,
            ...(next.orderType === 'PREOPEN_CLOSE' ? { order_type: next.orderType } : {}),
            ...(typeof account === 'string' ? { route: next.base.route } : {}) };
          response = await tradingCommand<TradingCommandResponse>('/orders', body, mode);
        } else {
          const path = `/orders/${encodeURIComponent(next.order!.orderId)}/${next.type}`;
          if (next.type === 'modify') {
            const body: ModifyTradingOrder = { ...next.base, price: next.price, quantity: next.quantity, confirm_high_value: high };
            response = await tradingCommand<TradingCommandResponse>(path, body, mode);
          } else response = await tradingCommand<TradingCommandResponse>(path, next.base, mode);
          if (next.type === 'modify') acceptTradingReplacement(client, mode, account, code, next.order!.orderId, response.order_id);
          setPending(prev => ({ ...prev, [orderKey(account, next.order!.orderId)]: response.order_id }));
        }
        firstAcceptedCommandId = next.base.command_id;
      }
      // A late cancel ACK must not close a newer order menu or confirmation.
      if (!cancellingOrders) {
        resetAction();
        if (!next.keepOrderList) closeMenu();
      }
      setReceipt(accepted ? { text: `${label} 요청 접수됨`, commandId: next.base.command_id } : null);
    } catch (error) {
      setReceipt(null);
      const failure = groupFailure ?? orderFailure(error, label);
      if (cancellingOrders) recordCancelFailure(next, failure);
      else setNotice(failure);
      if (next.type === 'group') {
        resetAction();
        if (!next.keepOrderList) closeMenu();
      }
      // A failure never opens the removed new-order editor. Retry retains its ID.
      if (!cancellingOrders) setFailedRequest(failure.retry ? { action: retryAction, high } : null);
    } finally {
      // One gesture, one chime, including partially accepted batches. Using the first
      // accepted child ID lets a retry of failed children announce its own receipt.
      if (announceReceipt && firstAcceptedCommandId) {
        const soundFailed = () => setReceipt(current => current?.commandId === next.base.command_id
          ? { ...current, text: `${label}은 접수됐지만 알림음을 재생하지 못했습니다`, soundFailed: true } : current);
        void notifyOrderReceiptAccepted(account, firstAcceptedCommandId).then(started => {
          if (!started) soundFailed();
        }, soundFailed);
      }
      if (cancellingOrders) {
        for (const item of targets) cancellingRef.current.delete(orderKey(account, item.order.orderId));
        setCancelling(new Set(cancellingRef.current));
      } else { busyRef.current = false; setBusy(false); }
      resumeRefresh();
    }
  }

  function request(next: Action) {
    if (next.type === 'bulk' && allOrders.length !== orders.length) {
      next = { ...next, type: 'group', operation: 'cancel', batch: orders
        .filter(order => (next.side == null || order.side === next.side) && editableOrder(order) && !pending(order))
        .map(order => ({ order, base: base() })) };
    }
    if (!next.keepOrderList) closeMenu();
    confirmHigh(false);
    const qty = next.quantity ?? (next.order ? orderRemainder(next.order) : 0);
    const high = changesPrice(next) && next.price * qty >= HIGH_VALUE_WON;
    setFailedRequest(null); setNotice(null);
    if (high) setAction(next);
    else { resetAction(); void submit(next); }
  }
  async function reviewCommand(commandId: string) {
    if (!reviewedUnknown || busyRef.current || cancellingRef.current.size) return;
    busyRef.current = true; setBusy(true);
    try {
      const body: ReviewTradingCommand = { ...base(), command_id: commandId, confirmed: true };
      await tradingCommand<TradingReviewResponse>(`/commands/${encodeURIComponent(commandId)}/review`, body, mode);
      setCancelFailures(prev => prev.filter(item => item.action.base.command_id !== commandId));
      closeAction(); reviewUnknown(false);
    } catch (error) { setNotice(error instanceof Error ? error.message : '내역 확인 기록 실패'); }
    finally { await client.invalidateQueries({ queryKey: ['trading', mode, 'state', account] }); busyRef.current = false; setBusy(false); }
  }
  function create(side: TradingSide, price: number, orderType: 'LIMIT' | 'PREOPEN_CLOSE' = 'LIMIT') {
    if (busyRef.current || cancellingRef.current.size || explorer.panning) return;
    const issue = orderType === 'PREOPEN_CLOSE' ? preopenCreationIssue : creationIssue;
    if (issue) {
      // A blocked new order must not hide the outstanding request's reconciliation action.
      if (!(issue.persistent && notice?.retry && failedRequest)) setNotice(issue);
      return;
    }
    if (!Number.isSafeInteger(price) || price <= 0) { setNotice('유효한 주문 가격을 확인하세요.'); return; }
    request({ type: 'create', base: { ...base(), ...(typeof account === 'string' ? { route: orderType === 'PREOPEN_CLOSE' ? 'KRX' : orderRoute } : {}) }, side, price, quantity, orderType });
  }

  function beginDrag(e: PointerEvent<HTMLElement>, candidates: TossOrder[], list = false) {
    const targets = candidates.filter(order => order.orderType !== 'PREOPEN_CLOSE' && editableOrder(order) && !pending(order) && orderRemainder(order) > 0);
    if (e.button !== 0 || !targets.length || !ready || settingsDraft || action || drag.current) return;
    e.stopPropagation();
    drag.current = { orders: targets, list: list ? e.currentTarget.closest('[data-order-list]') : null, x: e.clientX, y: e.clientY, cursorX: e.clientX, cursorY: e.clientY, active: false, price: null, cancel: false, pointer: e.pointerId, element: e.currentTarget };
    setDragInProgress(true); e.currentTarget.setPointerCapture(e.pointerId);
  }
  const updateDragTarget = useCallback(() => {
    const d = drag.current;
    if (!d?.active) return;
    if (d.list) {
      const bounds = d.list.getBoundingClientRect();
      if (d.cursorX >= bounds.left && d.cursorX <= bounds.right && d.cursorY >= bounds.top && d.cursorY <= bounds.bottom) {
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
    d.cancel = d.cursorX < left || d.cursorX > right || d.cursorY < top || d.cursorY > bottom;
    const hit = document.elementFromPoint(d.cursorX, d.cursorY);
    const row = hit?.closest<HTMLElement>('[data-order-price]')
      ?? (hit?.closest('.order-summary-layer') && ladder.current?.contains(hit)
        ? [...ladder.current.querySelectorAll<HTMLElement>('[data-order-price]')].find(row => {
          const bounds = row.getBoundingClientRect();
          return d.cursorY >= bounds.top && d.cursorY < bounds.bottom;
        }) : null);
    const lane = hit?.closest<HTMLElement>('[data-order-side]');
    d.price = !d.cancel && row && ladder.current?.contains(row) && (!lane || lane.dataset.orderSide === d.orders[0].side) ? Number(row.dataset.orderPrice) : null;
    setDragTarget(d.price); setDragCancel(d.cancel);
  }, []);
  useLayoutEffect(updateDragTarget, [book, explorer.prices[0], updateDragTarget]);
  function moveDrag(e: PointerEvent<HTMLElement>) {
    const d = drag.current;
    if (!d || d.pointer !== e.pointerId) return;
    if (!d.active && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 6) return;
    if (!d.active) {
      d.active = true; setDraggingOrders(d.orders);
      // Keep capture alive even if a live update removes the original price slot.
      if (rootRef.current) {
        d.element = rootRef.current;
        d.element.setPointerCapture(d.pointer);
      }
    }
    d.cursorX = e.clientX; d.cursorY = e.clientY;
    positionDragPreview();
    updateDragTarget();
  }
  function endDrag(e?: PointerEvent<HTMLElement>, aborted = false) {
    if (e && !aborted) moveDrag(e);
    const d = drag.current;
    if (!d || (e && e.pointerId !== d.pointer)) return;
    resetDrag();
    if (aborted || !d.active) return;
    let targets = d.orders.flatMap(original => {
      const order = latestOrders.current.find(o => o.orderId === original.orderId);
      return order && order.side === original.side && order.price === original.price && editableOrder(order) && !pending(order) && orderRemainder(order) > 0 ? [order] : [];
    });
    if (!targets.length) { setNotice('드래그 중 주문 상태가 변경되었습니다. 최신 내역을 확인하세요.'); return; }
    const operation = d.cancel ? 'cancel' : d.price ? 'modify' : null;
    if (!operation) return;
    // Totals can span prices. Preserve orders already at the destination, including the first one.
    if (operation === 'modify') targets = targets.filter(order => Number(order.price) !== d.price);
    if (!targets.length) return;
    const price = operation === 'cancel' ? 0 : d.price!;
    const keepOrderList = !!d.list && operation === 'cancel';
    if (targets.length === 1) request({ type: operation, base: base(), side: targets[0].side, price, quantity: null, order: targets[0], keepOrderList });
    else request({ type: 'group', operation, base: base(), side: targets[0].side, price,
      quantity: targets.reduce((sum, order) => sum + orderRemainder(order), 0), batch: targets.map(order => ({ order, base: base() })), keepOrderList });
  }

  function orderCell(side: TradingSide, price: number, rowKey: string) {
    const group = groups.get(`${side}:${price}`) ?? [];
    const destination = draggedOrder?.side === side && dragTarget === price && price > 0;
    const canCreate = !busy && !creationIssue && price > 0;
    const canDrag = ready && group.some(order => editableOrder(order) && !pending(order));
    return <button type="button" className={`order-lane ${side === 'BUY' ? 'order-buy' : 'order-sell'} ${destination ? 'order-drag-destination' : ''}`}
      data-order-side={side} aria-label={`${orderSideLabel(side)} ${fmt(price)}원 주문 추가 ${rowKey}`}
      aria-disabled={!canCreate && !canDrag}
      onDoubleClick={() => { if (!suppressClick.current) create(side, price); }}
      onKeyDown={event => {
        if (creationIssue && !event.repeat && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault(); create(side, price);
        }
      }}
      onPointerDown={e => beginDrag(e, group)}
      onContextMenu={e => {
        if (!group.length) return;
        e.preventDefault(); e.stopPropagation();
        if (!drag.current && !action && !settingsDraft) setContextMenu({ x: e.clientX, y: e.clientY, side, price });
      }}>
      {group.length > 0 && <span className={`order-quantity ${!canDrag ? 'order-quantity-blocked' : ''} ${draggingOrders.some(order => group.some(item => item.orderId === order.orderId)) ? 'order-chip-dragging' : ''}`}
        aria-label={`${orderSideLabel(side)} ${fmt(price)}원 주문${group.length > 1 ? ' 합계' : ''}`}
        data-drag-order={group.some(order => editableOrder(order) && !pending(order)) ? group.map(order => order.orderId).join(',') : undefined}>
        {fmt(group.reduce((sum, order) => sum + orderRemainder(order), 0))}
      </span>}
    </button>;
  }

  function openSideOrders(side: TradingSide, point: { x: number; y: number }) {
    if (!drag.current && !action && !settingsDraft && !exclusiveBusy) setContextMenu({ ...point, side });
  }

  const recentTrades = useRecentBookTrades({ code, date: todayKst, venue: effectiveVenue,
    frames: live.trade, enabled: activeSinglePrice === null });
  const highlight = useTradeHighlight();
  const trades = activeSinglePrice !== null ? singlePriceFills.slice(0, 9) : recentTrades;
  const lastPrice = activeSinglePrice !== null ? (afterHoursBook.data?.cur_price ?? null) : (recentTrades[0]?.price ?? null);
  const { setProbe, setSummaryProbe, samples, style: columnStyle } = useOrderColumnLayout(`${account}:${code}`,
    asks.concat(bids).map(level => level.qty), deltaBadges ? [...deltaBadges.values()].map(badge => badge.delta) : [],
    trades, summary.fillStrengthPct,
    [...groups.values()].map(group => group.reduce((sum, order) => sum + orderRemainder(order), 0))
      .concat([sideOrders.SELL, sideOrders.BUY].map(list => list.reduce((sum, order) => sum + orderRemainder(order), 0))),
    Math.max(sideOrders.SELL.length, sideOrders.BUY.length));

  const renderSummary = (height: number) => <BookSummary summary={summary} baselinePrice={baseline ?? null}
    limits={limits.data} krxClose={krxClose.data?.date === todayKst ? krxClose.data.price : null}
    krxPreviousClose={krxPreviousClose.data?.as_of === todayKst ? krxPreviousClose.data.price : null}
    vi={vi.data?.vi} height={height} page={infoPage} onNextPage={() => setInfoPage(page => page === 0 ? 1 : 0)}
    expectedFill={{
      price: restBook ? 0 : storedLadder || activeSinglePrice !== null ? snapshot?.exp_price ?? 0 : quote?.expected_price ?? 0,
      qty: restBook ? null : storedLadder || activeSinglePrice !== null ? snapshot?.exp_qty ?? 0 : quote?.expected_qty ?? null,
    }} />;
  function saveSettingsEdits(next: OrderWindowSettings) {
    if (busy) return;
    setSettingsDraft(next);
    // An incomplete preset must not block saving other fields or replace its last valid value.
    onApplySettings({ ...next,
      quantityPresets: next.quantityPresets.map((value, index) => validOrderInput(value, 'quantity') ? value : preferences.quantityPresets[index]) as OrderWindowSettings['quantityPresets'],
      amountPresets: next.amountPresets.map((value, index) => validOrderInput(value, 'amount') ? value : preferences.amountPresets[index]) as OrderWindowSettings['amountPresets'],
    });
  }
  function fullPriceRow(price: number) {
    const ask = asks.find(level => level.price === price);
    const bid = bids.find(level => level.price === price);
    const pct = baseline && baseline > 0 ? (price / baseline - 1) * 100 : null;
    const key = `full-${price}`;
    const depth = (side: 'ask' | 'bid', level: typeof ask) => <div className={`order-depth order-${side}`}
      style={{ '--order-depth': (level?.qty ?? 0) / maxQty } as React.CSSProperties}>
      {level && level.qty > 0 && <span className="order-depth-values"><BookQtyDelta badge={deltaBadges?.get(`${side === 'ask' ? 'a' : 'b'}:${price}`) ?? null} /><BookAmountTooltip price={price} qty={level.qty} className="order-depth-qty">{fmt(level.qty)}</BookAmountTooltip></span>}
    </div>;
    const knownQuantity = ask?.qty ?? bid?.qty;
    return <div className={`order-row ${dragTarget === price ? 'order-target' : ''}`} data-order-price={price} key={key}>
      {orderCell('SELL', price, key)}
      {depth('ask', ask)}
      <div data-price-pan className={`order-price order-full-price book-price-line ${price === (currentPrice ?? lastPrice) ? 'order-current' : ''} ${pct == null || pct === 0 ? '' : pct > 0 ? 'text-price-up' : 'text-price-down'}`}>
        <span className="order-price-value book-price-value"><BookDayMarker marker={dayMarkers.get(price) ?? null} />
          {price === averageMarker.price && <TextTooltip text={averageMarkerLabel}><span className="order-average-marker" role="img" aria-label={averageMarkerLabel} /></TextTooltip>}
          {knownQuantity != null ? <BookPriceAmount price={price} qty={knownQuantity} /> : fmt(price)}
        </span>{preferences.showPriceChangePercent && <small className="book-price-percent">{pct == null ? '—' : `${pct > 0 ? '+' : ''}${pct.toFixed(2)}%`}</small>}
      </div>
      {depth('bid', bid)}
      {orderCell('BUY', price, key)}
    </div>;
  }
  return <div ref={rootRef}
    onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={e => endDrag(e, true)}
    onLostPointerCapture={e => { if (e.target === drag.current?.element) endDrag(e, true); }}
    style={{ ...priceLayout, ...columnStyle }} className={`order-window font-data ${compact ? 'order-compact' : ''} ${expanded ? 'order-expanded' : ''} ${spacious ? 'order-spacious' : ''} ${preferences.showPriceSeparators ? 'order-price-separators' : ''} ${preferences.showPriceChangePercent ? '' : 'order-hide-percent'} ${draggingOrderId ? 'order-dragging' : ''} ${dragCancel ? 'order-drag-canceling' : ''}`} data-testid="order-window" onPointerDownCapture={() => { suppressClick.current = false; }}
    onClickCapture={e => {
      if (suppressClick.current) { e.preventDefault(); e.stopPropagation(); suppressClick.current = false; }
      else if (e.detail === 1) suppressDoubleClick.current = false;
    }}
    onDoubleClickCapture={e => {
      if (suppressDoubleClick.current) { e.preventDefault(); e.stopPropagation(); suppressDoubleClick.current = false; }
    }}
    onKeyDown={e => {
      if (e.key === 'Escape') {
        explorer.cancelPan();
        if (settingsDraft) { e.preventDefault(); e.stopPropagation(); closeSettings(); return; }
        if (drag.current || action || contextMenu) { e.preventDefault(); e.stopPropagation(); }
        endDrag(undefined, true); closeAction(); return;
      }
    }}>
    <div className="order-controls order-account-controls">
      <div className="order-account-group" ref={accountAnchor}>
      {accounts.data && (accounts.data.accounts.length > 1 || (accounts.data.accounts.length > 0 && !activeAccount)) ? <select className="order-account-select" aria-label="주문 계좌" value={account} disabled={busy || dragInProgress}
        onChange={e => { const next = accounts.data?.accounts.find(item => String(item.account_seq) === e.target.value);
          if (next) onAccountChange(next.account_seq);
          closeAction(); resetDrag(); setPending({}); setFailedRequest(null); setNotice(null); setReceipt(null); reviewUnknown(false); }}>
        {!activeAccount && <option value={account} disabled>선택 계좌 연결 확인</option>}
        {accounts.data.accounts.map(a => <option key={a.account_seq} value={a.account_seq}>{accountDisplayLabel(a.label)}</option>)}
      </select> : <TextTooltip text={accountDisplayLabel(activeAccount?.label)}><span className="order-account-label text-fg-dim">{accountDisplayLabel(activeAccount?.label)}</span></TextTooltip>}
      {(['orders', 'holdings'] as const).map(tab => <button key={tab} type="button" aria-haspopup="dialog" aria-expanded={accountTab === tab}
        disabled={!account || dragInProgress || busy} onClick={() => { closeAction(); setSettingsDraft(null); setAccountTab(accountTab === tab ? null : tab); }}>
        {tab === 'orders' ? '미체결 주문' : '보유종목'}
      </button>)}
      </div>
      {onOpenExecutions && <button type="button" disabled={!account || !activeAccount || dragInProgress || busy}
        onClick={() => onOpenExecutions(account)}>내 체결</button>}
      <div className="order-settings-group">
      {!showInlineSummary && <button ref={infoButtonRef} type="button" aria-label="종목 상세 정보" aria-haspopup="dialog" aria-expanded={infoOpen} aria-controls={infoOpen ? infoId : undefined}
        disabled={dragInProgress} onClick={() => setInfoOpen(open => !open)}>정보</button>}
      {routes && <TextTooltip text={`시세 ${venue} · 주문 ${activeAccount?.order_enabled === false ? '검증 대기 · ' : ''}${orderRoute}`}>
        <span className="order-route-summary text-fg-dim" aria-label="주문 경로" tabIndex={routes.length > 1 ? undefined : 0}>
          <span><span className="order-route-prefix">시세 </span>{venue}</span>
          <span aria-hidden="true">·</span>
          <span className="order-route-prefix">주문</span>
          {activeAccount?.order_enabled === false && <span>검증 대기</span>}
          {routes.length > 1 ? <select aria-label="주문 거래소" value={orderRoute} disabled={busy || dragInProgress}
            onChange={e => { chooseRoute(e.target.value as 'SOR' | 'KRX' | 'NXT'); closeAction(); resetDrag(); setFailedRequest(null); }}>
            {routes.map(route => <option key={route} value={route}>{route}</option>)}
          </select> : activeAccount?.order_enabled !== false && <span>{orderRoute}</span>}
        </span>
      </TextTooltip>}
      </div>
    </div>
    <AccountTradingPanel key={account} account={account} orderEnabled={!!activeAccount && activeAccount.order_enabled !== false} accountLabel={activeAccount?.label ?? '계좌 연결 대기'}
      tab={accountTab} anchorRef={accountAnchor} onClose={closeAccountPanel} onSelectSymbol={onSelectSymbol} />
    <div className="order-controls order-overview-controls">
      <div className="order-holdings-summary" role="group" aria-label="보유 종목 정보">
        <button type="button" className="order-field order-holding-quantity" aria-label="매입수량" aria-describedby={quantityTip.id}
          disabled={!canFillHoldingQuantity} onClick={() => {
            if (!canFillHoldingQuantity || sellableQuantity == null) return;
            onQuantityChange(sellableQuantity);
            setNotice(null);
            quantityTip.hide();
          }}
          onMouseEnter={e => quantityTip.show(e.currentTarget)} onMouseLeave={quantityTip.hide}
          onFocus={e => quantityTip.showOnFocus(e.currentTarget)} onBlur={quantityTip.hide}
          onKeyDown={e => { if (e.key === 'Escape') quantityTip.hide(); }}>
          <span className="order-field-value">{hasHolding ? fmt(holdingQuantity) : ''}</span>
        </button>
        <span className="order-field" aria-label="매입평단가" aria-describedby={averageTip.id} tabIndex={purchaseAmount == null ? undefined : 0}
          onMouseEnter={e => averageTip.show(e.currentTarget)} onMouseLeave={averageTip.hide}
          onFocus={e => averageTip.showOnFocus(e.currentTarget)} onBlur={averageTip.hide}
          onKeyDown={e => { if (e.key === 'Escape') averageTip.hide(); }}>
          <span className="order-field-value">{averagePriceDisplay}</span>
        </span>
        <span className="order-field" aria-label="보유 종목 평가 수익">
          <button type="button" className="order-profit-toggle" aria-label="평가손익 표시 전환" aria-pressed={profitAsPercent}
            aria-describedby={profitTip.id} disabled={!canToggleProfit}
            onMouseEnter={e => profitTip.show(e.currentTarget)} onMouseLeave={profitTip.hide}
            onFocus={e => profitTip.showOnFocus(e.currentTarget)} onBlur={profitTip.hide}
            onDoubleClick={onToggleProfitDisplay} onKeyDown={event => {
              if (event.key === 'Escape') profitTip.hide();
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                if (!event.repeat && canToggleProfit) onToggleProfitDisplay();
              }
            }}>
            <span className={`order-field-value ${holdingProfit != null && holdingProfit > 0 ? 'text-price-up' : holdingProfit != null && holdingProfit < 0 ? 'text-price-down' : 'text-fg'}`}>{profitText}</span>
          </button>
        </span>
      </div>
      <span className="order-buying-power" aria-label="매수 가능 금액"><span className="order-meta">매수 가능</span><span className="order-field-value">{buyingPower != null && Number.isSafeInteger(buyingPower) && buyingPower >= 0 ? `${fmt(buyingPower)}원` : ''}</span></span>
    </div>
    <div className="order-controls order-quantity-controls">
      <div className="order-input-controls" role="group" aria-label="공통 주문 수량">
        <div className="order-input-mode order-surface-segment" role="group" aria-label="빠른 입력 방식">
          {(['amount', 'quantity'] as const).map(unit => <button key={unit} type="button" aria-pressed={preferences.unit === unit} disabled={busy || dragInProgress}
            onClick={() => { closeAction(); onApplySettings({ ...preferences, unit }); }}>{unit === 'amount' ? '금액' : '주'}</button>)}
        </div>
        <label className="order-input-field"><input type="number" aria-label="신규 주문 수량" min="0" max={MAX_ORDER_QUANTITY} step="1" value={quantity ?? ''} onChange={e => { onQuantityChange(e.target.value === '' ? null : Number(e.target.value)); setNotice(null); }} /><span className="order-meta">주</span></label>
        <div className="order-quantity-presets">
          {presets.map((value, index) => <button type="button" key={index} aria-pressed={amountPresets ? undefined : quantity === value}
            disabled={amountPresets && !canConvertAmount}
            onClick={() => applyPreset(value)}>{fmt(amountPresets ? value * 100 : value)}{amountPresets ? '만' : '주'}</button>)}
        </div>
        <div className="order-price-controls" role="group" aria-label="호가 가격 탐색">
          <button type="button" aria-pressed={explorer.enabled} disabled={!fullRange || explorerPrice == null || busy || dragInProgress || explorer.panning || !!settingsDraft || !!action}
            onClick={() => { closeAction(); explorer.toggle(); }}>전체 호가</button>
          <button type="button" disabled={!explorer.enabled || explorerPrice == null || busy || dragInProgress || explorer.panning || !!settingsDraft || !!action}
            onClick={() => { closeAction(); explorer.centerCurrent(); }}>현재가</button>
        </div>
        <span className="order-field order-estimate" aria-label="예상 주문 금액">
          <span className="order-meta" aria-hidden="true">금액</span>
          <span className="order-field-value">{estimateAmount == null ? '' : `${fmt(estimateAmount)}원`}
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
    {profitTip.tooltip}
    {draggedOrder && createPortal(<div ref={dragPreview} role="status" aria-label="주문 드래그 미리보기"
      className={`order-drag-preview font-data ${draggedOrder.side === 'BUY' ? 'order-buy' : 'order-sell'} ${dragCancel ? 'order-drag-preview-cancel' : ''}`}>
      {fmt(draggingOrders.reduce((sum, order) => sum + orderRemainder(order), 0))}
    </div>, document.body)}
    <WindowHeaderAction>
      <WindowSettingsPopover title="주문 설정" scope="이 창에 적용" width={380}
        open={!!settingsDraft} disabled={busy || dragInProgress}
        onOpenChange={open => {
          if (!open) { closeSettings(); return; }
          if (busy || dragInProgress) return;
          closeAction(); setAccountTab(null); setInfoOpen(false);
          setSettingsDraft(normalizeOrderSettings(preferences));
        }}
        render={() => settingsDraft && <OrderSettingsForm draft={settingsDraft} onChange={saveSettingsEdits} busy={busy} />} />
    </WindowHeaderAction>
    {snapshot != null && !needsRestBook && <BookAvailabilityState state={bookAvailability} onRetry={retryBook} />}
    {restBook && <RestOrderbookSource rest={rest} venue={effectiveVenue} testId="order-rest-book-source" showProvenance={false} />}
    <div ref={priceViewportRef} className="order-scroll" onScroll={updateDragTarget} role="region" aria-label="실시간 호가 주문 사다리"
      tabIndex={explorer.enabled ? 0 : undefined} onKeyDown={explorer.onKeyDown}
      onPointerDown={explorer.onPointerDown} onPointerMove={explorer.onPointerMove} onPointerUp={explorer.onPointerUp}
      onPointerCancel={explorer.onPointerUp} onLostPointerCapture={explorer.onPointerUp}>
      <div className={`order-ladder ${prices.length > 0 ? 'order-ladder-centered' : ''} ${explorer.enabled ? 'order-ladder-full' : ''} ${dragCancel ? 'order-cancel-active' : ''}`} ref={ladder}
        onContextMenu={e => { e.preventDefault(); e.stopPropagation(); if (!drag.current && !action && !settingsDraft) setContextMenu({ x: e.clientX, y: e.clientY }); }}>
        <span ref={setProbe} aria-hidden="true" className="order-column-sizer">
          {['+', '−'].map(sign => <span key={sign} data-depth-probe className="order-depth-probe">
            <span className="text-2xs" data-figure={`${sign}${samples.delta}`} /><span data-figure={samples.qty} />
          </span>)}
          <span data-depth-probe className="order-info-probe"><span data-trade-price-probe data-figure={samples.price} /><span data-figure={samples.trade} /></span>
          <span data-depth-probe className="order-info-probe"><span className="order-meta" data-figure="체결강도" /><span data-figure={samples.strength} /></span>
          <span data-lane-probe className="order-lane-probe" data-figure={samples.order} />
          <span data-lane-probe className="order-total-probe" data-figure={samples.total} />
        </span>
        {explorer.enabled ? explorer.prices.map(fullPriceRow) : prices.length === 0 ? <div className={`order-empty-layout ${expanded ? 'order-empty-expanded' : ''}`}>
          <div>{needsRestBook ? <RestOrderbookEmpty rest={rest} loading={loadingLastBook} onRetry={retryBook} testId="order-empty-book" /> : bookAvailability ? <BookAvailabilityState state={bookAvailability} onRetry={retryBook} />
            : <p className="order-notice">{afterHoursTotals ? '호가 사다리 없음 (총잔량만 수신 중)' : '현재 표시할 호가가 없습니다'}</p>}</div>
          <div className="order-empty-summary">{renderSummary(264)}</div>
        </div>
          : Array.from({ length: 20 }, (_, slot) => {
          const isAsk = slot < 10;
          const index = slot - (10 - asks.length);
          const bidIndex = slot - 10;
          const level = isAsk ? asks[index] : bids[bidIndex];
          const firstBid = bidIndex === 0;
          const key = `${isAsk ? 'ask' : 'bid'}-${slot}`;
          const trade = bidIndex > 0 ? trades[bidIndex - 1] : undefined;
          const tradePriceColor = trade && baseline != null && baseline > 0 ? priceDirClass(trade.price - baseline) : 'text-fg-dim';
          const info = <div className={`order-info ${firstBid ? 'order-strength' : 'order-trade'}`}><span className={firstBid ? 'order-meta' : tradePriceColor}>{firstBid ? '체결강도' : trade ? fmt(trade.price) : ''}</span><span className={trade ? `rounded-sm ${priceDirClass(trade.side)}` : undefined}
            style={trade ? { background: tradeHighlightBackground(trade, highlight) } : undefined}>{firstBid ? summary.fillStrengthPct == null ? '—' : `${fmt(summary.fillStrengthPct)}%` : trade ? fmt(trade.qty) : ''}</span></div>;
          // Empty slots preserve the center without becoming order/drag targets.
          // Recent fills still occupy their fixed slots beside the bid ladder.
          if (!level) return <div className={`order-row order-empty ${firstBid ? 'order-divider' : ''}`} key={key}
            aria-hidden={isAsk || (!firstBid && !trade) ? true : undefined}>
            <div />{!isAsk && (firstBid || trade) ? info : <div />}<div /><div className={isAsk ? 'order-summary-slot' : undefined} /><div />
          </div>;
          const pct = baseline && level.price > 0 ? (level.price / baseline - 1) * 100 : null;
          return <div className={`order-row ${firstBid ? 'order-divider' : ''} ${dragTarget === level.price ? 'order-target' : ''}`} data-order-price={level.price} key={key}>
            {orderCell('SELL', level.price, key)}
            {isAsk ? <div className="order-depth order-ask" style={{ '--order-depth': level.qty / maxQty } as React.CSSProperties}><span className="order-depth-values"><BookQtyDelta badge={deltaBadges?.get(`a:${level.price}`) ?? null} /><BookAmountTooltip price={level.price} qty={level.qty} className="order-depth-qty">{fmt(level.qty)}</BookAmountTooltip></span></div>
              : info}
            <div className={`order-price book-price-line ${lastPrice === level.price ? 'order-current' : ''} ${pct == null || pct === 0 ? '' : pct > 0 ? 'text-price-up' : 'text-price-down'}`}><span className="order-price-value book-price-value"><BookDayMarker marker={dayMarkers.get(level.price) ?? null} />
              {index === averageMarkerIndex && <TextTooltip text={averageMarkerLabel}><span className="order-average-marker" role="img" aria-label={averageMarkerLabel} /></TextTooltip>}
              <BookPriceAmount price={level.price} qty={level.qty} /></span>{preferences.showPriceChangePercent && <small className="book-price-percent">{pct == null ? '—' : `${pct > 0 ? '+' : ''}${pct.toFixed(2)}%`}</small>}</div>
            {isAsk ? <div className="order-summary-slot" />
              : <div className="order-depth order-bid" style={{ '--order-depth': level.qty / maxQty } as React.CSSProperties}><span className="order-depth-values"><BookQtyDelta badge={deltaBadges?.get(`b:${level.price}`) ?? null} /><BookAmountTooltip price={level.price} qty={level.qty} className="order-depth-qty">{fmt(level.qty)}</BookAmountTooltip></span></div>}
            {orderCell('BUY', level.price, key)}
          </div>;
        })}
        {showInlineSummary && prices.length > 0 && <div ref={setSummaryProbe} className="order-summary-layer">{renderSummary(240)}</div>}
        <div className="order-total-row" role="group" aria-label="방향별 총 접수 주문">
          {(['SELL', 'BUY'] as const).map(side => {
            const list = sideOrders[side];
            const canDrag = ready && !settingsDraft && !action && list.some(order => editableOrder(order) && !pending(order));
            return <button key={side} type="button"
              className={`order-lane order-total ${side === 'BUY' ? 'order-buy' : 'order-sell'}`}
              aria-label={`${orderSideLabel(side)} 총 접수 주문`}
              aria-haspopup="menu" aria-expanded={contextMenu?.side === side && contextMenu.price == null}
              aria-disabled={!canDrag} data-order-total={side}
              onPointerDown={e => beginDrag(e, list)}
              onContextMenu={e => {
                e.preventDefault(); e.stopPropagation(); e.currentTarget.focus();
                openSideOrders(side, { x: e.clientX, y: e.clientY });
              }}
              onKeyDown={e => {
                if (e.key === 'Enter' || e.key === ' ' || e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
                  e.preventDefault(); const bounds = e.currentTarget.getBoundingClientRect();
                  openSideOrders(side, { x: bounds.left, y: bounds.bottom });
                }
              }}>
              {fmt(list.reduce((sum, order) => sum + orderRemainder(order), 0))}({list.length})
            </button>;
          })}
        </div>
      </div>
    </div>
    {(showPreopen || book || afterHoursTotals || sessionControl.kind !== 'none') && <TotalQtyStrip
      totals={displayTotals}
      maskRatio={displayTotals.ask + displayTotals.bid === 0}
      afterHoursTotals={afterHoursTotals} afterHoursLabel={afterHoursLabel}
      sessionControl={restBook ? { kind: 'label', label: '마지막 조회 호가' } : sessionControl} sessionMode={sessionMode}
      onSelectSessionMode={selectSessionMode}
      centerContent={showPreopen ? <TextTooltip text={preopenReason ?? '좌우 총잔량 숫자를 더블클릭해 장전 종가 주문 · 우클릭해 미체결 취소'}>
        <span tabIndex={0} className="order-meta" data-testid="preopen-strip-label">장전 종가{preopenEnded ? ' · 종료' : ''}{preopenPrice != null ? ` · ${fmt(preopenPrice)}원` : ''}{activeAccount?.broker !== 'kiwoom' ? ' · 토스 미지원' : ''}</span>
      </TextTooltip> : undefined}
      renderTotal={showPreopen ? (side, quantity) => {
        const direction = side === 'ask' ? 'SELL' : 'BUY';
        return <TextTooltip text={preopenCreationIssue?.message ?? `${orderSideLabel(direction)} ${fmt(preopenPrice)}원 · 더블클릭 주문 · 우클릭 미체결 취소`}>
          <button type="button" className={`order-preopen-total ${direction === 'SELL' ? 'order-sell' : 'order-buy'}`}
            aria-label={`장전 종가 ${orderSideLabel(direction)} 총잔량`} aria-disabled={busy || !!preopenCreationIssue}
            onDoubleClick={() => create(direction, preopenPrice ?? 0, 'PREOPEN_CLOSE')}
            onContextMenu={event => {
              event.preventDefault(); event.stopPropagation();
              if (!drag.current && !action && !settingsDraft && !exclusiveBusy) setContextMenu({ x: event.clientX, y: event.clientY, side: direction, preopen: true });
            }}>
            <span aria-label={`${afterHoursTotals ? `${afterHoursLabel} ` : ''}${orderSideLabel(direction)}총잔량 ${fmt(quantity)}`}>{book || afterHoursTotals ? fmt(quantity) : '—'}</span>
          </button>
        </TextTooltip>;
      } : undefined} />}
    {contextMenu?.side ? <PanelContextMenu point={contextMenu}
      label={`${orderSideLabel(contextMenu.side)} ${contextMenu.price == null ? '전체 접수' : `${fmt(contextMenu.price)}원`} 주문 목록`} showLabel={false} onClose={closeMenu} className="order-surface order-context-surface order-list-surface">
      <OrderSurfaceHeading closeLabel="주문 목록 닫기" onClose={closeMenu}><span className={contextMenu.side === 'BUY' ? 'text-price-up' : 'text-price-down'}>{orderSideLabel(contextMenu.side)}</span><span>{name || code}</span></OrderSurfaceHeading>
      <div data-order-list className="order-list font-data">
        {contextOrders.map((order, index) => <div key={order.orderId} className="order-list-row">
          <button key={order.orderId} type="button" role="menuitem"
            className={`order-list-item ${order.side === 'BUY' ? 'order-buy' : 'order-sell'} ${draggingOrderId === order.orderId ? 'order-chip-dragging' : ''}`}
            aria-label={`주문 ${index + 1} · ${fmt(orderRemainder(order))}주`}
            disabled={!ready || !editableOrder(order) || pending(order)}
            onPointerDown={e => beginDrag(e, [order], true)}>
            <span className="order-list-grip" aria-hidden="true">{order.orderType !== 'PREOPEN_CLOSE' && <GripIcon />}</span><span>{order.orderType === 'PREOPEN_CLOSE' ? '장전 종가' : order.price == null ? '시장가' : fmt(order.price)}</span><strong>{fmt(orderRemainder(order))}</strong>
          </button>
          <button type="button" className="order-list-cancel" aria-label={`주문 ${index + 1} 개별 취소`}
            disabled={!ready || !editableOrder(order) || pending(order)}
            onClick={() => request({ type: 'cancel', base: base(), side: order.side, price: 0, quantity: null, order, keepOrderList: true })}>취소</button>
        </div>)}
        {!contextOrders.length && <p className="order-list-hint">미체결 주문 없음</p>}
      </div>
    </PanelContextMenu> : contextMenu && <PanelContextMenu point={contextMenu} label="주문 취소" showLabel={false} onClose={closeMenu} className="order-surface order-context-surface">
      <OrderSurfaceHeading closeLabel="주문 취소 메뉴 닫기" onClose={closeMenu}>주문 취소</OrderSurfaceHeading>
      {([{ label: '매수 모두 취소', side: 'BUY' }, { label: '매도 모두 취소', side: 'SELL' }, { label: '전체 주문 취소', side: null }] as const).map(item =>
        <button key={item.label} type="button" role="menuitem" aria-label={item.label} className="order-cancel-menu-item"
          disabled={!ready || busy || !orders.some(order => (item.side == null || order.side === item.side) && editableOrder(order) && !pending(order))}
          onClick={() => request({ type: 'bulk', base: base(), side: item.side, price: 0, quantity: null })}><span>{item.label}</span><span className="order-meta">{orders.filter(order => (item.side == null || order.side === item.side) && editableOrder(order) && !pending(order)).length}건</span></button>)}
    </PanelContextMenu>}
    {action && highValue && createPortal(<div className="order-settings-surface font-data"><ModalShell ariaLabel="고액 주문 확인" width="w-[360px]" onClose={closeAction}>
      <div className="order-modal"><OrderSurfaceHeading closeLabel="고액 주문 확인 닫기" onClose={closeAction}>고액 주문 확인</OrderSurfaceHeading>
      <div className="order-confirm-body" role="group" aria-label="고액 주문 확인">
        {action.orderType === 'PREOPEN_CLOSE' && <div className="order-confirm-row">장전 시간외 종가 · KRX</div>}
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
    <OrderStatusBar key={`order-notice:${account}`} notice={notice ?? (!receipt && state.data?.unresolved_commands.length ? UNRESOLVED_NOTICE : null)} receipt={receipt} busy={busy}
      onDismiss={dismissNotice} onExpireReceipt={() => setReceipt(null)}
      onRetry={() => { if (cancelFailure) void submit(cancelFailure.action); else if (failedRequest) void submit(failedRequest.action, failedRequest.high); }}>
      {!!state.data?.unresolved_commands.length && <>
        <label><input type="checkbox" checked={reviewedUnknown} onChange={e => reviewUnknown(e.target.checked)} />해당 증권사의 실제 주문·체결 여부를 확인했습니다</label>
        {state.data.unresolved_commands.map(id => <button type="button" key={id} disabled={!reviewedUnknown || busy} onClick={() => void reviewCommand(id)}>요청 {id.slice(0, 8)} 확인 완료</button>)}
      </>}
    </OrderStatusBar>
  </div>;
}
