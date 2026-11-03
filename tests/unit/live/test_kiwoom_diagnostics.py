import pytest

from hoga.live import kiwoom_diagnostics as M


def test_failure_window_keeps_units_and_cpu_scope_explicit(monkeypatch):
    process, thread = [1.0], [0.5]
    monkeypatch.setattr(M.time, "process_time", lambda: process[0])
    monkeypatch.setattr(M.time, "thread_time", lambda: thread[0])
    flow = M.QueueFlowEvidence(0.0)
    flow.receive(4, 0.0)
    flow.start_frame(4, 0.0)
    flow.tick()
    process[0], thread[0] = 1.2, 0.55
    snap = flow.snapshot(2.0)
    assert snap['received_frames'] == 1
    assert snap['received_raw_rows'] == 4
    assert snap['processed_ticks'] == 1
    assert snap['completed_frames'] == 0
    assert snap['input_frames_per_s'] == 0.5
    assert snap['inflight_age_ms'] == 2000
    assert snap['process_cpu_ms'] == 200
    assert snap['loop_thread_cpu_ms'] == 50
    flow.complete_frame(2.0)
    assert flow.snapshot(2.0)['inflight_age_ms'] == 0


def test_samples_are_bounded_and_old_history_expires():
    flow = M.QueueFlowEvidence(0.0)
    for second in range(100):
        flow.receive(1, float(second))
        flow.complete_frame(float(second))
    snap = flow.snapshot(100.0)
    assert len(flow._samples) <= 12
    assert snap['window_ms'] == 10000
    assert snap['received_frames'] == 100
    assert snap['recent_received_frames'] == 10
    assert snap['recent_completed_frames'] == 10


def test_context_failure_does_not_leak_exception_text_or_mask_overload():
    def broken():
        raise RuntimeError('SECRET')
    M.configure_failure_context(broken)
    try:
        assert M.failure_context() == {'runtime_context_error': 'RuntimeError'}
    finally:
        M.configure_failure_context(None)


def test_exception_projection_ignores_properties_messages_cycles_and_deep_chains():
    from hoga.live import kiwoom_failure_evidence as F

    touched = []

    class Hostile(OSError):
        def forbidden(self):
            touched.append(True)
            raise AssertionError('SECRET')
        errno = property(forbidden)
        __cause__ = property(forbidden)
        __context__ = property(forbidden)
        __suppress_context__ = property(forbidden)
        __dict__ = property(forbidden)
        code = property(forbidden)
        reason = property(forbidden)
        __str__ = forbidden
        __repr__ = forbidden

    exc = Hostile(111, 'SECRET endpoint token account')
    F.annotate_failure(exc, 'receive', 4)
    BaseException.__cause__.__set__(exc, exc)
    evidence = F.FailureEvidence.capture(exc, lambda: {})
    assert evidence.snapshot()['failure'] == {
        'phase': 'receive', 'causes': [{'type': 'OSError', 'errno': 111}], 'cause_stop': 'cycle',
        'close': {'state': 'unavailable'},
    }
    assert touched == []
    assert 'SECRET' not in evidence.encoded
    from hoga.live import provider_errors
    assert provider_errors.classify(F.provider_exception(exc)) == ('transport', None)
    assert touched == []
    node = RuntimeError('SECRET')
    for _ in range(12):
        wrapper = RuntimeError('SECRET')
        wrapper.__cause__ = node
        node = wrapper
    projected = F.exception_projection(node)
    assert len(projected['causes']) == 8
    assert projected['cause_stop'] == 'depth_limit'
    explicit, context = TimeoutError(), OSError(111, 'SECRET')
    top = RuntimeError()
    top.__cause__, top.__context__ = explicit, context
    assert F.exception_projection(top)['causes'][-1]['type'] == 'TimeoutError'
    top.__cause__ = None
    top.__suppress_context__ = False
    assert F.exception_projection(top)['causes'][-1]['errno'] == 111
    top.__suppress_context__ = True
    assert len(F.exception_projection(top)['causes']) == 1


