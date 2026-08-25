import { clientForProject } from './client.js';

/**
 * Stream the live event feed.
 *
 * v0.2 read `http://127.0.0.1:<port>/events` with no credential at all — anything on the box
 * could watch the channel. The feed is now authenticated with the operator capability over the
 * namespace's Unix socket.
 */
export async function tailCommand() {
  const { context, events } = clientForProject();
  /** @type {{close:()=>void}|null} */
  let stream = null;
  stream = await events(
    (name, payload) => {
      process.stdout.write(`[${name}] ${JSON.stringify(payload)}\n`);
    },
    (err) => {
      process.stderr.write(`collabcast: event feed closed (${err?.code ?? 'error'})\n`);
      process.exitCode = 1;
      stream?.close();
      stream = null;
    }
  );
  process.stdout.write(`Tailing ${context.namespace}. Ctrl-C to exit.\n`);
  await new Promise(() => {});
}
