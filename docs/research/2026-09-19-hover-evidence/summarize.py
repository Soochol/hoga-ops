"""Aggregate repeated browser measurements; seconds in CDP become ms here."""
import json
import statistics
import sys
from pathlib import Path

source = Path(sys.argv[1])
data = json.loads(source.read_text())
rows = []
for tf, scenario in dict.fromkeys((r['tf'], r['scenario']) for r in data['results']):
    runs = [r for r in data['results'] if (r['tf'], r['scenario']) == (tf, scenario)]
    # First rAF delta starts between frames. Exclude that partial interval.
    frames = sorted(v for r in runs for v in r['frames'][1:] if v > 0)
    row = {'timeframe': tf, 'scenario': scenario, 'runs': len(runs)}
    for key in ['TaskDuration', 'ScriptDuration', 'LayoutDuration']:
        values = [r[key] * 1000 for r in runs]
        row[key + 'Ms'] = round(statistics.median(values), 2)
        row[key + 'RangeMs'] = [round(min(values), 2), round(max(values), 2)]
    for key in ['dataCalls', 'dataRows', 'dataMs', 'rectReads', 'LayoutCount', 'crosshairEvents', 'cursorUpdates']:
        row[key] = round(statistics.median(r[key] for r in runs), 2)
    row.update(frameP95Ms=round(frames[int(len(frames) * .95)], 2), frameMaxMs=round(max(frames), 2),
               framesOver25Ms=sum(v > 25 for v in frames), frameSamples=len(frames),
               longTasks=sum(len(r['longTasks']) for r in runs), tooltips=[r['tooltips'] for r in runs])
    if 'formatCalls' in runs[0]:
        for key in ['formatCalls', 'sidebarUpdates', 'investorRows', 'programRows']:
            row[key] = statistics.median(r[key] for r in runs)
        row['scrollWrites'] = [len(r['scrollWrites']) for r in runs]
        row['requests'] = [len(r['requests']) for r in runs]
    rows.append(row)
print(json.dumps({'source': source.name, 'browser': data['browser'], 'cpuThrottle': data.get('cpuThrottle', 1), 'rows': rows}, indent=2))