def test_close_projection_only_supports_standard_frames_and_never_reasons():
    import json

    from websockets.exceptions import ConnectionClosedError
    from websockets.frames import Close, CloseCode

    from hoga.live import kiwoom_failure_evidence as F

    exc = ConnectionClosedError(Close(1001, 'SECRET url'), Close(CloseCode.GOING_AWAY, 'SECRET'), True)
    snap = F.exception_projection(exc)
    assert snap['close'] == {'state': 'available', 'rcvd': {'present': True, 'code': 1001},
                             'sent': {'present': True, 'code': 1001}, 'received_then_sent': True}
    assert 'SECRET' not in json.dumps(snap)
    no_frame = F.close_projection(ConnectionClosedError(None, None))
    assert no_frame['rcvd'] == {'present': False, 'code': None}

    class Frame:
        @property
        def code(self):
            raise AssertionError('getter executed')
    exc.rcvd = Frame()
    assert F.close_projection(exc) == {'state': 'unavailable'}


def test_runtime_whitelist_primitive_validation_and_detachment():
    import json

    from hoga.live import kiwoom_failure_evidence as F

    class CustomInt(int):
        def __float__(self):
            raise AssertionError('conversion')

    class CustomDict(dict):
        def get(self, *_args):
            raise AssertionError('getter')

    runtime = {'commit': 'a' * 40, 'collector_epoch': 'b' * 32, 'live_started_at_ms': 42,
               'collector_started_at_ms': True, 'secret': 'SECRET',
               'gc': {'enabled': True, 'thresholds': [1, True, CustomInt(2), 'SECRET'],
                      'by_generation': {'0': {'max_ms': 3, 'extra': 'SECRET'},
                                        '1': CustomDict(max_ms='SECRET'), '9': {'max_ms': 99}},
                      'interpreter_stats': [{'collections': 5, 'extra': 'SECRET'}] * 10}}
    projected = F.runtime_projection(runtime)
    assert projected['collector_started_at_ms'] is None
    assert projected['gc']['thresholds'] == [1, None, None]
    assert projected['gc']['by_generation'] == {'0': {'max_ms': 3}, '1': {}}
    assert len(projected['gc']['interpreter_stats']) == 3
    evidence = F.FailureEvidence.capture(RuntimeError('SECRET'), lambda: {'runtime': projected})
    runtime['gc']['by_generation']['0']['max_ms'] = 100
    projected['commit'] = 'SECRET'
    detached = evidence.snapshot()
    detached['runtime']['commit'] = 'SECRET'
    assert evidence.snapshot()['runtime']['commit'] == 'a' * 40
    assert 'SECRET' not in evidence.encoded
    assert F.integer(True) is None
    assert F.integer(CustomInt(1)) is None
    assert F.integer(2**63) is None
    for value in (float('inf'), float('nan'), 10**999, CustomInt(1), True, -1):
        assert F.number(value) is None
    assert 'SECRET' not in json.dumps(F.runtime_projection({'commit': 'SECRET', 'gc': CustomDict()}))


@pytest.mark.parametrize('commit', ['abc1234', '8eaca2cf3', 'aB09' * 10, 'aB09' * 16])
def test_runtime_projection_preserves_hex_commits(commit):
    from hoga.live import kiwoom_failure_evidence as F

    assert F.runtime_projection({'commit': commit}) == {'commit': commit}


@pytest.mark.parametrize('length', [0, 1, 6, *range(41, 64), 65, 4096])
def test_runtime_projection_rejects_invalid_commit_lengths(length):
    from hoga.live import kiwoom_failure_evidence as F

    assert F.runtime_projection({'commit': 'a' * length}) == {}


@pytest.mark.parametrize('length', [7, 9, 31, 32, 33, 40, 64])
def test_runtime_projection_epoch_requires_exactly_32_hex_characters(length):
    from hoga.live import kiwoom_failure_evidence as F

    epoch = 'b' * length
    assert F.runtime_projection({'collector_epoch': epoch}) == (
        {'collector_epoch': epoch} if length == 32 else {})


