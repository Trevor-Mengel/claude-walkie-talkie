const TOOL_EMOJI = {
  'claude-code': '📡',
  'claude-cowork': '🎨',
  operator: '👤'
};

function emojiForTool(tool) {
  return TOOL_EMOJI[tool] ?? '⚡';
}

function renderRecipients(mentions) {
  if (!mentions || mentions.length === 0) return 'all';
  return mentions.map((m) => (m.startsWith('@') ? m : `@${m}`)).join(', ');
}

function renderMarker(msg) {
  const parts = [`id=${msg.id}`, `type=${msg.type}`, `from=${msg.fromSessionId}`];
  if (msg.mentions?.length) parts.push(`mentions=${msg.mentions.join(',')}`);
  if (msg.mentionsPending?.length) parts.push(`mentions-pending=${msg.mentionsPending.join(',')}`);
  if (msg.replyTo) parts.push(`reply-to=${msg.replyTo}`);
  if (msg.revision) parts.push(`revision=${msg.revision}`);
  if (msg.editedAt) parts.push(`edited-at=${msg.editedAt}`);
  if (msg.archived) parts.push('archived=true');
  if (msg.archivedBy) parts.push(`archived-by=${msg.archivedBy}`);
  if (msg.archivedReason) parts.push(`archived-reason="${msg.archivedReason}"`);
  if (msg.autonomous) parts.push('[autonomous]');
  return `<!-- walkie:msg ${parts.join(' ')} -->`;
}

/** @param {object} msg */
export function formatMessage(msg) {
  const emoji = emojiForTool(msg.fromTool);
  const robot = msg.autonomous ? '🤖 ' : '';
  const sender = msg.fromAlias || msg.fromSessionId;
  const recipients = renderRecipients(msg.mentions);
  const sig = `## ${emoji} ${robot}${sender} → ${recipients}`;
  const marker = renderMarker(msg);
  const lines = [sig, marker, `**Time:** ${msg.timestamp}`];
  if (msg.git && (msg.git.branch || msg.git.hash)) {
    const author = msg.git.userEmail || msg.git.userName || '';
    const authorPart = author ? ` (${author})` : '';
    const hashPart = msg.git.hash ? ` @ ${msg.git.hash}` : '';
    lines.push(`**Git:** ${msg.git.branch || '(no branch)'}${hashPart}${authorPart}`);
  }
  if (msg.revision) {
    lines.push(
      `**Edited:** revision ${msg.revision} at ${msg.editedAt} — run \`walkie history ${msg.id}\` for prior versions`
    );
  }
  lines.push('');
  if (msg.archived) {
    lines.push(
      `> 🗄️ ARCHIVED by ${msg.archivedBy}${msg.archivedReason ? ` — ${msg.archivedReason}` : ''}`
    );
    lines.push('');
    lines.push('<details><summary>Show archived content</summary>');
    lines.push('');
    lines.push(msg.body.trim());
    lines.push('');
    lines.push('</details>');
  } else {
    lines.push(msg.body.trim());
  }
  lines.push('');
  lines.push('---');
  lines.push('');
  return lines.join('\n');
}

const MARKER_RE = /<!--\s*walkie:msg\s+(.+?)\s*-->/;

function parseMarker(line) {
  const m = line.match(MARKER_RE);
  if (!m) return null;
  const out = { autonomous: false, archived: false, mentions: [], mentionsPending: [] };
  const tokens = m[1].match(/(?:[a-z-]+="[^"]*"|[a-z-]+=[^\s]+|\[autonomous\])/gi) ?? [];
  for (const tok of tokens) {
    if (tok === '[autonomous]') {
      out.autonomous = true;
      continue;
    }
    const eq = tok.indexOf('=');
    const key = tok.slice(0, eq);
    let val = tok.slice(eq + 1);
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
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
  return out;
}

/** @param {string} block — a single message block (heading through `---`) */
export function parseMessage(block) {
  const lines = block.split('\n');
  let headingIdx = -1;
  let markerIdx = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (headingIdx === -1 && lines[i].startsWith('## ')) headingIdx = i;
    if (markerIdx === -1 && MARKER_RE.test(lines[i])) markerIdx = i;
    if (headingIdx !== -1 && markerIdx !== -1) break;
  }
  if (headingIdx === -1 || markerIdx === -1) return null;
  const marker = parseMarker(lines[markerIdx]);
  if (!marker) return null;
  const head = lines[headingIdx].replace(/^##\s+/, '');
  const senderMatch = head.match(/^[^\s]+\s+(?:🤖\s+)?(\S.*?)\s+→\s+(.+)$/);
  if (senderMatch) {
    marker.fromAlias = senderMatch[1];
  }
  let bodyStart = markerIdx + 1;
  while (bodyStart < lines.length && lines[bodyStart].trim() !== '') bodyStart += 1;
  bodyStart += 1;
  let bodyEnd = lines.length;
  for (let i = bodyStart; i < lines.length; i += 1) {
    if (lines[i].trim() === '---') {
      bodyEnd = i;
      break;
    }
  }
  marker.body = lines.slice(bodyStart, bodyEnd).join('\n');
  return marker;
}
