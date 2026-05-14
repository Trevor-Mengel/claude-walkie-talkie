// Spawned by concurrent-append.test.js — appends one message and exits.
import { appendMessage } from '../../src/core/channel.js';

const [, , channelPath, idx] = process.argv;

const msg = {
  type: 'broadcast',
  fromSessionId: `worker-${idx}`,
  fromAlias: `worker-${idx}`,
  fromTool: 'operator',
  mentions: [],
  timestamp: new Date().toISOString(),
  git: { branch: null, hash: null, userName: null, userEmail: null },
  body: `message from worker ${idx}`
};

appendMessage(channelPath, msg).then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