@pytest.mark.parametrize('value', [
    'SECRET', 'unknown', 'SECRET token account endpoint', 'g' * 7, 'g' * 32,
    'g' * 40, 'g' * 64, 'a' * 6 + '\n', 'a' * 7 + '\n', ' aaaaaaa',
    'ａ' * 7, b'abc1234', None, True, 1234567,
])
@pytest.mark.parametrize('key', ['commit', 'collector_epoch'])
def test_runtime_projection_rejects_nonhex_or_nonstring_identifiers(key, value):
    from hoga.live import kiwoom_failure_evidence as F

    assert F.runtime_projection({key: value}) == {}


@pytest.mark.parametrize('key', ['commit', 'collector_epoch'])
def test_runtime_projection_rejects_nonstandard_identifiers_without_conversion(key):
    from hoga.live import kiwoom_failure_evidence as F

    class Hostile:
        def forbidden(self, *_args):
            raise AssertionError('conversion executed')

        __str__ = forbidden
        __repr__ = forbidden
        __len__ = forbidden

    class CustomString(str):
        __str__ = Hostile.forbidden
        __repr__ = Hostile.forbidden
        __len__ = Hostile.forbidden

    for value in (Hostile(), CustomString('a' * 7), CustomString('b' * 32), CustomString('c' * 64)):
        assert F.runtime_projection({key: value}) == {}


def test_snapshot_size_and_extraction_fallback_preserve_original_phase():
    from hoga.live import kiwoom_failure_evidence as F

    exc = TimeoutError('SECRET')
    F.annotate_failure(exc, 'REG', 10)
    large = F.FailureEvidence.capture(exc, lambda: {'extra': 'x' * 65536})
    assert large.snapshot()['diagnostics'] == 'size_limit'
    assert len(large.encoded.encode()) <= 65536
    assert large.snapshot()['failure']['phase'] == 'REG'
    for build in (lambda: {'bad': object()}, lambda: {'bad': float('nan')}, lambda: 1 / 0):
        snap = F.FailureEvidence.capture(exc, build).snapshot()
        assert snap['diagnostics'] == 'unavailable'
        assert snap['failure']['phase'] == 'REG'


def test_provider_observation_preserves_supported_taxonomy_and_metadata():
    import httpx
    from websockets.exceptions import ConnectionClosedError
    from websockets.frames import Close

    from hoga.live import kiwoom_errors as E, kiwoom_failure_evidence as F, provider_errors as P
    from hoga.live.kiwoom_token_provider import KiwoomAuthError, KiwoomAuthTransient

    errors = [TimeoutError(), OSError(111, 'SECRET'), ConnectionClosedError(Close(1006, 'SECRET'), None),
              E.KiwoomAuthError('SECRET'), E.KiwoomAuthTransientError('SECRET'),
              E.KiwoomRateLimitError('SECRET'), E.KiwoomApiError(7, 'SECRET'),
              E.KiwoomApiError(1, 'SECRET [1504:'),
              *[E.KiwoomApiError(f'HTTP/{status}', 'SECRET') for status in (400, 401, 429, 503)],
              E.KiwoomTransportError(httpx.ReadTimeout('SECRET')),
              E.KiwoomTransportError(httpx.ConnectError('SECRET')), E.KiwoomBatchLimitError(5, 'SECRET'),
              E.KiwoomTerminalAuthError(9, 'SECRET'), KiwoomAuthError('SECRET', http_status=401),
              KiwoomAuthTransient('SECRET', http_status=503), httpx.ReadTimeout('SECRET'),
              httpx.ConnectError('SECRET')]
    wrapped = KiwoomAuthTransient('SECRET')
    wrapped.__cause__ = TimeoutError('SECRET')
    errors.append(wrapped)

    class Owner:
        account_id = 3
        connection_generation = 9
    owner = Owner()
    try:
        for exc in errors:
            F.annotate_failure(exc, 'REG', 12)
            proxy = F.provider_exception(exc)
            assert P.classify(proxy) == P.classify(exc)
            generation = P.begin(owner, 'session')
            P.finish(owner, 'session', generation, 'ws', proxy)
            observation = next(f for f in P.failures() if f.account_id == 3)
            assert (observation.kind, observation.code) == P.classify(exc)
            assert observation.phase == 'REG'
            assert observation.elapsed_ms == 12
            assert 'SECRET' not in observation.model_dump_json()
    finally:
        P.clear(owner)


