from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi import FastAPI

from hoga.api.trading_v2_routes import build_router
from hoga.trading.execution_range import ExecutionHistoryRange
from hoga.trading.toss import TradingError

REF = 'acc_' + 'a' * 32
OTHER = 'acc_' + 'b' * 32
PARAMS = {'account_ref': REF, 'from_date': '20261027', 'to_date': '20261028'}


def setup(tmp_path):
    calls = []

    async def call(api_id, body, *, cursor):
        assert api_id == 'kt00015' and body['stk_cd'] == '' and body['dmst_stex_tp'] == '%'
        assert body['gds_tp'] == '1' and body['tp'] == '3' and body['qry_sort_tp'] == '1'
        calls.append((body['strt_dt'], body['end_dt'], cursor))
        raw = ledger('20261027' if cursor else '20261028')
        return {'trst_ovrl_trde_prps_array': [raw]}, None if cursor else 'second'

    adapter = SimpleNamespace(gateway=SimpleNamespace(call=call,
        failure=lambda _: TradingError(503, 'invalid-response', '조회 실패')), events_connected=True)
    service = SimpleNamespace(toss=object(), resolve=AsyncMock(return_value=adapter),
        ensure_events=AsyncMock(), execution_range=ExecutionHistoryRange(tmp_path))
    app = FastAPI()
    app.include_router(build_router(service))
    return service, calls, httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test')


def ledger(date='20261028', code='A0099A0', **extra):
    return {'stk_cd': code, 'stk_nm': '과거 종목', 'cntr_dt': date, 'trde_dt': '20261030',
        'trde_ocr_tp': '9', 'trde_prtc_tp': '11', 'crnc_cd': 'KRW', 'trde_qty_jwa_cnt': '10',
        'proc_tm': '11:00:00', **extra}


async def test_kiwoom_uses_period_pages_with_actual_fill_dates_and_reuses_cached_pages(tmp_path):
    service, calls, api = setup(tmp_path)
    async with api:
        first = await api.get('/api/trading/v2/execution-history-range', params=PARAMS)
        assert first.status_code == 200, first.text
        data = first.json()
        assert data['scanned_through'] == '20261028'
        assert data['rows'][0]['date'] == '20261028'
        assert data['rows'][0]['filled_at'] is None  # Processing time never substitutes for a fill clock.
        second = (await api.get('/api/trading/v2/execution-history-range', params={
            **PARAMS, 'next_key': data['next_key']})).json()
        assert second['rows'][0]['date'] == '20261027' and second['next_key'] is None
        assert calls == [('20261027', '20261028', ''), ('20261027', '20261028', 'second')]
        await api.get('/api/trading/v2/execution-history-range', params=PARAMS)
        assert len(calls) == 2
        service.resolve.side_effect = TradingError(403, 'account-not-found', '연결 계좌를 확인하세요.')
        assert (await api.get('/api/trading/v2/execution-history-range', params=PARAMS)).status_code == 403
        assert len(calls) == 2


async def test_upstream_failures_are_not_empty_history(tmp_path):
    service, _, api = setup(tmp_path)
    async with api:
        adapter = service.resolve.return_value
        adapter.gateway.call = AsyncMock(side_effect=TradingError(503, 'unavailable', '조회 실패'))
        failed = await api.get('/api/trading/v2/execution-history-range', params=PARAMS)
        assert failed.status_code == 503


async def test_only_actual_domestic_stock_trades_survive_and_missing_fill_dates_fail_explicitly(tmp_path):
    service, _, api = setup(tmp_path)
    gateway = service.resolve.return_value.gateway
    gateway.call = AsyncMock(return_value=({'trst_ovrl_trde_prps_array': [
        ledger(), ledger('20261027'), ledger(code='A005930', trde_qty_jwa_cnt='-10'),
        ledger(code='A035720', trde_ocr_tp='1'), ledger(code='A035420', crnc_cd='USD'),
        ledger(code='A000660', trde_qty_jwa_cnt='0'),
        ledger(code='A123456', trde_ocr_tp='', trde_prtc_tp='', crnc_cd=''),
    ]}, None))
    async with api:
        result = (await api.get('/api/trading/v2/execution-history-range', params=PARAMS)).json()
        assert {row['code'] for row in result['rows']} == {'0099A0', '005930', '123456'}
        assert next(row for row in result['rows'] if row['code'] == '0099A0')['date'] == '20261028'
        service.execution_range.pages.clear()
        gateway.call.return_value = {'trst_ovrl_trde_prps_array': [ledger(cntr_dt='')]}, None
        assert (await api.get('/api/trading/v2/execution-history-range', params=PARAMS)).status_code == 503


