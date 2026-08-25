// src/cli/index.js
import { Command, CommanderError } from 'commander';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCollabcastError } from '../identity/errors.js';
import { initCommand } from './init.js';
import { startCommand } from './start.js';
import { stopCommand } from './stop.js';
import { statusCommand } from './status.js';
import { talkCommand } from './talk.js';
import { readCommand } from './read.js';
import { inboxCommand, ackCommand } from './inbox.js';
import { tailCommand } from './tail.js';
import { replyCommand } from './reply.js';
import { editCommand } from './edit.js';
import { archiveCommand } from './archive.js';
import { sessionsCommand } from './sessions.js';
import { renameCommand } from './rename.js';
import { enrollCommand, revokeCommand } from './enroll.js';
import { whoamiCommand } from './whoami.js';
import { configCommand } from './config.js';
import { logsCommand } from './logs.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8'));

/**
 * Exit codes, so a hook or a script can branch without scraping stderr.
 *
 * 2 is "you asked for something you are not allowed to do or that does not exist" — the
 * authority family. 3 is "the service is not there". 1 is everything else.
 */
export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_DENIED = 2;
export const EXIT_UNAVAILABLE = 3;

const DENIED_CODES = new Set([
  'unauthenticated',
  'forbidden',
  'not_owner',
  'wrong_namespace',
  'scope_required',
  'permit_required',
  'permit_invalid',
  'conflict',
  'not_found'
]);

/** @param {unknown} err @returns {number} */
export function exitCodeFor(err) {
  if (!isCollabcastError(err)) return EXIT_ERROR;
  if (err.code === 'unavailable') return EXIT_UNAVAILABLE;
  return DENIED_CODES.has(err.code) ? EXIT_DENIED : EXIT_ERROR;
}

/**
 * Render a failure for a human. A CollabcastError is already written for one, so it is printed as
 * `collabcast [code]: message` with its detail folded in. Anything else is a bug in this program
 * and prints only its message — never a stack trace, which is noise to an operator and can
 * carry filesystem paths.
 *
 * @param {unknown} err
 * @returns {string}
 */
export function renderError(err) {
  if (isCollabcastError(err)) {
    const detail =
      err.detail === undefined ? '' : `\n  ${JSON.stringify(err.detail)}`;
    return `collabcast [${err.code}]: ${err.message}${detail}`;
  }
  const message = err instanceof Error ? err.message : String(err);
  return `collabcast: ${message}`;
}

/**
 * Build the command tree. Separated from `run` so `--help` output can be inspected without
 * executing anything.
 */
