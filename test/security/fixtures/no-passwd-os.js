// A `node:os` stand-in whose `userInfo()` fails, standing in for a process whose
// uid has no passwd entry (a container running as an unmapped user, a stripped
// image, a sandbox that denies the directory-service lookup).
//
// `os.userInfo()` reads the passwd database through libuv, so it cannot be
// steered by an environment variable — which is why the "no usable operator
// name" branch of `walkie init` is unreachable without replacing the module.
// The real builtin is reached through `createRequire`, because CJS resolution is
// not intercepted by the ESM resolve hook that routes `node:os` here.

import { createRequire } from 'node:module';

const real = createRequire(import.meta.url)('node:os');

export function userInfo() {
  const err = new Error('user info is unavailable');
  err.code = 'ENOENT';
  throw err;
}

export const EOL = real.EOL;
export const arch = real.arch;
export const availableParallelism = real.availableParallelism;
export const constants = real.constants;
export const cpus = real.cpus;
export const devNull = real.devNull;
export const endianness = real.endianness;
export const freemem = real.freemem;
export const homedir = real.homedir;
export const hostname = real.hostname;
export const loadavg = real.loadavg;
export const machine = real.machine;
export const networkInterfaces = real.networkInterfaces;
export const platform = real.platform;
export const release = real.release;
export const tmpdir = real.tmpdir;
export const totalmem = real.totalmem;
export const type = real.type;
export const uptime = real.uptime;
export const version = real.version;

export default { ...real, userInfo };
