"""Exploratory memory measurement; local stored data, no vendor credentials.
RSS observations are not a regression test for the September 28 OOM.
"""
import gc,json,os,sys,tempfile,time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[4]))
from hoga.api.queries import QueryEngine
from hoga.tables.candles import query_all
from hoga.gc_tuning import gc_thresholds

def rss():
    return int(Path('/proc/self/statm').read_text().split()[1])*os.sysconf('SC_PAGE_SIZE')/2**20
with tempfile.TemporaryDirectory(prefix='hoga-memory-') as tmp:
    os.environ['HOGA_DUCKDB_MEMORY_LIMIT']='512 MiB'
    engine=QueryEngine(Path.home()/'.local/share/hoga-ops/data',temp_directory=Path(tmp))
    engine.conn.execute('SET threads TO 2')
    gc.set_threshold(*gc_thresholds())
    path=engine.data_dir/'parquet/20260923/005930/hogaplay/candles.parquet'
    start=rss()
    for i in range(1001):
        rows=query_all(engine.conn,path=path,ts_offset_ms=0)
        del rows
        if i%100==0:
            print(json.dumps({'iteration':i,'rss_mib':round(rss(),1),'gc':gc.get_count()}),flush=True)
        if rss()>2500:
            break
    before=rss(); collected=gc.collect(); after=rss()
    print(json.dumps({'start_mib':start,'before_gc_mib':before,'after_gc_mib':after,'collected':collected}),flush=True)
