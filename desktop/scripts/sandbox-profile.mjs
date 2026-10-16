import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';

/** One executable attachment, with AppArmor glob operators escaped. */
export function sandboxProfile(executable) {
  if (typeof executable !== 'string' || !isAbsolute(executable) || /[\r\n\0]/.test(executable)) throw new Error('An absolute executable path is required');
  const name = `hoga-ops-desktop-${createHash('sha256').update(executable).digest('hex').slice(0, 12)}`;
  const attachment = executable.replace(/[\\"*?[\]{}^]/g, character => `\\${character}`);
  const policy = `# Allow Chromium's user-namespace sandbox for this executable only.\nabi <abi/4.0>,\ninclude <tunables/global>\n\nprofile ${name} "${attachment}" flags=(unconfined) {\n  userns,\n}\n`;
  return { name, policy };
}
