const api = window.serverManager;
const byId = id => document.getElementById(id);
const phaseNames = { stopped: '중지됨', starting: '준비 중', running: '실행 중', stopping: '중지 중', error: '확인 필요' };
const timeFormat = new Intl.DateTimeFormat('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
let savedUi = {};
try { savedUi = JSON.parse(sessionStorage.getItem('ticklane-server-ui') || '{}') || {}; } catch { /* use defaults */ }
let current;
let previousPhase = savedUi.phase;
let autoOpened = savedUi.autoOpened === true;
let logText = '';
let openingClient = false;
let restoringUi = true;
byId('log-details').open = savedUi.logsOpen === true;
byId('follow').checked = savedUi.follow !== false;

window.addEventListener('beforeunload', () => {
  try {
    sessionStorage.setItem('ticklane-server-ui', JSON.stringify({
      phase: previousPhase, autoOpened, logsOpen: byId('log-details').open, follow: byId('follow').checked,
      logScroll: byId('logs').scrollTop, mainScroll: document.querySelector('main').scrollTop,
    }));
  } catch { /* reloading still works when session storage is unavailable */ }
});

function feedback(message) { byId('feedback').textContent = message; byId('feedback').hidden = !message; }
function renderLogs(lines) {
  const next = lines.join('\n');
  if (next === logText) return;
  logText = next;
  const logs = byId('logs');
  const scrollTop = logs.scrollTop;
  const fragment = document.createDocumentFragment();
  for (const line of lines) {
    const row = document.createElement('div');
    const match = /^(\d{4}-\d\d-\d\dT\S+Z) \[([^\]]+)\] (.*)$/.exec(line);
    const date = match && new Date(match[1]);
    if (date && !Number.isNaN(date.getTime())) {
      const time = document.createElement('time'); time.className = 'log-time'; time.dateTime = match[1]; time.title = date.toLocaleString('ko-KR'); time.textContent = timeFormat.format(date);
      const source = document.createElement('span'); source.className = 'log-source'; source.textContent = `[${match[2]}] `;
      row.append(time, source, document.createTextNode(match[3]));
    } else row.textContent = line;
    fragment.append(row);
  }
  logs.replaceChildren(fragment);
  if (!lines.length) logs.textContent = '아직 실행 로그가 없습니다.';
  if (byId('follow').checked) logs.scrollTop = logs.scrollHeight;
  else logs.scrollTop = scrollTop;
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
  byId('stop').disabled = !state.canStop;
  byId('stop').textContent = phase === 'starting' ? '시작 취소' : '서버 중지';
  byId('refresh').disabled = Boolean(state.action);
  const projectName = state.project.split(/[\\/]/).filter(Boolean).pop();
  byId('project').textContent = projectName ? `${projectName} · 로컬 프로젝트` : '로컬 프로젝트';
  byId('project').title = state.project;
  byId('external-note').hidden = !hasExternal;
  for (const service of state.services) {
    const row = byId(`service-${service.id}`);
    if (!row) continue;
    row.dataset.phase = service.phase; row.dataset.owner = service.owner ?? '';
    row.querySelector('.phase').textContent = service.phase === 'running' && service.owner === 'external' ? '외부 실행' : phaseNames[service.phase];
    row.querySelector('.service-status').title = service.message;
    row.querySelector('.address').textContent = `${service.label} · localhost:${service.port}`;
    row.querySelector('.detail').textContent = service.message;
    row.querySelector('.detail').hidden = service.phase !== 'error';
  }
  if (phase === 'error' && previousPhase !== 'error') { byId('log-details').open = true; autoOpened = true; }
  else if (running && autoOpened) { byId('log-details').open = false; autoOpened = false; }
  previousPhase = phase;
  if (!state.canStop && byId('stop-dialog').open) byId('stop-dialog').close();
  renderLogs(state.logs);
  if (restoringUi) {
    restoringUi = false;
    if (!byId('follow').checked && Number.isFinite(savedUi.logScroll)) byId('logs').scrollTop = savedUi.logScroll;
    if (Number.isFinite(savedUi.mainScroll)) document.querySelector('main').scrollTop = savedUi.mainScroll;
  }
}
function run(action) {
  feedback('');
  void action().then(state => { if (state) render(state); }).catch(error => feedback(error.message));
}
byId('primary').addEventListener('click', () => {
  if (current?.phase !== 'running') { run(api.start); return; }
  openingClient = true; render(current); feedback('');
  void api.openClient().catch(() => feedback('Ticklane을 열지 못했습니다. Ticklane 아이콘으로 다시 실행해 주세요.')).finally(() => { openingClient = false; render(current); });
});
byId('stop').addEventListener('click', () => {
  if (current?.action === 'starting') run(api.stop);
  else if (current?.canStop) byId('stop-dialog').showModal();
});
byId('cancel-stop').addEventListener('click', () => byId('stop-dialog').close());
byId('confirm-stop').addEventListener('click', () => { byId('stop-dialog').close(); run(api.stop); });
byId('refresh').addEventListener('click', () => run(api.refresh));
byId('log-details').querySelector('summary').addEventListener('click', () => { autoOpened = false; });
byId('open-logs').addEventListener('click', () => { void api.openLogs().then(error => { if (error) feedback('로그 폴더를 열지 못했습니다.'); }).catch(() => feedback('로그 폴더를 열지 못했습니다.')); });
byId('close').addEventListener('click', () => { void api.close().catch(error => feedback(error.message)); });
byId('quit').addEventListener('click', () => { void api.quit().catch(error => feedback(error.message)); });
api.onState(render);
run(api.read);
