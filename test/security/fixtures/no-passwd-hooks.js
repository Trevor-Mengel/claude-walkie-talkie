// Module-customization hook: routes every ESM import of `node:os` to the shim in
// `no-passwd-os.js`. Runs on the loader thread, so it must not import anything
// from the application.

const SHIM = new URL('./no-passwd-os.js', import.meta.url).href;

export async function resolve(specifier, context, next) {
  if (specifier === 'node:os' || specifier === 'os') {
    return { url: SHIM, format: 'module', shortCircuit: true };
  }
  return next(specifier, context);
}
