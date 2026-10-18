const fields = Object.fromEntries(['profiles', 'name', 'origin', 'mode', 'api-origin', 'api-field', 'connect', 'cancel', 'remove', 'status', 'version', 'switch-hint'].map(id => [id, document.getElementById(id)]));
let profiles = [];
let busy = false;
let ready = false;
let generation = 0;
function modeChanged() { fields['api-field'].hidden = fields.mode.value !== 'development'; }
function selectProfile() {
  const p = profiles.find(profile => profile.id === fields.profiles.value);
  fields.name.value = p?.name ?? '로컬'; fields.origin.value = p?.origin ?? 'http://localhost:8000';
  fields.mode.value = p?.mode ?? 'server'; fields['api-origin'].value = p?.apiOrigin ?? 'http://localhost:8000'; modeChanged();
}
function setBusy(value) {
  busy = value;
  for (const key of ['profiles', 'name', 'origin', 'mode', 'api-origin', 'connect', 'remove']) fields[key].disabled = value || !ready;
  fields.cancel.hidden = !value;
}
window.refreshLauncher = async () => {
  try {
    const data = await window.launcher.read(); profiles = data.profiles;
    fields.profiles.replaceChildren(new Option('새 서버', ''), ...profiles.map(p => new Option(p.name, p.id)));
    fields.profiles.value = data.activeId ?? ''; selectProfile();
    fields.mode.querySelector('[value="development"]').hidden = !data.developmentAllowed;
    fields['switch-hint'].hidden = !data.hasWindows;
    fields.version.textContent = `Desktop ${data.build.sourceVersion} (${data.build.commit})`;
    fields.status.textContent = data.warning;
  } catch { fields.status.textContent = '연결 설정을 읽지 못했습니다. 앱을 다시 실행하세요.'; }
  finally { ready = true; setBusy(busy); }
};
fields.profiles.addEventListener('change', selectProfile); fields.mode.addEventListener('change', modeChanged);
document.getElementById('connection').addEventListener('submit', async event => {
  event.preventDefault(); if (busy) return;
  const attempt = ++generation; setBusy(true); fields.status.textContent = '서버와 화면을 확인하고 있습니다…';
  try {
    const result = await window.launcher.connect({ id: fields.profiles.value || undefined, name: fields.name.value, origin: fields.origin.value, mode: fields.mode.value, apiOrigin: fields['api-origin'].value });
    if (attempt === generation) fields.status.textContent = result.ok ? '연결했습니다.' : result.error;
  } catch { if (attempt === generation) fields.status.textContent = '연결 설정을 적용하지 못했습니다.'; }
  finally { if (attempt === generation) setBusy(false); }
});
fields.cancel.addEventListener('click', async () => { generation++; await window.launcher.cancel(); setBusy(false); fields.status.textContent = '연결을 취소했습니다.'; });
fields.remove.addEventListener('click', async () => {
  try { if (fields.profiles.value) await window.launcher.remove(fields.profiles.value); await window.refreshLauncher(); }
  catch { fields.status.textContent = '프로필을 삭제하지 못했습니다.'; }
});
setBusy(false);
void window.refreshLauncher();
