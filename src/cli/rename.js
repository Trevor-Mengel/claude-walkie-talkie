import { clientForProject } from './client.js';

/**
 * Rename the operator's own display alias.
 *
 * v0.2 read `CLAUDE_SESSION_ID` and renamed that session — a variable the CLI process
 * essentially never has, so the command 404'd in every realistic invocation, and when it did
 * work it could rename somebody else. `POST /self/alias` is own-principal only, and a taken
 * alias is refused rather than transferred.
 */
export async function renameCommand(newAlias) {
  const { api } = clientForProject();
  const res = await api.setAlias(newAlias);
  process.stdout.write(`Your alias is now @${res.displayAlias}.\n`);
}