export function buildProgram() {
  const program = new Command();
  program
    .name('collabcast')
    .description('Two-way radio for coding agents and their operator')
    .version(pkg.version)
    // Commander's default is to call process.exit itself; `run` owns exits.
    .exitOverride()
    .configureOutput({ writeErr: (str) => process.stderr.write(str) });

  program
    .command('init')
    .description('Initialize .collabcast/ here and register its namespace')
    .option('--operator <name>', 'Operator display name (defaults to git config user.name, then OS username)')
    .option('--name <projectName>', 'Project name (defaults to directory name)')
    .option('--namespace <namespace>', 'Channel namespace (defaults to a folded project name)')
    .option('--mode <mode>', 'managed (Paseo-supervised) or standalone')
    .option('--force', 'Overwrite an existing .collabcast/')
    .action(initCommand);

  program
    .command('whoami')
    .description('Show the namespace, principal, role, scopes and capability expiry in effect')
    .option('--json', 'Machine-readable output')
    .action(whoamiCommand);

  program
    .command('enroll')
    .description('Break-glass: mint a capability directly from your operator credential')
    .option('--recovery', 'Required. Acknowledges that this bypasses the operator approval dialog')
    .option('--role <role>', 'goal_hub or listener (default: listener)')
    .option('--scopes <list>', 'Comma- or space-separated scopes (default: channel:read,self:cursor)')
    .option('--ttl <seconds>', 'Capability lifetime in seconds')
    .option('--paseo-agent-id <id>', 'Bind the new principal to a Paseo agent')
    .option('--json', 'Machine-readable output')
    .action(enrollCommand);

  program
    .command('revoke <capabilityId>')
    .description('Revoke a capability and everything delegated from it')
    .action(revokeCommand);

  program
    .command('talk <message...>')
    .description('Broadcast a message (use @mentions to direct attention)')
    .option('--type <type>', 'Message type: broadcast|question|reply|memory-update', 'broadcast')
    .action((parts, opts) => talkCommand(parts.join(' '), opts));

  program
    .command('read')
    .description('Read recent messages')
    .option('--limit <N>', 'How many', '5')
    .option('--since <ulid>', 'Show messages after this ID')
    .option('--include-archived', 'Include archived messages', false)
    .option('--type <T>', 'Filter by message type')
    .action(readCommand);

  program
    .command('inbox')
    .description('Show your unread messages (hook-friendly; never acknowledges)')
    .option('--limit <N>', 'Cap how many messages are printed')
    .option('--format <fmt>', 'output format: context|json', 'context')
    .option('--include-memory-updates', 'Include memory updates (a separate cursor)', false)
    .action(inboxCommand);

  program
    .command('ack <id>')
    .description('Acknowledge messages through a message id')
    .option('--no-mark-read', 'Acknowledge without advancing the read cursor')
    // Must match the `collabcast inbox` call being acknowledged: each view has its own cursor.
    .option('--include-memory-updates', 'Acknowledge the memory-inclusive view', false)
    .action(ackCommand);

  program.command('tail').description('Stream the live event feed').action(tailCommand);

  program
    .command('reply <id> <message...>')
    .description('Reply to a specific message')
    .action((id, parts) => replyCommand(id, parts));

  program
    .command('edit <id> <newBody...>')
    .description('Edit a message you authored')
    .action((id, parts) => editCommand(id, parts));

  program
    .command('archive <id>')
    .description('Archive a message')
    .option('--reason <reason>', 'Why')
    .action(archiveCommand);

  program
    .command('sessions')
    .description('List the principals on this channel')
    .action(sessionsCommand);

  program
    .command('rename <alias>')
    .description('Change your own display alias')
    .action(renameCommand);

  program
    .command('config')
    .description('View or edit channel config')
    .option('--set <key=value>', 'Set a config value')
    .action(configCommand);

  program
    .command('logs')
    .description('View activity logs')
    .option('--tail <N>', 'Show only the last N lines')
    .action(logsCommand);

  program
    .command('start')
    .description('Start the local service (standalone mode only)')
    .action(startCommand);
  program
    .command('stop')
    .description('Stop the local service (standalone mode only)')
    .action(stopCommand);
  program
    .command('status')
    .description('Show service status (standalone mode only)')
    .option('--all', 'List every collabcast namespace registered on this host')
    .action(statusCommand);

  return program;
}

/**
 * Run the CLI.
 *
 * v0.2 called `program.parseAsync(process.argv)` and neither awaited nor caught it, so any
 * command that rejected surfaced as an unhandled rejection with a raw stack trace and,
 * depending on the Node version, an exit code that did not reflect the failure. Every failure
 * now gets one line on stderr and a deliberate exit code.
 *
 * @param {string[]} [argv]
 * @returns {Promise<number>} the process exit code
 */
export async function run(argv = process.argv) {
  try {
    await buildProgram().parseAsync(argv);
    return process.exitCode ?? EXIT_OK;
  } catch (err) {
    if (err instanceof CommanderError) {
      // `--help` and `--version` are reported as errors by exitOverride; they are successes.
      return err.exitCode === 0 ? EXIT_OK : EXIT_ERROR;
    }
    process.stderr.write(`${renderError(err)}\n`);
    return exitCodeFor(err);
  }
}
