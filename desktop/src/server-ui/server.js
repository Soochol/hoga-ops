const api = window.serverManager;
const supportsStopPlans = typeof api.prepareStop === 'function' && typeof api.confirmStop === 'function';
const byId = id => document.getElementById(id);
const phaseNames = { stopped: '중지됨', starting: '준비 중', running: '실행 중', stopping: '중지 중', error: '확인 필요' };
const timeFormat = new Intl.DateTimeFormat('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3, hourCycle: 'h23' });
let savedUi = {};
try { savedUi = JSON.parse(sessionStorage.getItem('ticklane-server-ui') || '{}') || {}; } catch { /* use defaults */ }
let current;
let previousPhase = savedUi.phase;
let autoOpened = savedUi.autoOpened === true;
let logText;
let logSource = ['backend', 'frontend', 'manager'].includes(savedUi.logSource) ? savedUi.logSource : 'backend';
let rawLogs = savedUi.rawLogs === true;
let logEntries = [];
const logViews = Object.fromEntries(['backend', 'frontend', 'manager'].map(source => [source, { follow: savedUi.follow !== false, scroll: 0, level: 'all', ...savedUi.logViews?.[source] }]));
let openingClient = false;
let preparingStop = false;
let stopPlan;
let restoringUi = true;
byId('log-details').open = savedUi.logsOpen !== false;
byId('follow').checked = logViews[logSource].follow;
byId('log-level').value = logViews[logSource].level;
// Keep the latest line visible when the window or the expanded log panel resizes.
new ResizeObserver(() => {
  if (byId('follow').checked) byId('logs').scrollTop = byId('logs').scrollHeight;
}).observe(byId('logs'));

window.addEventListener('beforeunload', () => {
  try {
    sessionStorage.setItem('ticklane-server-ui', JSON.stringify({
      logSource, rawLogs, logViews: { ...logViews, [logSource]: { follow: byId('follow').checked, scroll: byId('logs').scrollTop, level: byId('log-level').value } },
      phase: previousPhase, autoOpened, logsOpen: byId('log-details').open, follow: byId('follow').checked,
      logScroll: byId('logs').scrollTop, mainScroll: document.querySelector('main').scrollTop,
    }));
  } catch { /* reloading still works when session storage is unavailable */ }
});

function feedback(message) { byId('feedback').textContent = message; byId('feedback').hidden = !message; }
function renderWindowState(state) {
  const label = state.maximized ? '이전 크기로 복원' : '최대화';
  byId('maximize').setAttribute('aria-label', label);
  byId('maximize').title = label;
  byId('maximize').setAttribute('aria-pressed', String(state.maximized));
  byId('maximize-icon').setAttribute('href', state.maximized ? '#icon-restore' : '#icon-maximize');
  byId('minimize').disabled = false;
  byId('maximize').disabled = false;
}
function parseLogs(lines) {
  const entries = [];
  const last = new Map();
  for (const original of lines) {
    const match = /^(\d{4}-\d\d-\d\dT\S+Z) \[([^\]]+)\] (.*)$/.exec(original);
    const label = match?.[2];
    const source = label === '백엔드' ? 'backend' : label === '프론트엔드' ? 'frontend' : 'manager';
    // eslint-disable-next-line no-control-regex -- Strip subprocess ANSI colors for display; copies preserve the original bytes.
    const text = (match?.[3] ?? original).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
    const levelMatch = /^(?:\d{4}-\d\d-\d\d[ T]\S+\s+)?\[?(DEBUG|INFO|WARNING|WARN|ERROR|CRITICAL|FATAL|TRACE)\b[ \]:]*/i.exec(text);
    const level = levelMatch ? /^(ERROR|CRITICAL|FATAL)$/i.test(levelMatch[1]) ? 'ERROR' : /^WARN/i.test(levelMatch[1]) ? 'WARN' : levelMatch[1].toUpperCase() : 'RAW';
    const previous = last.get(source);
    const traceback = text.startsWith('Traceback (most recent call last):');
    if (!levelMatch && previous && (traceback || (previous.tracing && /^(?:\s|[\w.]+(?:Error|Exception):|During handling|The above exception)/.test(text)))) {
      previous.raw.push(original); previous.detail.push(text); previous.tracing = true;
      continue;
    }
    const entry = { source, timestamp: match?.[1], level, message: levelMatch ? text.slice(levelMatch[0].length) : text, raw: [original], detail: [], tracing: traceback };
    entries.push(entry); last.set(source, entry);
  }
  return entries;
}
function visibleLogs() {
  return logEntries.filter(entry => entry.source === logSource && (byId('log-level').value === 'all' || ['WARN', 'ERROR'].includes(entry.level)));
}
function renderLogs(lines, force = false) {
  const next = lines.join('\n');
  if (!force && next === logText) return;
  logText = next;
  logEntries = parseLogs(lines);
  const logs = byId('logs');
  const scrollTop = logs.scrollTop;
  const expanded = new Set([...logs.querySelectorAll('details[open]')].map(detail => detail.dataset.key));
  const fragment = document.createDocumentFragment();
  logs.dataset.raw = String(rawLogs);
  logs.setAttribute('aria-labelledby', `tab-${logSource}`);
  byId('raw-logs').setAttribute('aria-pressed', String(rawLogs));
  for (const tab of document.querySelectorAll('[role="tab"]')) {
    const selected = tab.dataset.source === logSource;
    tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1;
    tab.querySelector('.log-count').textContent = logEntries.filter(entry => entry.source === tab.dataset.source).length;
  }
  const visible = visibleLogs();
  byId('log-count').textContent = `${visible.length} / ${logEntries.filter(entry => entry.source === logSource).length}건`;
  byId('copy-logs').disabled = !visible.length;
  byId('copy-all-logs').disabled = !lines.length;
  for (const entry of visible) {
    const row = document.createElement('article'); row.className = 'log-entry'; row.dataset.level = entry.level;
    const line = document.createElement('div'); line.className = 'log-row';
    const date = new Date(entry.timestamp);
    if (!rawLogs) {
      const time = document.createElement('time'); time.className = 'log-time';
      if (!Number.isNaN(date.getTime())) { time.dateTime = entry.timestamp; time.title = date.toLocaleString('ko-KR'); time.textContent = timeFormat.format(date); }
      else time.textContent = '—';
      const level = document.createElement('span'); level.className = 'log-level'; level.textContent = entry.level;
      line.append(time, level);
    }
    const message = document.createElement('span'); message.className = 'log-message'; message.textContent = rawLogs ? entry.raw.join('\n') : entry.message;
    const copy = document.createElement('button'); copy.className = 'log-copy'; copy.title = '기록 복사 · 오류 상세 포함'; copy.setAttribute('aria-label', '이 기록 복사');
    copy.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#icon-copy"/></svg>';
    copy.addEventListener('click', () => { void copyLogs(entry.raw.join('\n')); });
    line.append(message, copy); row.append(line);
    if (!rawLogs && entry.detail.length) {
      const detail = document.createElement('details'); detail.className = 'log-trace'; detail.dataset.key = entry.raw[0]; detail.open = expanded.has(entry.raw[0]);
      const summary = document.createElement('summary'); summary.textContent = '오류 상세';
      const pre = document.createElement('pre'); pre.textContent = entry.detail.join('\n'); detail.append(summary, pre); row.append(detail);
    }
    fragment.append(row);
  }
  logs.replaceChildren(fragment);
  if (!visible.length) {
    const service = current?.services.find(service => service.id === logSource);
    logs.textContent = service?.owner === 'external' ? '외부에서 실행한 서버의 표준 출력은 이 앱에서 수집하지 않습니다.' : byId('log-level').value === 'issues' ? '표시할 WARN · ERROR 기록이 없습니다. 레벨이 없는 출력은 모든 레벨에서 확인하세요.' : '이 서비스의 수집된 실행 로그가 없습니다.';
  }
  if (byId('follow').checked) logs.scrollTop = logs.scrollHeight;
  else logs.scrollTop = scrollTop;
}
async function copyLogs(text) {
  try {
    if (!api.copyLogs) throw new Error('관리 앱 재실행 필요');
    await api.copyLogs(text);
    byId('copy-fallback').hidden = true;
    byId('log-feedback').textContent = '로그를 복사했습니다. 원래 날짜·시각·출처와 오류 상세를 포함합니다.';
  } catch {
    byId('copy-fallback').hidden = false;
    byId('copy-text').value = text; byId('copy-text').focus(); byId('copy-text').select();
    byId('log-feedback').textContent = '선택된 내용을 복사하세요. 관리 앱을 다시 실행하면 복사 버튼을 바로 사용할 수 있습니다.';
  }
}
function selectLogSource(source) {
  logViews[logSource] = { follow: byId('follow').checked, scroll: byId('logs').scrollTop, level: byId('log-level').value };
  logSource = source;
  byId('follow').checked = logViews[source].follow; byId('log-level').value = logViews[source].level;
  renderLogs(current?.logs ?? [], true);
  if (!byId('follow').checked) byId('logs').scrollTop = logViews[source].scroll;
}

