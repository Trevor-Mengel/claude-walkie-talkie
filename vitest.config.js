import { defaultExclude, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.js'],
    // `include` alone lets any file dropped under `test/` join the certified
    // suite — a reviewer's scratch probe then changes the suite's file count and
    // can return a non-zero exit to whoever is verifying the gate. `test/scratch/`
    // is structurally outside the suite; vitest's own defaults are preserved.
    exclude: [...defaultExclude, 'test/scratch/**'],
    testTimeout: 10000,
    // Creates the per-run disposable state tree and exports WALKIE_* / GIT_CONFIG_*.
    globalSetup: ['./test/helpers/global-setup.js'],
    // Throws before any test body runs if this process could reach live user state.
    setupFiles: ['./test/helpers/isolation.js']
  }
});
