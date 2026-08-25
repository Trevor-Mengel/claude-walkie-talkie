// Scratch-probe runner.
//
// `vitest.config.js` excludes `test/scratch/**` so a throw-away probe can never
// join the certified suite and move its file count or its exit status. Vitest 1.6
// applies `exclude` before CLI filters and has no flag that subtracts from it, so
// an excluded file is unreachable by name — `npx vitest run test/scratch/x.test.js`
// reports "No test files found" and exits 1. This config is the on-demand door:
//
//   npx vitest run --config vitest.scratch.config.js
//   npx vitest run --config vitest.scratch.config.js test/scratch/x.test.js
//
// Isolation is identical to the real suite: the same globalSetup builds the
// disposable state tree and the same setupFiles guard refuses live user state, so
// a probe run here can no more reach `~/.collabcast` (or the pre-rename
// `~/.walkie-talkie` the guard still covers) than a suite test can.

import { defaultExclude, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/scratch/**/*.test.js'],
    exclude: [...defaultExclude],
    testTimeout: 10000,
    globalSetup: ['./test/helpers/global-setup.js'],
    setupFiles: ['./test/helpers/isolation.js']
  }
});
