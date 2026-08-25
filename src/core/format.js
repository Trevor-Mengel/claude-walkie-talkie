import { isValidMessageType, isValidReplyTo } from './validate.js';

const TOOL_EMOJI = {
  'claude-code': '📡',
  'claude-cowork': '🎨',
  operator: '👤'
};

function emojiForTool(tool) {
  return TOOL_EMOJI[tool] ?? '⚡';
}

/**
 * The `walkie:` marker namespace used throughout this module is DELIBERATELY NOT RENAMED to
 * `collabcast:` with the rest of the product. It is the on-disk contract in `channel.md`:
 * invisible to users, and `isValidMessageBody` rejects that exact literal in a body, which is
 * the whole unforgeability argument for both the message marker and the body fence. Renaming
 * it would force a migration of a file P1 converts into a generated projection anyway, so the
 * prefix rides the v0.2 -> v0.3 importer instead. Do not "finish" the rename here.
 */

/**
 * Heading text is a rendering — but `parseMessage` reads the alias back out of the
 * heading and `editMessage`/`archiveMessage` re-render from that parse, so it has to
 * be both unable to carry markup and exactly invertible.
 *
 * A heading that could contain `<`, `>` or `"` could carry a COMPLETE
 * `<!-- walkie:msg ... -->` comment, and the heading is line 0 of every block —
 * one line above the real marker. That forged marker would name any id and any
 * author the attacker liked (two blocks sharing one id, an edit or archive by the
 * named author rewriting the poisoned block, one acknowledgement covering both).
 *
 * Escaping is the same `%XX`-of-UTF-8-bytes scheme `encodeMarkerValue` uses, over a
 * heading-specific unsafe set:
 *   - `<` `>` `"`  → a heading can never open, close or sit inside a comment
 *   - `%`          → so the encoding is invertible and an alias containing a
 *                    literal `%` does not grow on every edit
 *   - C0 / DEL     → a heading is exactly one line
 *   - `→`          → the heading's own sender/recipient separator, so the alias
 *                    that parses back out is exactly the alias that was rendered
 *                    (and an alias cannot fake the recipient list a human reads)
 * Space is deliberately NOT escaped: it cannot break a heading and aliases with
 * spaces have to stay readable.
 */
function headingText(value) {
  return percentEncode(value ?? '', HEADING_UNSAFE_RE);
}

function renderRecipients(mentions) {
  if (!mentions || mentions.length === 0) return 'all';
  return mentions.map((m) => (m.startsWith('@') ? m : `@${m}`)).join(', ');
}

function invalid(message) {
  const err = new Error(message);
  err.code = 'invalid_request';
  return err;
}

/** A stored block we could not fully read. Re-rendering one would persist the loss. */
function corrupt(message, detail) {
  const err = new Error(message);
  err.code = 'conflict';
  if (detail !== undefined) err.detail = detail;
  return err;
}

/**
 * Marker values are percent-escaped so no value can inject another marker field
 * or break out of the comment:
 *   - any whitespace  → would start a second `key=value` token (v0.2 let a
 *     `type` of `broadcast id=<other-ulid>` override the parsed `id`)
 *   - `<` / `>`       → would open or close the HTML comment (`-->`)
 *   - `"`             → would break a quoted value
 *   - `%`             → escaped so the encoding is invertible
 * Everything else stays literal, so `:` in ISO timestamps, `@`/`.` in emails and
 * `/` in branch names keep the marker human-readable.
 */
