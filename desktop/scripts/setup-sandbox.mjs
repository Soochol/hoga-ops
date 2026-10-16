import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sandboxProfile } from './sandbox-profile.mjs';

async function main() {
  if (process.platform !== 'linux') throw new Error('이 설정은 Linux AppArmor 환경용입니다.');
  const args = process.argv.slice(2);
  if (args.some(arg => !['--print', '--remove'].includes(arg)) || args.length > 1) throw new Error('지원 옵션: --print 또는 --remove');
  const executable = await realpath(fileURLToPath(new URL('../node_modules/electron/dist/electron', import.meta.url)));
  const { name, policy } = sandboxProfile(executable);
  const target = `/etc/apparmor.d/${name}`;
  if (args.includes('--print')) { process.stdout.write(policy); return; }
  if ((await readFile('/sys/module/apparmor/parameters/enabled', 'utf8')).trim() !== 'Y') throw new Error('AppArmor가 활성화되어 있지 않습니다. 이 설정을 적용하지 않았습니다.');
  const parser = '/usr/sbin/apparmor_parser';
  const root = (command, parameters) => execFileSync('sudo', [command, ...parameters], { stdio: 'inherit' });
  if (args.includes('--remove')) {
    root(parser, ['--remove', target]);
    root('/usr/bin/rm', ['--', target]);
    console.log(`AppArmor 프로필을 제거했습니다: ${target}`);
    return;
  }
  const temporary = await mkdtemp(join(tmpdir(), 'hoga-sandbox-'));
  try {
    const source = join(temporary, name);
    await writeFile(source, policy, { mode: 0o600 });
    // Compile before any privileged mutation. No kernel policy is changed here.
    execFileSync(parser, ['--skip-kernel-load', '--skip-cache', source], { stdio: 'inherit' });
    console.log(`이 실행 파일의 Chromium 샌드박스에 user namespace를 허용합니다:\n${executable}\n프로필: ${target}\n최초 적용에는 sudo 인증이 필요합니다.`);
    root('/usr/bin/install', ['-o', 'root', '-g', 'root', '-m', '0644', source, target]);
    root(parser, ['--replace', target]);
    console.log('설정을 적용했습니다. 일반 사용자로 npm start를 다시 실행하세요.');
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
