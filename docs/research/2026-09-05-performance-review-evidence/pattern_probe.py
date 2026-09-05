import dataclasses
import json
import statistics
import sys
import time
from pathlib import Path
from unittest.mock import patch

import numpy as np

from hoga.api import screener_pattern as sp

S, N, L, KEEP = 100, 10_000, 15, 252
periods = (5, 20) if '--ma-short' in sys.argv else ()
rng = np.random.default_rng(20260905)
close = rng.normal(0, .004, (S, N)).cumsum(axis=1)
close -= close.mean(axis=1, keepdims=True)
op = close + rng.normal(0, .002, (S, N))
ch = np.stack([op, np.maximum(op, close) + .003,
               np.minimum(op, close) - .003, close]).reshape(4, -1)
dates = np.tile(np.arange(N).astype('timedelta64[D]') + np.datetime64('2000-01-01'), S)
c = sp.Corpus(path=Path('/synthetic-only'), mtime_ns=0,
    codes=np.array([f'{i:06}' for i in range(S)]),
    starts=np.arange(S) * N, ends=(np.arange(S) + 1) * N,
    ch=ch, logv=np.zeros(S*N), ma={}, centers=np.zeros(S),
    tv=np.full(S*N, 1e12), dates=dates, first_days=dates, last_days=dates,
    bucket_days=np.ones(S*N, dtype=np.int8), names={}, is_etf={},
    last_date=dates.max(), last_trading_day=dates.max())
if periods:
    c.ma = sp._build_ma(c.ch, c.starts, c.ends, c.centers)
q = sp.query_vector(c, 0, N-L, L, periods)
since = dates[N-KEEP]
args = dict(query=q, length=L, query_series=0, query_offset=N-L,
            min_tv_eok=0, exclude_etf=False, min_after=20, no_overlap=False,
            since=since, ma_periods=periods)

# Proof of reduced input, limited to daily / structure-off case.
# Keeps the original centering; offsets are translated for result comparison.
retained = KEEP + (max(periods) if periods else 0)
cut = N-retained
idx = (np.arange(S)[:, None]*N + np.arange(cut,N)).ravel()
small = dataclasses.replace(c, starts=np.arange(S)*retained, ends=(np.arange(S)+1)*retained,
    ch=c.ch[:, idx], logv=c.logv[idx], tv=c.tv[idx], dates=c.dates[idx],
    first_days=c.first_days[idx], last_days=c.last_days[idx], bucket_days=c.bucket_days[idx],
    ma={p:v[idx] for p,v in c.ma.items()})

seen = []
orig = np.correlate
def count(a,b,*args,**kwargs):
    seen.append(len(a))
    return orig(a,b,*args,**kwargs)
with patch.object(np, 'correlate', count):
    full_result = sp.search_history(c, **args)
full_work = sum(seen)
seen.clear()
with patch.object(np, 'correlate', count):
    small_result = sp.search_history(small, **{**args, 'query_offset':retained-L})
small_work = sum(seen)
assert [(m.series,m.offset) for m in full_result[0]] == [(m.series,m.offset+cut) for m in small_result[0]]
for a,b in zip(full_result[1:],small_result[1:],strict=True):
    np.testing.assert_allclose(a,b,atol=1e-8,rtol=1e-8)
np.testing.assert_allclose([m.score for m in full_result[0]], [m.score for m in small_result[0]],atol=1e-8,rtol=1e-8)
timings = {'current':[], 'sliced_prototype':[]}
for i in range(7):
    cases = [('current',c,args), ('sliced_prototype',small,{**args,'query_offset':retained-L})]
    if i%2:
        cases.reverse()
    for name, corpus, kw in cases:
        start=time.perf_counter()
        sp.search_history(corpus, **kw)
        timings[name].append((time.perf_counter()-start)*1000)
print(json.dumps({'symbols':S,'bars_per_symbol':N,'selected_tail_bars':KEEP,'length':L,
    'ma_periods':periods, 'retained_bars_with_warmup':retained,
    'kernel_input_elements':{'current':full_work,'sliced_prototype':small_work},
    'candidate_scores':len(full_result[1]),'matching_offsets_and_scores':True,
    'median_ms':{k:statistics.median(v) for k,v in timings.items()},'trials_ms':timings}))