@pytest.mark.parametrize('representation', ['httpx', 'websockets'])
@pytest.mark.parametrize(('status', 'kind'), [(400, 'request'), (401, 'auth'), (403, 'auth'),
                                            (429, 'rate_limit'), (503, 'server')])
def test_response_status_survives_real_client_provider_observation(representation, status, kind):
    import asyncio

    import httpx
    from websockets.datastructures import Headers
    from websockets.exceptions import InvalidStatus
    from websockets.http11 import Response

    from hoga.live import kiwoom_failure_evidence as F, kiwoom_ws_client as W, provider_errors as P

    if representation == 'httpx':
        exc = httpx.HTTPStatusError('SECRET', request=httpx.Request('GET', 'https://SECRET.invalid'),
                                    response=httpx.Response(status, text='SECRET'))
    else:
        exc = InvalidStatus(Response(status, 'SECRET', Headers({'SECRET': 'SECRET'}), b'SECRET'))
    instance = W.KiwoomWsClient(token_fn=lambda: asyncio.sleep(0, result='SECRET'), on_tick=None,
                               account_id=3, date_fn=lambda: '20261001')
    instance.connection_generation = 9
    instance._error_generation = P.begin(instance, 'session')
    F.annotate_failure(exc, 'connect', 12.5)
    try:
        assert P.classify(exc) == P.classify(F.provider_exception(exc)) == (kind, str(status))
        instance._record_provider_failure(exc)
        observation = next(f for f in P.failures() if f.account_id == 3)
        assert (observation.kind, observation.code) == (kind, str(status))
        assert (observation.phase, observation.elapsed_ms) == ('connect', 12.5)
        assert (observation.account_id, observation.connection_generation) == (3, 9)
        assert 'SECRET' not in observation.model_dump_json()
        assert exc.response.status_code == status
        assert (exc._kiwoom_phase, exc._kiwoom_elapsed_ms) == ('connect', 12.5)
    finally:
        P.clear(instance)


def test_provider_response_projection_rejects_getters_and_nonprimitive_statuses():
    import httpx
    from websockets.http11 import Response

    from hoga.live import kiwoom_failure_evidence as F, provider_errors as P

    touched = []

    def forbidden(_self):
        touched.append(True)
        raise AssertionError('SECRET getter')

    class HostileException(Exception):
        response = property(forbidden)

    class HostileResponse:
        status_code = property(forbidden)

    class HostileHttpxResponse(httpx.Response):
        status_code = property(forbidden)

    class HostileWsResponse(Response):
        status_code = property(forbidden)

    class CustomInt(int):
        __str__ = forbidden

    exc = HostileException()
    assert P.classify(F.provider_exception(exc)) == ('unknown', None)
    for response in (HostileResponse(), object.__new__(HostileHttpxResponse),
                     object.__new__(HostileWsResponse)):
        F.exception_data(exc)['response'] = response
        assert P.classify(F.provider_exception(exc)) == ('unknown', None)
    for status in (True, CustomInt(401), '401', 2**63):
        response = httpx.Response(200)
        response.status_code = status
        F.exception_data(exc)['response'] = response
        assert P.classify(F.provider_exception(exc)) == ('unknown', None)
    assert touched == []