const MARKER_UNSAFE_RE = /[%<>"\u0000-\u0020\u007f]/g;
/** @see headingText — same scheme, narrower set, `→` added, space left literal. */
const HEADING_UNSAFE_RE = /[%<>"\u0000-\u001f\u007f\u2192]/g;
const HEX_PAIR_RE = /^[0-9a-fA-F]{2}$/;

function percentEncode(value, unsafe) {
  return String(value).replace(unsafe, (ch) => {
    let out = '';
    for (const byte of Buffer.from(ch, 'utf8')) {
      out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
    }
    return out;
  });
}

export function encodeMarkerValue(value) {
  return percentEncode(value, MARKER_UNSAFE_RE);
}

export function decodeMarkerValue(value) {
  if (!value.includes('%')) return value;
  let out = '';
  let i = 0;
  while (i < value.length) {
    if (value[i] === '%' && HEX_PAIR_RE.test(value.slice(i + 1, i + 3))) {
      const bytes = [];
      while (value[i] === '%' && HEX_PAIR_RE.test(value.slice(i + 1, i + 3))) {
        bytes.push(parseInt(value.slice(i + 1, i + 3), 16));
        i += 3;
      }
      out += Buffer.from(bytes).toString('utf8');
    } else {
      out += value[i];
      i += 1;
    }
  }
  return out;
}

function renderMarker(msg) {
  if (!isValidMessageType(msg.type)) {
    throw invalid('invalid message type (expected broadcast|question|reply|memory-update)');
  }
  if (!isValidReplyTo(msg.replyTo)) {
    throw invalid('invalid reply-to (expected a ULID)');
  }
  const enc = encodeMarkerValue;
  const parts = [`id=${enc(msg.id)}`, `type=${msg.type}`, `from=${enc(msg.fromSessionId)}`];
  if (msg.fromTool) parts.push(`from-tool=${enc(msg.fromTool)}`);
  if (msg.timestamp) parts.push(`timestamp=${enc(msg.timestamp)}`);
  if (msg.mentions?.length) parts.push(`mentions=${msg.mentions.map(enc).join(',')}`);
  if (msg.mentionsPending?.length) {
    parts.push(`mentions-pending=${msg.mentionsPending.map(enc).join(',')}`);
  }
  if (msg.replyTo) parts.push(`reply-to=${enc(msg.replyTo)}`);
  if (msg.revision) parts.push(`revision=${enc(msg.revision)}`);
  if (msg.editedAt) parts.push(`edited-at=${enc(msg.editedAt)}`);
  // Git provenance lives in the marker so it round-trips through edit/archive.
  // v0.2 only rendered the human `**Git:**` line, so every edit silently dropped it.
  if (msg.git) {
    if (msg.git.branch) parts.push(`git-branch=${enc(msg.git.branch)}`);
    if (msg.git.hash) parts.push(`git-hash=${enc(msg.git.hash)}`);
    if (msg.git.userName) parts.push(`git-user-name=${enc(msg.git.userName)}`);
    if (msg.git.userEmail) parts.push(`git-user-email=${enc(msg.git.userEmail)}`);
  }
  if (msg.archived) parts.push('archived=true');
  if (msg.archivedBy) parts.push(`archived-by=${enc(msg.archivedBy)}`);
  if (msg.archivedReason) parts.push(`archived-reason="${enc(msg.archivedReason)}"`);
  if (msg.autonomous) parts.push('[autonomous]');
  return `<!-- walkie:msg ${parts.join(' ')} -->`;
}

/**
 * Body delimiters.
 *
 * v0.2 ended the body at the first line whose `trim() === '---'`, so any body
 * containing a horizontal rule, YAML front matter or a pasted diff parsed
 * truncated — and `editMessage`/`archiveMessage` then re-rendered from that
 * truncated parse and wrote it back, destroying the tail permanently. The body is
 * now fenced by explicit, id-bound HTML comments that a body can never contain
 * (`isValidMessageBody` rejects every `<!-- walkie:` sequence).
 *
 * ON-DISK FORMAT CHANGE: message blocks gain two invisible comment lines around
 * the body. The `---` separator between messages is unchanged, and blocks written
 * by v0.2 (no body fence) still parse through the legacy fallback below.
 */
const BODY_OPEN_RE = /^<!--\s*walkie:body\s+id=(\S+)\s*-->$/;
const BODY_CLOSE_RE = /^<!--\s*walkie:body-end\s+id=(\S+)\s*-->$/;

function bodyOpen(id) {
  return `<!-- walkie:body id=${encodeMarkerValue(id)} -->`;
}

function bodyClose(id) {
  return `<!-- walkie:body-end id=${encodeMarkerValue(id)} -->`;
}

/** @param {object} msg */
export function formatMessage(msg) {
  // Backstop for every re-render path: `parseMessage` marks a block whose body it
  // could not recover, and rendering that parse would write the truncation to disk.
  if (msg.bodyError) {
    throw corrupt(
      `refusing to re-render message ${msg.id}: its stored body could not be parsed ` +
        `(${msg.bodyError})`,
      { id: msg.id, reason: msg.bodyError }
    );
  }
  const emoji = emojiForTool(msg.fromTool);
  const robot = msg.autonomous ? '🤖 ' : '';
  const sender = headingText(msg.fromAlias || msg.fromSessionId);
  const recipients = headingText(renderRecipients(msg.mentions));
  const sig = `## ${emoji} ${robot}${sender} → ${recipients}`;
  const marker = renderMarker(msg);
  // Every value interpolated below is `headingText`-escaped, for exactly the reason the
  // heading is. These lines sit INSIDE a message block, one line below the marker, so a
  // value carrying a newline plus a `<!-- walkie:msg ... -->` line appends a SECOND,
  // fully-formed block to a single post — with an attacker-chosen `id`, `from`, `type`
  // and `mentions`, indistinguishable downstream from a real message and owned (for
  // edit/archive) by whoever holds the forged `from`.
  //
  // That was reachable: `gitMetadata` reads `git config --local user.name/user.email`,
  // git genuinely stores and returns embedded newlines, and `.trim()` strips only the
  // edges — so one benign authenticated post by anyone who could write `.git/config`
  // (devcontainer bootstrap, CI setup, any `git config` call) wrote two blocks.
  //
  // It is also what makes marker escaping invertible with respect to these lines:
  // `encodeMarkerValue` stores a newline as `%0A`, `decodeMarkerValue` turns it back
  // into a real newline, and every edit and archive re-renders the recovered value here.
  const lines = [sig, marker, `**Time:** ${headingText(msg.timestamp)}`];
  if (msg.git && (msg.git.branch || msg.git.hash)) {
    const author = msg.git.userEmail || msg.git.userName || '';
    const authorPart = author ? ` (${headingText(author)})` : '';
    const hashPart = msg.git.hash ? ` @ ${headingText(msg.git.hash)}` : '';
    const branchPart = msg.git.branch ? headingText(msg.git.branch) : '(no branch)';
    lines.push(`**Git:** ${branchPart}${hashPart}${authorPart}`);
  }
  if (msg.revision) {
    // Names the route that actually serves revisions. This line used to say
    // "run `collabcast history <id>`" — a command that does not exist (`bin/collabcast.js`
    // has no such subcommand) — and unlike a stale log line it is PERSISTED into the
    // operator's channel document, once per edit, forever. Same call as the deleted
    // `notify.js` hint: never durably instruct a human to run a command that fails.
    lines.push(
      `**Edited:** revision ${headingText(msg.revision)} at ${headingText(msg.editedAt)} — prior versions: \`GET /channel/message/${headingText(msg.id)}\``
    );
  }
  lines.push('');
  const fencedBody = [bodyOpen(msg.id), String(msg.body ?? '').trim(), bodyClose(msg.id)];
  if (msg.archived) {
    lines.push(
      `> 🗄️ ARCHIVED by ${headingText(msg.archivedBy)}${msg.archivedReason ? ` — ${headingText(msg.archivedReason)}` : ''}`
    );
    lines.push('');
    lines.push('<details><summary>Show archived content</summary>');
    lines.push('');
    lines.push(...fencedBody);
    lines.push('');
    lines.push('</details>');
  } else {
    lines.push(...fencedBody);
  }
  lines.push('');
  lines.push('---');
  lines.push('');
  return lines.join('\n');
}

/**
 * A marker is only a marker when it OWNS its line.
 *
 * An unanchored search let any line that merely CONTAINED the comment win, and the
 * first such line in a block is the `## ` heading — so a marker smuggled through an
 * alias shadowed the genuine marker one line below it. The anchors also mean a
 * trailing `--> junk -->` cannot hide behind a non-greedy capture: the capture then
 * carries the junk and the token scan below rejects the whole marker.
 */
export const MARKER_LINE_RE = /^<!--\s*walkie:msg\s+(.+?)\s*-->$/;

/** Blank lines a hand-edit may have left between a heading and its marker. */
export const MARKER_LOOKAHEAD_LINES = 3;
const MARKER_TOKEN_RE = /[a-z-]+="[^"]*"|[a-z-]+=\S+|\[autonomous\]/gi;

function parseMarker(line) {
  const m = line.trim().match(MARKER_LINE_RE);
  if (!m) return null;
  const content = m[1];
  const out = { autonomous: false, archived: false, mentions: [], mentionsPending: [] };
  const seen = new Set();
  const git = { branch: null, hash: null, userName: null, userEmail: null };
  let sawGit = false;
  let cursor = 0;
  for (const tok of content.matchAll(MARKER_TOKEN_RE)) {
    // Anything between recognised tokens is junk (or a half-quoted value) — a
    // marker we did not write. Reject rather than guess.
    if (content.slice(cursor, tok.index).trim() !== '') return null;
    cursor = tok.index + tok[0].length;
    const raw = tok[0];
    if (raw.toLowerCase() === '[autonomous]') {
      out.autonomous = true;
      continue;
    }
    const eq = raw.indexOf('=');
    const key = raw.slice(0, eq).toLowerCase();
    // Duplicate keys are how v0.2 could be redirected: last-key-wins let a
    // smuggled `id=` override the real one. A duplicate is always corruption.
    if (seen.has(key)) return null;
    seen.add(key);
    let val = raw.slice(eq + 1);
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    val = decodeMarkerValue(val);
    switch (key) {
      case 'id':
        out.id = val;
        break;
      case 'type':
        out.type = val;
        break;
      case 'from':
        out.fromSessionId = val;
        break;
      case 'from-tool':
        out.fromTool = val;
        break;
      case 'timestamp':
        out.timestamp = val;
        break;
      case 'mentions':
        out.mentions = val.split(',');
        break;
      case 'mentions-pending':
        out.mentionsPending = val.split(',');
        break;
      case 'reply-to':
        out.replyTo = val;
        break;
      case 'revision':
        out.revision = Number(val);
        break;
      case 'edited-at':
        out.editedAt = val;
        break;
      case 'git-branch':
        git.branch = val;
        sawGit = true;
        break;
      case 'git-hash':
        git.hash = val;
        sawGit = true;
        break;
      case 'git-user-name':
        git.userName = val;
        sawGit = true;
        break;
      case 'git-user-email':
        git.userEmail = val;
        sawGit = true;
        break;
      case 'archived':
        out.archived = val === 'true';
        break;
      case 'archived-by':
        out.archivedBy = val;
        break;
      case 'archived-reason':
        out.archivedReason = val;
        break;
      default:
        break;
    }
  }
  if (content.slice(cursor).trim() !== '') return null;
  if (sawGit) out.git = git;
  return out;
}

/**
 * Legacy (v0.2) body capture: everything between the first blank line after the
 * marker and the first bare `---` line. Lossy for bodies containing `---`, which
 * is exactly why the fence above exists — kept only so pre-v0.3 blocks still read.
 */
function legacyBody(lines, markerIdx) {
  let start = markerIdx + 1;
  while (start < lines.length && lines[start].trim() !== '') start += 1;
  start += 1;
  let end = lines.length;
  for (let i = start; i < lines.length; i += 1) {
    if (lines[i].trim() === '---') {
      end = i;
      break;
    }
  }
  // Blank edge lines are separator artefacts, never body content. Indentation is
  // preserved (only wholly-blank lines are dropped).
  return stripBlankEdges(unwrapArchived(lines.slice(start, end))).join('\n');
}

function stripBlankEdges(bodyLines) {
  const out = [...bodyLines];
  while (out.length > 0 && out[0].trim() === '') out.shift();
  while (out.length > 0 && out[out.length - 1].trim() === '') out.pop();
  return out;
}

/**
 * v0.2 returned the whole `<details>` wrapper AS the body, so re-archiving nested
 * the wrapper and grew the file every time. Recover the original body instead.
 */
function unwrapArchived(bodyLines) {
  const openIdx = bodyLines.findIndex((l) => l.trim().startsWith('<details><summary>'));
  if (openIdx === -1) return bodyLines;
  let closeIdx = -1;
  for (let i = bodyLines.length - 1; i > openIdx; i -= 1) {
    if (bodyLines[i].trim() === '</details>') {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx === -1) return bodyLines;
  return stripBlankEdges(bodyLines.slice(openIdx + 1, closeIdx));
}

/**
 * An unterminated body fence is CORRUPTION, not a legacy block.
 *
 * The legacy fallback starts after the first blank line — which in the v0.3 format
 * sits ABOVE the open fence — and ends at the first bare `---`. Running it on a
 * v0.3 block that lost its close fence therefore absorbed the fence comment INTO
 * the body and dropped everything past the first horizontal rule; `editMessage` /
 * `archiveMessage` then re-rendered from that parse and wrote the loss back. That is
 * exactly the data-loss bug the fence was introduced to eliminate, so the fallback
 * is reachable only for a block with no open fence at all.
 */
const CORRUPT_BODY = Symbol('collabcast:unterminated-body-fence');
export const BODY_ERROR_UNTERMINATED = 'unterminated-body-fence';

function extractBody(lines, markerIdx, id) {
  const encoded = encodeMarkerValue(id ?? '');
  let open = -1;
  for (let i = markerIdx + 1; i < lines.length; i += 1) {
    const m = lines[i].trim().match(BODY_OPEN_RE);
    if (m && m[1] === encoded) {
      open = i;
      break;
    }
  }
  if (open !== -1) {
    // Scan backwards: the real close fence is the last one in the block, so a
    // fence smuggled into the body cannot truncate what we recover.
    for (let i = lines.length - 1; i > open; i -= 1) {
      const m = lines[i].trim().match(BODY_CLOSE_RE);
      if (m && m[1] === encoded) return lines.slice(open + 1, i).join('\n');
    }
    return CORRUPT_BODY;
  }
  return legacyBody(lines, markerIdx);
}

/**
 * The marker line for a heading: its own line, within the lookahead window, and
 * never the heading itself. Mirrors `blockStarts` in channel.js so the two agree on
 * what a block is — a parser that accepted a marker the boundary scan rejected (or
 * vice versa) is how one block becomes two, or two become one.
 */
function findMarkerIdx(lines, headingIdx) {
  for (let n = 1; n <= MARKER_LOOKAHEAD_LINES && headingIdx + n < lines.length; n += 1) {
    const line = lines[headingIdx + n].trim();
    if (MARKER_LINE_RE.test(line)) return headingIdx + n;
    // A non-blank line that is not a marker means this heading owns no marker.
    if (line !== '') return -1;
  }
  return -1;
}

/** @param {string} block — a single message block (heading through `---`) */
export function parseMessage(block) {
  const lines = block.split('\n');
  const headingIdx = lines.findIndex((line) => line.startsWith('## '));
  if (headingIdx === -1) return null;
  const markerIdx = findMarkerIdx(lines, headingIdx);
  // Belt and braces: an anchored marker pattern can never match a `## ` heading,
  // and the search starts below the heading — the forged-heading marker that made
  // this a vulnerability is unreachable twice over.
  if (markerIdx === -1 || markerIdx === headingIdx) return null;
  const marker = parseMarker(lines[markerIdx]);
  if (!marker) return null;
  const head = lines[headingIdx].replace(/^##\s+/, '');
  const senderMatch = head.match(/^[^\s]+\s+(?:🤖\s+)?(\S.*?)\s+→\s+(.+)$/);
  if (senderMatch) {
    marker.fromAlias = decodeMarkerValue(senderMatch[1]);
  }
  const body = extractBody(lines, markerIdx, marker.id);
  if (body === CORRUPT_BODY) {
    // Identity still parses, so the block stays visible and keeps its place in the
    // queue — but the body is unknown, and every re-render path refuses it rather
    // than persisting a guess. Repair is a human edit to channel.md.
    marker.body = null;
    marker.bodyError = BODY_ERROR_UNTERMINATED;
    return marker;
  }
  marker.body = body;
  return marker;
}
