import { appendFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

function filename(sessionsDir, msgId) {
  return join(sessionsDir, `${msgId}.history.md`);
}

/**
 * @param {string} sessionsDir
 * @param {string} msgId
 * @param {{revision:number, editedAt:string, editedBy:string, priorBody:string}} rev
 */
export async function appendRevision(sessionsDir, msgId, rev) {
  const block = [
    `## Revision ${rev.revision}`,
    `Edited at: ${rev.editedAt}`,
    `Edited by: ${rev.editedBy}`,
    '',
    rev.priorBody,
    '',
    '---',
    ''
  ].join('\n');
  await appendFile(filename(sessionsDir, msgId), block, 'utf8');
}

/**
 * @returns {Promise<Array<{revision:number, editedAt:string, editedBy:string, body:string}>>}
 */
export async function readHistory(sessionsDir, msgId) {
  const path = filename(sessionsDir, msgId);
  if (!existsSync(path)) return [];
  const text = await readFile(path, 'utf8');
  const out = [];
  const blocks = text.split(/\n## Revision /).filter((s) => s.trim().length > 0);
  for (const raw of blocks) {
    const block = raw.startsWith('## Revision ') ? raw : `## Revision ${raw}`;
    const m = block.match(/Revision (\d+)\s*\nEdited at: (.+?)\s*\nEdited by: (.+?)\s*\n\n([\s\S]*?)\n\n---/);
    if (m) {
      out.push({ revision: Number(m[1]), editedAt: m[2], editedBy: m[3], body: m[4] });
    }
  }
  return out;
}
