// src/cli/index.js
import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initCommand } from './init.js';
import { startCommand } from './start.js';
import { stopCommand } from './stop.js';
import { statusCommand } from './status.js';
import { talkCommand } from './talk.js';
import { readCommand } from './read.js';
import { tailCommand } from './tail.js';
import { replyCommand } from './reply.js';
import { editCommand } from './edit.js';
import { archiveCommand } from './archive.js';
import { sessionsCommand } from './sessions.js';
import { renameCommand } from './rename.js';
import { aliasCommand } from './alias.js';
import { inviteCommand } from './invite.js';

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

program
  .command('talk <message...>')
  .description('Broadcast a message (use @mentions to direct attention)')
  .option('--type <type>', 'Message type: broadcast|question|reply|memory-update', 'broadcast')
  .option('--as <alias>', 'Override the operator alias for this message')
  .option('--no-invite', 'Do not interactively offer to invite unresolved @mentions')
  .action((parts, opts) => talkCommand(parts.join(' '), opts));

program
  .command('read')
  .description('Read recent messages')
  .option('--limit <N>', 'How many', '5')
  .option('--since <ulid>', 'Show messages after this ID')
  .option('--include-archived', 'Include archived messages', false)
  .option('--type <T>', 'Filter by message type')
  .action(readCommand);
program.command('tail').description('Stream the live event feed').action(tailCommand);

program
  .command('reply <id> <message...>')
  .description('Reply to a specific message')
  .option('--as <alias>', 'Override operator alias')
  .action((id, parts, opts) => replyCommand(id, parts, opts));

program
  .command('edit <id> <newBody...>')
  .description('Edit a message you authored')
  .action((id, parts) => editCommand(id, parts));

program
  .command('archive <id>')
  .description('Archive a message')
  .option('--reason <reason>', 'Why')
  .action(archiveCommand);

program.command('sessions').description('List active and recent sessions plus invitations').action(sessionsCommand);
program.command('rename <alias>').description('Rename this session').action(renameCommand);
program.command('alias <sessionId> <newAlias>').description('Rename a specific session by id').action(aliasCommand);
program.command('invite <alias>').description('Reserve an alias for a future session').action(inviteCommand);

// Placeholder subcommands — replaced in tasks 29-33 with real implementations.
const placeholders = [
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