@pytest.mark.parametrize('changed', [
    {'account_ref': OTHER}, {'from_date': '20261026'}, {'to_date': '20261029'},
])
async def test_signed_cursor_cannot_cross_account_or_range(tmp_path, changed):
    _, calls, api = setup(tmp_path)
    async with api:
        page = (await api.get('/api/trading/v2/execution-history-range', params=PARAMS)).json()
        response = await api.get('/api/trading/v2/execution-history-range', params={
            **PARAMS, **changed, 'next_key': page['next_key']})
        assert response.status_code == 422
        assert len(calls) == 1


@pytest.mark.parametrize('changed', [
    {'from_date': '20250230'}, {'from_date': '20241028'}, {'from_date': '20261029'}, {'to_date': '29990101'},
])
async def test_invalid_or_over_one_year_ranges_fail_before_broker_reads(tmp_path, changed):
    service, calls, api = setup(tmp_path)
    async with api:
        response = await api.get('/api/trading/v2/execution-history-range', params={**PARAMS, **changed})
    assert response.status_code == 422 and not calls
    service.resolve.assert_not_awaited()


def order(native, date, quantity='10'):
    return {'orderId': native, 'symbol': '005930', 'side': 'BUY', 'orderType': 'LIMIT', 'timeInForce': 'DAY',
        'status': 'FILLED', 'price': '50000', 'quantity': '100', 'currency': 'KRW',
        'orderedAt': '2024-01-01T10:00:00+09:00',
        'execution': {'filledQuantity': quantity, 'averageFilledPrice': '50000', 'filledAt': f'{date}T10:00:00+09:00'}}


async def test_toss_reads_each_order_page_once_for_the_whole_year_including_late_fills_and_empty_pages(tmp_path):
    calls = []

    async def request(method, path, *, account, params):
        assert method == 'GET' and path == '/api/v1/orders' and account == 1
        calls.append(params)
        if params['status'] == 'OPEN':
            return {'orders': [order('one', '2026-10-28', '20')], 'hasNext': False}
        if params.get('cursor'):
            return {'orders': [order('last-year', '2025-11-01')], 'hasNext': False}
        utc = order('utc', '2026-10-28')
        utc['execution']['filledAt'] = '2026-10-28T01:10:00Z'
        return {'orders': [order('one', '2026-10-28'), utc, order('outside', '2024-10-28')],
            'hasNext': True, 'nextCursor': 'older'}

    adapter = SimpleNamespace(authorize=AsyncMock(return_value=1),
        reference=lambda ref, native, date: native,
        service=SimpleNamespace(_client=lambda: SimpleNamespace(request=request)))
    service = SimpleNamespace(toss=adapter, resolve=AsyncMock(return_value=adapter),
        legacy=SimpleNamespace(start_events=lambda: None, events_connected=True),
        execution_range=ExecutionHistoryRange(tmp_path))
    app = FastAPI()
    app.include_router(build_router(service))
    params = {**PARAMS, 'from_date': '20251028'}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as api:
        first = (await api.get('/api/trading/v2/execution-history-range', params=params)).json()
        assert len(first['rows']) == 1
        assert first['rows'][0]['date'] == '20261028'
        assert first['rows'][0]['filled_at'] == '2026-10-28T01:10:00Z'
        second = (await api.get('/api/trading/v2/execution-history-range', params={
            **params, 'next_key': first['next_key']})).json()
        assert second['rows'][0]['date'] == '20251101' and second['next_key'] is None
    assert len(calls) == 3  # CLOSED+OPEN once, then only the next CLOSED page; no 365 daily walks.
