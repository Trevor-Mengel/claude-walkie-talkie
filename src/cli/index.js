// src/cli/index.js
import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initCommand } from './init.js';
import { startCommand } from './start.js';
import { stopCommand } from './stop.js';
import { statusCommand } from './status.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8'));

const program = new Command();
program
  .name('walkie')
  .description('Two-way radio for Claude Code and Claude Cowork sessions')
  .version(pkg.version);

program
  .command('init')
  .description('Initialize .walkie-talkie/ in the current directory')
  .requiredOption('--operator <name>', 'Operator (human) display name')
  .option('--name <projectName>', 'Project name (defaults to directory name)')
  .option('--force', 'Overwrite an existing .walkie-talkie/')
  .action(initCommand);

// Placeholder subcommands — replaced in tasks 27-33 with real implementations.
const placeholders = [
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

program.command('start').description('Start the local daemon').action(startCommand);
program.command('stop').description('Stop the local daemon').action(stopCommand);
program
  .command('status')
  .description('Show daemon and channel status')
  .option('--all', 'List all walkie projects machine-wide')
  .action(statusCommand);

program.parseAsync(process.argv);
