const { mkdtemp, mkdir, writeFile, readFile, rm, chmod } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createServer } = require('node:net');
const { spawn } = require('node:child_process');

async function freePort() {
  const server = createServer();
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const port = server.address().port;
  await new Promise(done => server.close(done));
  return port;
}
async function alive(pid) {
  try { return !(await readFile(`/proc/${pid}/stat`, 'utf8')).split(') ', 2)[1].startsWith('Z '); }
  catch { return false; }
}
async function fixture() {
  const project = await mkdtemp(join(tmpdir(), 'ticklane-manager-'));
  await mkdir(join(project, '.venv/bin'), { recursive: true });
  await mkdir(join(project, 'frontend/node_modules/vite/bin'), { recursive: true });
  await writeFile(join(project, '.venv/bin/python'), 'fixture');
  await writeFile(join(project, 'frontend/node_modules/vite/bin/vite.js'), 'fixture');
  const script = `#!${process.execPath}
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const id = path.basename(process.argv[1]).includes('npm') ? 'frontend' : 'backend';
const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
if (process.env.TICKLANE_FIXTURE_FAIL === id) { console.error('fixture intentionally failed'); process.exit(2); }
if (process.env.TICKLANE_FIXTURE_RELOAD === id && !process.env.TICKLANE_FIXTURE_CHILD) {
  const child = spawn(process.execPath, [process.argv[1]+'.listener', ...process.argv.slice(2)], {
    env: { ...process.env, TICKLANE_FIXTURE_CHILD: '1' }, stdio: 'ignore'
  });
  child.once('exit',()=>process.exit(0));
  process.on('SIGTERM',()=>child.kill('SIGTERM'));
  return;
}
const worker = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
fs.writeFileSync(path.join(process.env.TICKLANE_FIXTURE_ROOT || path.dirname(process.argv[1]), id+'.json'), JSON.stringify({ pid:process.pid, worker:worker.pid, args:process.argv.slice(2), api:process.env.E2E_API_URL }));
const server = http.createServer((req,res)=>{
  if(id === 'backend') { res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({status:'ok',version:'fixture'})); }
  else { res.setHeader('Content-Type','application/javascript'); res.end('export function createHotContext() {}'); }
});
const timer = setTimeout(()=>server.listen(port,process.env.TICKLANE_FIXTURE_HOST || '127.0.0.1',()=>console.log(id+' ready <img src=x onerror=alert(1)>')), Number(process.env.TICKLANE_FIXTURE_DELAY_MS || 0));
process.on('SIGTERM',()=>{
  if(process.env.TICKLANE_FIXTURE_IGNORE_TERM === id) return;
  clearTimeout(timer);
  server.close(()=>{
    if(worker.exitCode !== null || worker.signalCode !== null) process.exit(0);
    else { worker.once('exit',()=>process.exit(0)); worker.kill(); }
  });
});
`;
  const uv = join(project, 'uv'); const npm = join(project, 'npm');
  for (const tool of [uv, npm]) { await writeFile(tool, script); await chmod(tool, 0o755); }
  await writeFile(uv + '.listener', script);
  const ports = { backend: await freePort(), frontend: await freePort() };
  while (ports.frontend === ports.backend) ports.frontend = await freePort();
  const config = join(project, 'servers.json');
  const settings = { project, uv, npm, node: process.execPath, ports };
  await writeFile(config, JSON.stringify(settings));
  const env = { TICKLANE_FIXTURE_ROOT: project };
  const external = [];
  return { project, config, settings, env, ports,
    marker: async id => JSON.parse(await readFile(join(project, `${id}.json`), 'utf8')),
    external: (id, options = {}) => {
      const args = id === 'backend' ? ['run', '--frozen', 'uvicorn', 'hoga.api.app:default_app', '--factory'] : ['run', 'dev', '--'];
      const child = spawn(id === 'backend' ? uv : npm, [...args, '--port', String(ports[id])], {
        cwd: options.cwd ?? (id === 'backend' ? project : join(project, 'frontend')),
        env: { ...process.env, ...env, ...options.env }, detached: true, stdio: 'ignore',
      });
      external.push(child); return child;
    },
    dispose: async () => {
      for (const child of external) {
        if (child.exitCode === null && child.signalCode === null) {
          const exited = new Promise(done => child.once('exit', done));
          try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
          await exited;
        }
      }
      await rm(project, { recursive: true, force: true });
    },
  };
}
module.exports = { fixture, alive };
