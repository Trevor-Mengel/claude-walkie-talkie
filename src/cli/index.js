// src/cli/index.js
import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8'));

const program = new Command();
program
  .name('walkie')
  .description('Two-way radio for Claude Code and Claude Cowork sessions')
  .version(pkg.version);

// Placeholder subcommands — replaced in tasks 26-33 with real implementations.
const placeholders = [
  ['init', 'Initialize .walkie-talkie/ in the current directory'],
  ['start', 'Start the local daemon'],
  ['stop', 'Stop the local daemon'],
  ['status', 'Show daemon and channel status'],
  ['talk', 'Broadcast a message (use @mentions to direct attention)'],
  ['read', 'Read recent messages'],
  ['tail', 'Stream the live event feed'],
  ['reply', 'Reply to a specific message'],
  ['edit', 'Edit a message you authored'],
  ['archive', 'Archive a message'],
  ['sessions', 'List active and recent sessions plus invitations'],
  ['rename', 'Rename this session'],
  ['alias', 'Rename a specific session by id'],
  ['invite', 'Reserve an alias for a future session'],
  ['permit', 'Grant autonomous-write permission to a session'],
  ['remove', 'Remove autonomous-write permission from a session'],
  ['config', 'View or edit channel config'],
  ['logs', 'View activity logs']
];
for (const [name, desc] of placeholders) {
  program.command(name).description(desc).action(() => {
    console.error(`walkie ${name}: not implemented yet`);
    process.exit(2);
  });
}

program.parseAsync(process.argv);
