from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi import FastAPI

from hoga.api.trading_v2_routes import build_router
from hoga.trading.executions import cursor_value, next_token
from hoga.trading.toss import TradingError

REF = 'acc_' + 'a' * 32
DATE = '20261028'


def order(native='one', qty='30', status='PARTIAL_FILLED', clock='2026-10-28T10:00:01+09:00'):
    return {'orderId': native, 'symbol': '007810', 'side': 'BUY', 'orderType': 'LIMIT',
            'timeInForce': 'DAY', 'status': status, 'price': '80500', 'quantity': '100',
            'currency': 'KRW', 'orderedAt': '2026-10-28T10:00:00+09:00',
            'execution': {'filledQuantity': qty, 'averageFilledPrice': '80400',
                          'filledAmount': str(int(qty) * 80400), 'filledAt': clock}}


async def test_toss_open_partial_cancelled_completed_and_cursor_are_preserved_without_duplicates():
    calls = []

    async def request(method, path, *, account, params):
        assert method == 'GET' and path == '/api/v1/orders' and account == 1
        calls.append(params)
        if params['status'] == 'OPEN':
            return {'orders': [order(), order('zero', '0')], 'hasNext': False}
        if params.get('cursor'):
            return {'orders': [order('older', '12', 'FILLED')], 'hasNext': False}
        return {'orders': [order(), order('cancelled', '20', 'CANCELED'),
                           order('yesterday', '12', 'FILLED', '2026-10-27T10:00:01+09:00')],
                'hasNext': True, 'nextCursor': 'vendor+/cursor='}

    adapter = SimpleNamespace(authorize=AsyncMock(return_value=1),
                              reference=lambda ref, native, date: 'ref-' + native,
                              service=SimpleNamespace(_client=lambda: SimpleNamespace(request=request)))
    service = SimpleNamespace(toss=adapter, resolve=AsyncMock(return_value=adapter),
                              legacy=SimpleNamespace(start_events=lambda: None, events_connected=True))
    app = FastAPI()
    app.include_router(build_router(service))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as api:
        first = await api.get('/api/trading/v2/execution-history', params={'account_ref': REF, 'date': DATE})
        assert first.status_code == 200, first.text
        data = first.json()
        assert {r['order_ref'] for r in data['rows']} == {'ref-one', 'ref-cancelled'}
        assert data['rows'][0]['filled_at'] == '2026-10-28T10:00:01+09:00'
        assert data['rows'][0]['price_basis'] == 'average'
        assert data['events_connected'] is True
        token = data['next_key']
        assert cursor_value(token, REF, DATE) == 'vendor+/cursor='
        second = await api.get('/api/trading/v2/execution-history', params={
            'account_ref': REF, 'date': DATE, 'next_key': token})
        assert second.status_code == 200
        assert second.json()['rows'][0]['quantity'] == '12'
        assert second.json()['next_key'] is None
    assert len(calls) == 3  # OPEN is never re-fetched for older CLOSED pages.


@pytest.mark.parametrize('other_account,other_date', [(REF, '20261027'), ('acc_' + 'b' * 32, DATE)])
def test_continuation_token_cannot_cross_account_or_date(other_account, other_date):
    token = next_token('opaque', REF, DATE)
    with pytest.raises(TradingError):
        cursor_value(token, other_account, other_date)
