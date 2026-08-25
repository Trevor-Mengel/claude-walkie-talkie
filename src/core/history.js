import { appendFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { encodeMarkerValue, decodeMarkerValue } from './format.js';

function filename(sessionsDir, msgId) {
  const sessionsAbs = resolve(sessionsDir);
  const candidate = resolve(sessionsAbs, `${msgId}.history.md`);
  if (!candidate.startsWith(sessionsAbs + sep) && candidate !== sessionsAbs) {
    throw new Error(`history filename outside sessions directory: ${candidate}`);
  }
  return candidate;
}

/**
 * Revision body delimiters — the same treatment `channel.md` got in v0.3, finally applied
 * to `history.md`.
 *
 * The reader used to end a revision at the first `\n\n---`, so a prior body containing an
 * ordinary markdown horizontal rule came back truncated at that rule: `GET
 * /channel/message/:id` returned the text above it and nothing else, with no error and no
 * flag, while the full bytes sat intact on disk. The asymmetry is why no test caught it —
 * YAML front matter and unified diffs survive, because their `---` is not preceded by a
 * blank line; only the idiomatic markdown rule died.
 *
 * The fence is unforgeable for the same reason the channel body fence is:
 * `isValidMessageBody` rejects every `<!-- walkie:` sequence in a message body, and a
 * prior body is a message body that was already stored. Binding BOTH the message id and
 * the revision number means a fence recovered from one revision cannot close another.
 *
 * ON-DISK FORMAT CHANGE: revision blocks gain two comment lines around the body. Files
 * written before this change have no fence at all and are read by the legacy path below.
 */
const REV_OPEN_RE = /^<!--\s*walkie:rev\s+id=(\S+)\s+revision=(\S+)\s*-->$/;
const REV_CLOSE_RE = /^<!--\s*walkie:rev-end\s+id=(\S+)\s+revision=(\S+)\s*-->$/;

/** A revision whose fence never closed. Reported, never guessed at. @see BODY_ERROR_UNTERMINATED */
export const REVISION_ERROR_UNTERMINATED = 'unterminated-revision-fence';

const HEADER_RE = /^## Revision \d+\s*$/;
const EDITED_AT_RE = /^Edited at: (.*)$/;
const EDITED_BY_RE = /^Edited by: (.*)$/;

/**
 * @param {string} sessionsDir
 * @param {string} msgId
 * @param {{revision:number, editedAt:string, editedBy:string, priorBody:string}} rev
 */
export async function appendRevision(sessionsDir, msgId, rev) {
  const id = encodeMarkerValue(msgId ?? '');
  const revision = encodeMarkerValue(String(rev.revision));
  const block = [
    `## Revision ${rev.revision}`,
    `Edited at: ${rev.editedAt}`,
    `Edited by: ${rev.editedBy}`,
    '',
    `<!-- walkie:rev id=${id} revision=${revision} -->`,
    rev.priorBody,
    `<!-- walkie:rev-end id=${id} revision=${revision} -->`,
    '',
    '---',
    ''
  ].join('\n');
  await appendFile(filename(sessionsDir, msgId), block, 'utf8');
}

/**
 * `Edited at:` / `Edited by:` for the revision whose fence opens at `openIdx`.
 *
 * The metadata sits immediately above the open fence, so the scan walks up through blank
 * lines and the two metadata lines and stops at the `## Revision N` heading — never
 * crossing into the previous revision's block.
 */
function revisionMeta(lines, openIdx) {
  let editedAt = '';
  let editedBy = '';
  for (let i = openIdx - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (HEADER_RE.test(line)) break;
    const at = line.match(EDITED_AT_RE);
    if (at) {
      editedAt = at[1].trim();
      continue;
    }
    const by = line.match(EDITED_BY_RE);
    if (by) {
      editedBy = by[1].trim();
      continue;
    }
    if (line.trim() === '') continue;
    break;
  }
  return { editedAt, editedBy };
}

/**
 * Every fenced revision in the file, or null when the file carries no fence at all.
 *
 * Block boundaries come from the fences rather than from splitting on `## Revision `: a
 * prior body may legitimately contain that heading, and splitting on it fabricated an
 * extra revision entry out of the tail of a real one.
 */
function readFenced(lines, id) {
  const opens = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].trim().match(REV_OPEN_RE);
    if (m && m[1] === id) opens.push({ idx: i, revision: m[2] });
  }
  if (opens.length === 0) return null;
  const out = [];
  for (let n = 0; n < opens.length; n += 1) {
    const { idx, revision } = opens[n];
    const limit = n + 1 < opens.length ? opens[n + 1].idx : lines.length;
    const entry = {
      // The fence's own `revision` is authoritative: it is the token bound to these
      // bytes, where the `## Revision N` heading is only a rendering of it.
      revision: Number(decodeMarkerValue(revision)),
      ...revisionMeta(lines, idx),
      body: null
    };
    // Scan backwards from the block's end: the real close is the LAST matching one, so a
    // fence appearing inside the body cannot truncate what is recovered.
    let close = -1;
    for (let i = limit - 1; i > idx; i -= 1) {
      const m = lines[i].trim().match(REV_CLOSE_RE);
      if (m && m[1] === id && m[2] === revision) {
        close = i;
        break;
      }
    }
    if (close === -1) {
      // Unterminated: the bytes are on disk but their extent is unknown. Reported rather
      // than truncated — a confident partial body is worse than a named failure, because
      // the only use for a prior revision is forensics on an edited message.
      entry.bodyError = REVISION_ERROR_UNTERMINATED;
    } else {
      entry.body = lines.slice(idx + 1, close).join('\n');
    }
    out.push(entry);
  }
  return out;
}

/**
 * Pre-fence (v0.3.0) files: body runs from the blank line after the metadata to the first
 * `\n\n---`. Lossy for a body containing a markdown rule, which is exactly why the fence
 * above exists — kept only so history written before the fence still reads.
 */
const LEGACY_RE = /Revision (\d+)\s*\nEdited at: (.+?)\s*\nEdited by: (.+?)\s*\n\n([\s\S]*?)\n\n---/;

function readLegacy(text) {
  const out = [];
  const blocks = text.split(/\n## Revision /).filter((s) => s.trim().length > 0);
  for (const raw of blocks) {
    const block = raw.startsWith('## Revision ') ? raw : `## Revision ${raw}`;
    const m = block.match(LEGACY_RE);
    if (m) {
      out.push({ revision: Number(m[1]), editedAt: m[2], editedBy: m[3], body: m[4] });
    }
  }
  return out;
}

/**
 * @returns {Promise<Array<{revision:number, editedAt:string, editedBy:string,
 *   body:string|null, bodyError?:string}>>}
 */
export async function readHistory(sessionsDir, msgId) {
  const path = filename(sessionsDir, msgId);
  if (!existsSync(path)) return [];
  const text = await readFile(path, 'utf8');
  const fenced = readFenced(text.split('\n'), encodeMarkerValue(msgId ?? ''));
  return fenced ?? readLegacy(text);
}
