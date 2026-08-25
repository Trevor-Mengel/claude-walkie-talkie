import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import { isWalkieError } from '../identity/errors.js';
import { buildTools } from './tools.js';
import { buildResources } from './resources.js';
import { clientForRoot } from './http-client.js';
import { findProjectRoot } from './project.js';

const SERVER_NAME = 'walkie-talkie';
const SERVER_VERSION = '0.3.0';

/**
 * Build the MCP server without connecting a transport.
 *
 * Three things this deliberately does NOT do:
 *
 * - it does not spawn a daemon. v0.2 called `ensureDaemon(projectRoot)` here, so merely
 *   launching an MCP client left a detached, unsupervised service behind. A client connects or
 *   it fails with guidance; it never starts anything.
 * - it does not read identity from the environment. `WALKIE_TOOL` and `WALKIE_ALIAS` are no
 *   longer identity inputs: an alias is a claim on the channel and cannot be made by setting a
 *   variable.
 * - it does not require a capability to construct. A session with no injected credential comes
 *   up unenrolled so the model can call `walkie_enroll`; every other tool then fails with one
 *   consistent, actionable message until the operator approves.
 *
 * @param {{env?:Record<string,string|undefined>, cwd?:string, runtimeRoot?:string}} [opts]
 */
export async function createMcpServer({ env = process.env, cwd = process.cwd(), runtimeRoot } = {}) {
  const projectRoot = findProjectRoot({ env, cwd });
  const { context, api, capability, events } = clientForRoot(projectRoot, { env, runtimeRoot });

  // A supervisor-injected capability is resolved eagerly so a stale or revoked injection is
  // reported at startup rather than on the first tool call. A failure here is not fatal: the
  // session stays up, unenrolled, and says why.
  let injectionError = null;
  try {
    await capability.adoptInjected();
  } catch (err) {
    injectionError = err;
    process.stderr.write(
      `[walkie-talkie-mcp] injected capability rejected (${isWalkieError(err) ? err.code : 'error'}): ` +
        `${isWalkieError(err) ? err.message : 'unusable credential'}\n`
    );
  }

  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {}, resources: { subscribe: true } } }
  );

  const tools = buildTools({ api, capability, namespace: context.namespace });
  const resources = buildResources({ server, api, capability, events });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools.list() }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => tools.call(request));
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: resources.list() }));
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => resources.read(request));
  server.setRequestHandler(SubscribeRequestSchema, async (request) => resources.subscribe(request));
  server.setRequestHandler(UnsubscribeRequestSchema, async (request) =>
    resources.unsubscribe(request)
  );

  return { server, context, api, capability, tools, resources, injectionError };
}

/**
 * Process entry point. Called by `bin/walkie-talkie-mcp.js`; never on import, so tests can
 * build a server without connecting stdio.
 */
export async function runMcpServer() {
  try {
    const { server } = await createMcpServer();
    await server.connect(new StdioServerTransport());
  } catch (err) {
    const code = isWalkieError(err) ? err.code : 'internal';
    process.stderr.write(`[walkie-talkie-mcp] fatal [${code}]: ${err.message}\n`);
    process.exitCode = 1;
  }
}