function render(state) {
  current = state;
  const phase = state.phase;
  const running = phase === 'running';
  const hasExternal = state.services.some(service => service.owner === 'external');
  const allExternal = running && state.services.every(service => service.owner === 'external');
  const titles = {
    checking: '서버 상태를 확인하고 있습니다', stopped: '서버가 중지되어 있습니다', starting: '서버를 시작하고 있습니다',
    stopping: '서버를 중지하고 있습니다', running: allExternal ? '실행 중인 서버에 연결했습니다' : '서버가 실행 중입니다', error: '서버를 확인해 주세요',
  };
  const subtitles = {
    stopped: '시작하면 화면 서버와 API 서버를 함께 실행합니다.', starting: '두 서비스가 준비되면 바로 알려드립니다.',
    stopping: '서버의 작업 정리가 끝날 때까지 기다려 주세요.', running: 'Ticklane을 열어 작업을 시작하세요.',
  };
  if (phase === 'stopped' && state.services.some(service => service.phase === 'running')) titles.stopped = '일부 서버가 중지되어 있습니다';
  document.body.dataset.phase = phase;
  byId('headline').textContent = titles[phase] ?? titles.checking;
  byId('message').textContent = subtitles[phase] ?? state.message;
  byId('state-icon').setAttribute('href', `#icon-${({ running: 'check', stopped: 'power', error: 'alert', starting: 'wait', stopping: 'wait', checking: 'wait' })[phase] ?? 'wait'}`);
  byId('primary-label').textContent = running ? 'Ticklane 열기' : phase === 'error' ? '다시 시도' : phase === 'starting' ? '시작 중…' : phase === 'stopping' ? '중지 중…' : phase === 'checking' ? '확인 중…' : '서버 시작';
  byId('primary-icon').setAttribute('href', running ? '#icon-arrow' : '#icon-power');
  byId('primary').disabled = openingClient || (!running && !state.canStart);
  byId('stop').hidden = !state.canStop;
  byId('stop').disabled = !state.canStop || preparingStop;
  byId('stop').textContent = phase === 'starting' ? '시작 취소' : hasExternal ? '모두 중지…' : '서버 중지';
  byId('refresh').disabled = Boolean(state.action);
  const projectName = state.project.split(/[\\/]/).filter(Boolean).pop();
  byId('project').textContent = projectName ? `${projectName} · 로컬 프로젝트` : '로컬 프로젝트';
  byId('project').title = state.project;
  byId('external-note').hidden = !hasExternal;
  byId('external-note').textContent = supportsStopPlans ? '다른 곳에서 실행한 서버입니다. 실행 정보를 확인한 뒤 중지할 수 있습니다.' : '외부 서버 중지를 사용하려면 관리 앱을 완전히 종료한 뒤 다시 실행해 주세요.';
  for (const service of state.services) {
    const row = byId(`service-${service.id}`);
    if (!row) continue;
    row.dataset.phase = service.phase; row.dataset.owner = service.owner ?? '';
    row.querySelector('.phase').textContent = phaseNames[service.phase];
    row.querySelector('.service-status').title = service.message;
    row.querySelector('.address').textContent = `localhost:${service.port}${service.owner ? ` · ${service.owner === 'external' ? '외부 실행' : '앱에서 실행'}` : ''}`;
    row.querySelector('.detail').textContent = service.message;
    row.querySelector('.detail').hidden = service.phase !== 'error';
    let actions = row.querySelector('.service-actions');
    if (!actions) {
      actions = document.createElement('div'); actions.className = 'service-actions';
      const stop = document.createElement('button'); stop.className = 'service-stop'; stop.textContent = '중지…';
      stop.setAttribute('aria-label', `${service.label} 중지`);
      stop.addEventListener('click', () => { void prepareStop([service.id]); });
      const force = document.createElement('button'); force.className = 'service-force danger'; force.textContent = '강제 종료…';
      force.setAttribute('aria-label', `${service.label} 강제 종료`);
      force.addEventListener('click', () => { void prepareStop([service.id], true); });
      actions.append(stop, force); row.append(actions);
    }
    actions.hidden = !supportsStopPlans;
    actions.querySelector('.service-stop').hidden = !service.owner;
    actions.querySelector('.service-stop').disabled = Boolean(state.action) || preparingStop;
    actions.querySelector('.service-force').hidden = !service.canForce;
    actions.querySelector('.service-force').disabled = Boolean(state.action) || preparingStop;
  }
  if (phase === 'error' && previousPhase !== 'error') {
    const failed = state.services.find(service => service.phase === 'error');
    selectLogSource(failed?.id ?? 'manager');
    byId('log-details').open = true; autoOpened = true;
  }
  else if (running && autoOpened) { byId('log-details').open = false; autoOpened = false; }
  previousPhase = phase;
  if (state.action && byId('stop-dialog').open) byId('stop-dialog').close();
  renderLogs(state.logs);
  if (restoringUi) {
    restoringUi = false;
    if (!byId('follow').checked && Number.isFinite(savedUi.logScroll)) byId('logs').scrollTop = logViews[logSource].scroll || savedUi.logScroll;
    if (Number.isFinite(savedUi.mainScroll)) document.querySelector('main').scrollTop = savedUi.mainScroll;
  }
}
function run(action) {
  feedback('');
  void action().then(state => { if (state) render(state); }).catch(error => feedback(error.message));
}
async function prepareStop(ids, force = false) {
  if (preparingStop || current?.action) return;
  if (!supportsStopPlans) {
    stopPlan = { legacy: true, targets: [{}] };
    byId('stop-title').textContent = '로컬 서버를 중지할까요?';
    byId('stop-description').textContent = '이 관리 앱에서 시작한 서버만 중지합니다. Ticklane의 서버 연결이 끊깁니다.';
    byId('stop-targets').replaceChildren(); byId('stop-blocked').textContent = '';
    byId('confirm-stop').disabled = false; byId('confirm-stop').textContent = '서버 중지';
    byId('stop-dialog').showModal(); return;
  }
  preparingStop = true; render(current); feedback('');
  try {
    stopPlan = await api.prepareStop(ids, force);
    byId('stop-title').textContent = stopPlan.targets.length ? force ? '확인한 서버를 강제 종료할까요?' : '확인한 서버를 중지할까요?' : '중지할 서버를 확인하지 못했습니다';
    byId('stop-description').textContent = force ? '정상 종료에 응답하지 않은 프로세스를 강제로 종료합니다. 진행 중인 작업이 유실될 수 있습니다.' : '연결된 Ticklane의 조회·수집·주문 처리가 중단됩니다.';
    const targets = byId('stop-targets'); targets.replaceChildren();
    for (const target of stopPlan.targets) {
      const section = document.createElement('section'); section.className = 'stop-target';
      const title = document.createElement('h3'); title.textContent = `${target.label} · localhost:${target.port} · ${target.owner === 'external' ? '외부 실행' : '앱에서 실행'}`;
      const identity = document.createElement('p'); identity.textContent = `PID ${target.pid} · ${target.user} · ${target.processCount}개 프로세스${target.owner === 'managed' ? ' 및 자식 프로세스' : ''}`;
      const cwd = document.createElement('p'); cwd.textContent = target.cwd;
      const command = document.createElement('code'); command.textContent = target.command;
      section.append(title, identity, cwd, command); targets.append(section);
    }
    byId('stop-blocked').textContent = stopPlan.blocked.map(b => `${b.label} 중지 불가: ${b.reason}`).join('\n\n');
    byId('confirm-stop').disabled = !stopPlan.targets.length;
    byId('confirm-stop').textContent = force ? '강제 종료' : stopPlan.blocked.length ? '확인된 서버 중지' : '서버 중지';
    byId('cancel-stop').textContent = stopPlan.targets.length ? '계속 실행' : '닫기';
    byId('stop-dialog').showModal();
  } catch (error) { feedback(error.message); }
  finally { preparingStop = false; render(current); }
}
byId('primary').addEventListener('click', () => {
  if (current?.phase !== 'running') { run(api.start); return; }
  openingClient = true; render(current); feedback('');
  void api.openClient().catch(() => feedback('Ticklane을 열지 못했습니다. Ticklane 아이콘으로 다시 실행해 주세요.')).finally(() => { openingClient = false; render(current); });
});
byId('stop').addEventListener('click', () => {
  if (current?.action === 'starting') run(api.stop);
  else if (current?.canStop) void prepareStop();
});
byId('cancel-stop').addEventListener('click', () => byId('stop-dialog').close());
byId('confirm-stop').addEventListener('click', () => {
  if (!stopPlan?.targets.length) return;
  const plan = stopPlan; stopPlan = undefined;
  byId('stop-dialog').close(); run(() => plan.legacy ? api.stop() : api.confirmStop(plan.token));
});
byId('refresh').addEventListener('click', () => run(api.refresh));
byId('log-details').querySelector('summary').addEventListener('click', () => { autoOpened = false; });
byId('open-logs').addEventListener('click', () => { void api.openLogs().then(error => { if (error) feedback('로그 폴더를 열지 못했습니다.'); }).catch(() => feedback('로그 폴더를 열지 못했습니다.')); });
byId('close').addEventListener('click', () => { void api.close().catch(error => feedback(error.message)); });
byId('minimize').addEventListener('click', () => { void api.minimize?.().catch(error => feedback(error.message)); });
byId('maximize').addEventListener('click', () => { void api.toggleMaximize?.().catch(error => feedback(error.message)); });
byId('quit').addEventListener('click', () => { void api.quit().catch(error => feedback(error.message)); });
// Older running main/preload code keeps working while a source UI update is applied.
if (api.windowState && api.onWindowState) {
  api.onWindowState(renderWindowState);
  void api.windowState().then(renderWindowState).catch(error => feedback(error.message));
}
api.onState(render);
run(api.read);

