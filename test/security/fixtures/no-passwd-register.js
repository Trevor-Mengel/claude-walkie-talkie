// `node --import ./no-passwd-register.js <program>` runs `<program>` in a process
// where `os.userInfo()` throws. Used to reach `walkie init`'s "no usable
// operator name from any source" branch.

import { register } from 'node:module';

register(new URL('./no-passwd-hooks.js', import.meta.url));
