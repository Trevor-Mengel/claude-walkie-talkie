import { readFile } from 'node:fs/promises';
import { parseMessage } from './format.js';

const HEADER_END = '<!-- WALKIE:HEADER_END -->';

/**
 * @param {string} text
 * @returns {{header:string, headerEndIdx:number, body:string, messages:object[]}}
 */
export function parseChannel(text) {
  const idx = text.indexOf(HEADER_END);
  if (idx === -1) throw new Error('Channel file missing WALKIE:HEADER_END marker');
  const headerEndIdx = idx + HEADER_END.length;
  const header = text.slice(0, headerEndIdx);
  const body = text.slice(headerEndIdx);
  const messages = [];
  let cursor = 0;
  while (cursor < body.length) {
    const nextHeading = body.indexOf('\n## ', cursor);
    if (nextHeading === -1) break;
    const afterHeading = nextHeading + 1;
    const followingHeading = body.indexOf('\n## ', afterHeading);
    const blockEnd = followingHeading === -1 ? body.length : followingHeading;
    const block = body.slice(afterHeading, blockEnd);
    const parsed = parseMessage(block);
    if (parsed) messages.push(parsed);
    cursor = blockEnd;
  }
  return { header, headerEndIdx, body, messages };
}

/** @param {string} path */
export async function readChannel(path) {
  const text = await readFile(path, 'utf8');
  return parseChannel(text);
}