for (const tab of document.querySelectorAll('[role="tab"]')) {
  tab.addEventListener('click', () => selectLogSource(tab.dataset.source));
  tab.addEventListener('keydown', event => {
    const sources = ['backend', 'frontend', 'manager'];
    const index = sources.indexOf(logSource);
    const next = { ArrowRight: sources[(index + 1) % 3], ArrowLeft: sources[(index + 2) % 3], Home: sources[0], End: sources[2] }[event.key];
    if (next) { event.preventDefault(); selectLogSource(next); byId(`tab-${next}`).focus(); }
  });
}
byId('log-level').addEventListener('change', () => renderLogs(current?.logs ?? [], true));
byId('raw-logs').addEventListener('click', () => { rawLogs = !rawLogs; renderLogs(current?.logs ?? [], true); });
byId('copy-logs').addEventListener('click', () => { void copyLogs(visibleLogs().map(entry => entry.raw.join('\n')).join('\n')); });
byId('copy-all-logs').addEventListener('click', () => { void copyLogs((current?.logs ?? []).join('\n')); });
byId('close-copy').addEventListener('click', () => { byId('copy-fallback').hidden = true; });
byId('follow').addEventListener('change', () => { if (byId('follow').checked) byId('logs').scrollTop = byId('logs').scrollHeight; });
