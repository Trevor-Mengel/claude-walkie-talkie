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
import { buildTools } from './tools.js';
import { buildResources } from './resources.js';

const TOOL_NAME = 'walkie-talkie';

async function main() {
  const server = new Server(
    { name: TOOL_NAME, version: '0.2.0' },
    { capabilities: { tools: {}, resources: { subscribe: true } } }
  );

  const tools = buildTools();
  const resources = buildResources();

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.list()
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => tools.call(request));
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: resources.list() }));
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => resources.read(request));
  server.setRequestHandler(SubscribeRequestSchema, async (request) => resources.subscribe(request));
  server.setRequestHandler(UnsubscribeRequestSchema, async (request) => resources.unsubscribe(request));

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`[walkie-talkie-mcp] fatal: ${err.stack || err.message}\n`);
  process.exit(1);
});
