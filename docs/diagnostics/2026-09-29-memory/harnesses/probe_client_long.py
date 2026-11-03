"""Exploratory memory measurement; local stored data, no vendor credentials.
RSS observations are not a regression test for the September 28 OOM.
"""
import gc,httpx,json,os,sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[4]))
from hoga.collector.client import HogaplayClient
from hoga.gc_tuning import gc_thresholds

def rss():return int(Path('/proc/self/statm').read_text().split()[1])*os.sysconf('SC_PAGE_SIZE')/2**20
body='1\t005930\t090001001\t123456\t10000\t12345\n'*3000

def respond(request):return httpx.Response(200,content=body.encode())
gc.set_threshold(*gc_thresholds())
with HogaplayClient('',transport=httpx.MockTransport(respond)) as client:
 start=rss()
 for i in range(40000):
  text=client.fetch_first('005930','20260928',90000000); del text
  if i%5000==0:print(json.dumps({'i':i,'rss_mib':rss(),'gc':gc.get_count()}),flush=True)
  if rss()>2500:break
 before=rss(); collected=gc.collect();after=rss()
 print(json.dumps({'start_mib':start,'before_gc_mib':before,'after_gc_mib':after,'collected':collected}),flush=True)
