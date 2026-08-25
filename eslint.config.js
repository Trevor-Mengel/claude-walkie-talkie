import globals from 'globals';

// Globals come from the `globals` package rather than a hand-written list.
//
// The list used to be maintained by hand and it drifted exactly as you would expect: it had
// `URL` but not `URLSearchParams`, and `setTimeout`/`setInterval` but not `setImmediate`. Both
// gaps were real `no-undef` errors on committed code — `src/client/api.js` and
// `test/mcp-server/resources-subscriptions.test.js` — so `npm run lint` exited 1 while the full
// test suite was green, and CI went red on a branch whose 1226 tests all passed. Spreading the
// real Node set means a legitimate runtime global can never again be reported as undefined.
//
// `globals` is a declared devDependency, not borrowed transitively from eslint's own tree: it
// resolved either way, but depending on another package's dependency is how a working setup
// breaks on an unrelated minor bump.
export default [
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node }
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'no-undef': 'error',
      'prefer-const': 'warn',
      'no-var': 'error',
      eqeqeq: ['error', 'always']
    }
  },
  {
    // Vitest injects no globals here — every test file imports what it uses from 'vitest', which
    // is why these are `readonly` conveniences rather than a required set. `globals` ships no
    // vitest collection, so this one stays explicit.
    files: ['test/**/*.js'],
    languageOptions: {
      globals: {
        describe: 'readonly',
        test: 'readonly',
        it: 'readonly',
        expect: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
        beforeAll: 'readonly',
        afterAll: 'readonly'
      }
    }
  }
];
