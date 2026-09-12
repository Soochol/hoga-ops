import httpx
import pytest

from hoga.live import provider_errors as errors
from hoga.live.kiwoom_errors import KiwoomApiError, KiwoomAuthTransientError, KiwoomTransportError
from hoga.live.kiwoom_rest import KiwoomRestClient
from hoga.live.kiwoom_token_provider import KiwoomAuthTransient


@pytest.fixture(autouse=True)
def reset():
    errors._observations.clear()
    yield
    errors._observations.clear()


@pytest.mark.parametrize(('exc', 'kind'), [
    (KiwoomApiError('HTTP/401', 'SECRET'), 'auth'),
    (KiwoomApiError('HTTP/429', 'SECRET'), 'rate_limit'),
    (KiwoomApiError('HTTP/503', 'SECRET'), 'server'),
    (KiwoomApiError('HTTP/400', 'SECRET'), 'request'),
    (KiwoomTransportError(httpx.ReadTimeout('SECRET')), 'timeout'),
    (KiwoomTransportError(httpx.ConnectError('SECRET')), 'transport'),
    (RuntimeError('점검중 SECRET'), 'unknown'),
])
def test_classification_without_message_guessing(exc, kind):
    assert errors.classify(exc)[0] == kind


def test_token_server_error_not_bad_credentials():
    inner = KiwoomAuthTransient('SECRET', http_status=503)
    outer = KiwoomAuthTransientError('SECRET')
    outer.__cause__ = inner
    assert errors.classify(outer) == ('server', '503')


class Provider:
    def get_token(self):
        return 'SECRET'


async def test_actual_rest_request_failures_are_visible_and_scoped():
    failing = True

    def handler(request):
        if failing:
            return httpx.Response(503, text='SECRET')
        return httpx.Response(200, json={'return_code': 0, 'cur_prc': '100'})

    client = KiwoomRestClient(Provider(), transport=httpx.MockTransport(handler))
    other = KiwoomRestClient(Provider(), transport=httpx.MockTransport(handler))
    try:
        for instance in (client, other):
            with pytest.raises(KiwoomApiError):
                await instance.call('ka10001', {'stk_cd': '005930'})
        assert errors.failures()[0].kind == 'server'
        assert 'SECRET' not in errors.failures()[0].model_dump_json()
        failing = False
        await client.call('ka10001', {'stk_cd': '005930'})
        assert errors.failures()  # Another account is still failed.
        await other.call('ka10001', {'stk_cd': '005930'})
        assert errors.failures() == []
    finally:
        await client.aclose()
        await other.aclose()


def test_out_of_order_completion_does_not_clear_newer_failure():
    owner = Provider()
    old = errors.begin(owner, 'ka10001')
    new = errors.begin(owner, 'ka10001')
    errors.finish(owner, 'ka10001', new, 'rest', TimeoutError())
    errors.finish(owner, 'ka10001', old, 'rest')
    assert errors.failures()[0].kind == 'timeout'
