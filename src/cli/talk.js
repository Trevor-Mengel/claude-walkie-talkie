import { clientForProject } from './client.js';
import { ask } from './prompt.js';

export async function talkCommand(body, opts) {
  const projectRoot = process.cwd();
  const client = clientForProject(projectRoot);
  const data = {
    body,
    type: opts.type || 'broadcast',
    fromSessionId: 'operator',
    fromAlias: opts.as || 'operator',
    fromTool: 'operator'
  };
  let res;
  try {
    res = await client.post(data);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  console.log(`Posted ${res.id}`);
  if (res.warnings?.length) {
    for (const w of res.warnings) {
      if (w.type !== 'unresolved-mention') continue;
      console.log(`⚠️  @${w.token} is not in this channel.`);
      if (opts.invite === false) {
        console.log(`   (--no-invite supplied; sent as-is)`);
        continue;
      }
      const reply = await ask(`   Invite @${w.token} for a future session? [y/N] `);
      if (reply.toLowerCase().startsWith('y')) {
        await client.invite(w.token);
        console.log(`   Invited @${w.token}. When a matching session joins, run \`walkie alias <session-id> ${w.token}\` to fulfill.`);
      } else {
        console.log(`   Sent as-is.`);
      }
    }
  }
}
