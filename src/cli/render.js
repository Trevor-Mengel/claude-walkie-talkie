// src/cli/render.js
import { relative } from '../core/time.js';

const TOOL_EMOJI = { 'claude-code': '📡', 'claude-cowork': '🎨', operator: '👤' };

function emojiFor(msg) {
  if (msg.archived) return '🗄️';
  if (msg.autonomous) return `🤖${TOOL_EMOJI[msg.fromTool] ?? '⚡'}`;
  return TOOL_EMOJI[msg.fromTool] ?? '⚡';
}

export function renderMessage(msg) {
  const recipients = msg.mentions?.length ? msg.mentions.map((m) => `@${m}`).join(', ') : 'all';
  const ago = msg.timestamp ? relative(msg.timestamp) : '';
  const sender = msg.fromAlias || msg.fromSessionId;
  const head = `${emojiFor(msg)} ${sender} → ${recipients}  [${msg.type}]  ${ago}`;
  const lines = [head, `  id: ${msg.id}`];
  if (msg.replyTo) lines.push(`  reply-to: ${msg.replyTo}`);
  if (msg.revision) lines.push(`  edited revision ${msg.revision}`);
  if (msg.archived) lines.push(`  ARCHIVED by ${msg.archivedBy}${msg.archivedReason ? ` — ${msg.archivedReason}` : ''}`);
  const body = (msg.body || '').trim().split('\n').map((l) => `    ${l}`).join('\n');
  if (body) lines.push('', body);
  return lines.join('\n');
}

export function renderMessages(messages) {
  if (!messages.length) return '(no messages)';
  return messages.map(renderMessage).join('\n\n');
}