def test_response_status_keeps_classifier_precedence_and_cause_semantics():
    import httpx

    from hoga.live import kiwoom_failure_evidence as F, provider_errors as P

    response_error = httpx.HTTPStatusError('SECRET', request=httpx.Request('GET', 'https://SECRET.invalid'),
                                          response=httpx.Response(401))
    response_error.http_status = 503
    assert P.classify(F.provider_exception(response_error)) == P.classify(response_error) == ('auth', '401')
    wrapper = RuntimeError('SECRET')
    wrapper.__cause__ = response_error
    assert P.classify(F.provider_exception(wrapper)) == P.classify(wrapper) == ('server', '503')
    del response_error.http_status
    assert P.classify(F.provider_exception(wrapper)) == P.classify(wrapper) == ('unknown', None)


async def test_loop_lifecycle_samples_bound_and_retained_window(monkeypatch):
    import asyncio

    recorder = M.LoopLagEvidence()
    assert recorder.snapshot()['state'] == 'unobserved'
    assert recorder.snapshot()['pending_overdue_ms'] is None
    clock = [0.0]
    original_sleep = asyncio.sleep
    calls = 0

    async def sleep(interval):
        nonlocal calls
        calls += 1
        clock[0] += interval + 0.25
        if calls == 41:
            raise asyncio.CancelledError
        await original_sleep(0)

    recorder = M.LoopLagEvidence(clock=lambda: clock[0])
    monkeypatch.setattr(M.asyncio, 'sleep', sleep)
    import pytest
    with pytest.raises(asyncio.CancelledError):
        await recorder.run()
    snap = recorder.snapshot()
    assert snap['state'] == 'stopped'
    assert snap['pending_deadline'] is None and snap['pending_overdue_ms'] is None
    assert len(snap['samples']) == 32
    assert snap['samples'][0]['at'] == 11.25
    assert snap['window_ms'] == 31 * 1250
    assert snap['max_ms'] == snap['latest_ms'] == 250


async def test_loop_probe_failure_is_explicit_and_clears_pending_deadline(monkeypatch):
    async def broken_sleep(_interval):
        raise RuntimeError('SECRET')
    monkeypatch.setattr(M.asyncio, 'sleep', broken_sleep)
    recorder = M.LoopLagEvidence()
    await recorder.run()
    assert recorder.snapshot()['state'] == 'failed'
    assert recorder.snapshot()['pending_overdue_ms'] is None


def test_provider_proxy_keeps_context_only_failure_taxonomy_unchanged():
    from hoga.live import kiwoom_failure_evidence as F, provider_errors as P

    exc = RuntimeError('SECRET')
    exc.__context__ = TimeoutError('SECRET')
    assert F.exception_projection(exc)['causes'][-1]['type'] == 'TimeoutError'
    assert P.classify(F.provider_exception(exc)) == P.classify(exc) == ('unknown', None)
    assert F.exception_data(F.provider_exception(exc))['_kiwoom_phase'] is None


def test_serializer_itself_can_fail_without_masking_the_failure(monkeypatch):
    from hoga.live import kiwoom_failure_evidence as F

    def broken(*_args, **_kwargs):
        raise RuntimeError('SECRET serializer')

    exc = TimeoutError('SECRET')
    F.annotate_failure(exc, 'REMOVE', 20)
    monkeypatch.setattr(F.json, 'dumps', broken)
    saved = F.FailureEvidence.capture(exc, lambda: {})
    assert saved.snapshot() == {'diagnostics': 'unavailable',
                               'failure': {'phase': 'REMOVE', 'causes': [], 'cause_stop': 'unavailable'}}


def test_new_duration_recorder_and_serialized_evidence_are_bounded_and_immutable():
    from dataclasses import FrozenInstanceError

    import pytest

    from hoga.live import kiwoom_failure_evidence as F

    progress = M.ProgressEvidence()
    for value in range(100):
        progress.callback_wall.observe(float(value))
    assert progress.snapshot(100)['consumer']['callback_wall'] == {
        'count': 100, 'sample_size': 32, 'p95_ms': 98.0, 'max_ms': 99.0,
    }
    saved = F.FailureEvidence.capture(RuntimeError(), lambda: {})
    with pytest.raises(FrozenInstanceError):
        saved.encoded = 'changed'
