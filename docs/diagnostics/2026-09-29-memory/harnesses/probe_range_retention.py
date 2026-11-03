"""Exploratory memory measurement; local stored data, no vendor credentials.
RSS observations are not a regression test for the September 28 OOM.
"""
import gc,json,os,sys,tempfile,time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[4]))
os.environ['HOGA_DUCKDB_MEMORY_LIMIT']='512 MiB'
os.environ['HOGA_COMPUTE_DUCKDB_THREADS']='2'
from hoga.api.compute_jobs import range_bundle_job
from hoga.gc_tuning import gc_thresholds

def rss():
 return int(Path('/proc/self/statm').read_text().split()[1])*os.sysconf('SC_PAGE_SIZE')/2**20
with tempfile.TemporaryDirectory(prefix='hoga-range-memory-') as tmp:
 root=Path(tmp); os.environ['HOGA_DATA_DIR']=tmp
 source=Path.home()/'.local/share/hoga-ops/data/parquet'
 codes=['005930']
 dates=sorted(d.name for d in source.iterdir() if d.is_dir() and '20260820'<=d.name<='20260923')
 for date in dates:
  for code in codes:
   p=source/date/code
   if p.is_dir():
    dest=root/'parquet'/date/code; dest.parent.mkdir(parents=True,exist_ok=True); dest.symlink_to(p,target_is_directory=True)
 gc.set_threshold(*gc_thresholds())
 start=rss(); warm=None
 for i in range(3):
  code=codes[0]; mode='sidecar'
  t=time.monotonic()
  body,stats=range_bundle_job(tmp,dict(code=code,from_date=dates[0],to_date=dates[-1],bucket_ms=60000,mode=mode,venue='KRX',source_pref='hogaplay'))
  size=len(body); del body,stats
  print(json.dumps({'i':i,'mode':mode,'code':code,'seconds':round(time.monotonic()-t,2),'rss_mib':round(rss(),1),'bytes':size}),flush=True)
  if i==0: warm=rss()
  if rss()>6000: break
 before=rss(); collected=gc.collect(); after=rss()
 import ctypes,pyarrow as pa
 from hoga.api.compute_jobs import _engines
 from hoga.tables.snapshots import _query_at_cache
 engine=_engines[tmp]
 print('cache_sizes',engine.indicators_cache.stats_snapshot(),flush=True)
 print('arrow_bytes',pa.total_allocated_bytes(),'snapshot_index',len(_query_at_cache),flush=True)
 print('duck_memory',engine.conn.execute('SELECT * FROM duckdb_memory()').fetchall(),flush=True)
 ctypes.CDLL(None).malloc_trim(0)
 print('trim_mib',rss(),flush=True)
 pa.default_memory_pool().release_unused()
 print('arrow_release_mib',rss(),flush=True)
 for od in engine.indicators_cache._all_mem_dicts: od.clear()
 _query_at_cache.clear(); gc.collect(); ctypes.CDLL(None).malloc_trim(0);pa.default_memory_pool().release_unused()
 print('cleared_cache_mib',rss(),flush=True)
 print(json.dumps({'start_mib':start,'warm_mib':warm,'before_gc_mib':before,'after_gc_mib':after,'collected':collected}),flush=True)
