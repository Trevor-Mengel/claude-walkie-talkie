/**
 * Desktop notifications for the human at the keyboard. Nothing here is load-bearing: a
 * missing notifier must never affect a post. That is not licence to hide failures, and
 * three things in the v0.2 version of this file were wrong rather than merely quiet.
 *
 *  - `message.posted` carries `from: <principalId>` (see `routes/channel.js`), not the
 *    literal string `operator`. `if (p.from === 'operator')` therefore never matched, and
 *    the operator got a desktop toast for every message they typed themselves. `operator`
 *    is a ROLE, and the emitter now publishes the poster's role alongside its id, so the
 *    suppression is a field read: this stays a pure presentation consumer, testable with a
 *    bare EventEmitter and with no store lookup on the hot path of every posted message.
 *  - `permit.required` had a subscription here whose body told the operator to run
 *    `collabcast permit <id> --once`. Nothing emits that event any more and that command no
 *    longer exists, so the only thing the listener could ever do was instruct a human to
 *    run a command that would fail. Deleted rather than reworded.
 *  - `notifier.notify` reports a failed spawn (headless box, no notifier binary) through
 *    its CALLBACK; it does not throw. A synchronous try/catch around it was decorative.
 *    Both paths are covered below, and the first failure is reported exactly once: a
 *    headless service would otherwise emit a diagnostic per message, forever.
 */

import notifier from 'node-notifier';

const TITLE = 'collabcast';

/** The role held by the human this notifier exists to interrupt. */
const OPERATOR_ROLE = 'operator';

/**
 * The default diagnostic sink. Notifier trouble is a local-environment fact, not a channel
 * event, so it goes to stderr rather than into the service's stdout event stream.
 *
 * @param {object} entry
 */
function writeDiagnostic(entry) {
  try {
    process.stderr.write(`${JSON.stringify(entry)}\n`);
  } catch {
    // A closed stderr is not a reason to fail a notification.
  }
}

/**
 * @param {object} opts
 * @param {import('node:events').EventEmitter} opts.events
 * @param {string} [opts.projectName]
 * @param {(entry:object) => void} [opts.log] where a notifier failure is reported, once
 */
export function attachNotifier({ events, projectName = 'project', log = writeDiagnostic }) {
  // Kill-switch: tests (and headless CI) must never fire real desktop notifications.
  if (process.env.COLLABCAST_NO_NOTIFY) return;

  let reported = false;
  /**
   * Report the first failure and then stay quiet.
   * @param {string} stage
   * @param {unknown} err
   */
  const report = (stage, err) => {
    if (reported) return;
    reported = true;
    try {
      log({
        event: 'notify.failed',
        stage,
        reason: err instanceof Error ? err.message : String(err),
        note: 'further notifier failures are not reported'
      });
    } catch {
      // Observability is never load-bearing.
    }
  };

  /**
   * @param {string} title
   * @param {string} message
   */
  const fire = (title, message) => {
    try {
      // The callback is the only place a failed spawn shows up; `notify` itself resolves.
      notifier.notify({ title, message, sound: false, timeout: 5 }, (err) => {
        if (err) report('notify', err);
      });
    } catch (err) {
      report('spawn', err);
    }
  };

  events.on('message.posted', (p) => {
    // Only the operator's OWN post is suppressed. An event that names no role is still
    // worth a toast: dropping it would hide a real message to save a redundant one.
    if (p?.role === OPERATOR_ROLE) return;
    const from = typeof p?.from === 'string' && p.from !== '' ? p.from : null;
    const type = typeof p?.type === 'string' && p.type !== '' ? p.type : 'message';
    fire(
      `${TITLE} — ${projectName}`,
      `New message (${type}) from ${from ?? 'an unidentified principal'}`
    );
  });
}
