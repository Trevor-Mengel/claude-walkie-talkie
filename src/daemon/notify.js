import notifier from 'node-notifier';

const TITLE = 'walkie-talkie';

export function attachNotifier({ events, projectName = 'project' }) {
  const fire = (title, message) => {
    try {
      notifier.notify({ title, message, sound: false, timeout: 5 });
    } catch (_e) {
      // best-effort; silently swallow in environments without a graphical session
    }
  };
  events.on('message.posted', (p) => {
    if (p.from === 'operator') return;
    fire(`${TITLE} — ${projectName}`, `New message (${p.type}) from ${p.from}`);
  });
  events.on('permit.required', (p) => {
    fire(`${TITLE} — permit required`, `${p.session_id} wants to send. Run: walkie permit ${p.session_id} --once`);
  });
}
