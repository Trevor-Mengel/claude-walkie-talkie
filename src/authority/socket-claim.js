/**
 * Proving that a socket address is free.
 *
 * Both listening sockets — the authority's enrollment socket and the service's
 * transport socket — face the same problem. An AF_UNIX socket file outlives the
 * process that bound it, so a SIGKILLed daemon leaves an inode that `bind()` will
 * refuse with EADDRINUSE until somebody unlinks it. Unlinking it while a listener is
 * still there is address theft: the incumbent keeps serving a socket nobody can reach
 * any more, and its clients silently move to the thief.
 *
 * The obvious test — connect and see — cannot decide this. `connect()` answers about
 * the accept queue, not about the listener:
 *
 *   - A listener whose queue is full refuses connections exactly as an abandoned inode
 *     does. The queue fills whenever the owner stops calling `accept()`: a long
 *     synchronous stretch, a stop-the-world GC, a stopped process. Measured on darwin
 *     25.5 the queue caps at `kern.ipc.somaxconn` (128) no matter what backlog was
 *     requested, and connection 129 to a live, wedged listener returns ENOENT.
 *   - A connect that times out says only that the machine is busy. Under a loaded
 *     event loop that is the normal answer for a perfectly healthy listener.
 *
 * So a refused or timed-out connect is not evidence of death, and this module never
 * treats it as such. Liveness is not inferred, it is claimed: a process that binds a
 * socket writes its pid beside it and removes that claim on clean shutdown. An address
 * may then be reclaimed on exactly one ground — a claim naming a pid that is gone.
 *
 * Everything else refuses. That includes an address with no claim at all: without one
 * there is no proof of death, and the safe answer to "I cannot tell" is to stop rather
 * than to unlink. The cost is an operator having to remove a socket left behind by
 * something that never wrote a claim; the alternative cost is a live service losing its
 * address, which is not recoverable by the operator because they cannot see it happen.
 *
 * A dead pid can be a recycled one, which makes a gone owner look live and lands us in
 * "refuse" — the fail-closed direction, and the same reason `src/daemon/lifecycle.js`
 * refuses to treat `kill(pid, 0)` as proof of identity. Proof of *death* is the only
 * direction that predicate is sound in, and it is the only direction used here.
 */

import { lstatSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';

/** A claim sits beside the socket it describes: `collabcast.sock` -> `collabcast.sock.owner`. */
export const OWNER_SUFFIX = '.owner';

/** The claim names a pid, which is as sensitive as the socket it guards. */
export const OWNER_FILE_MODE = 0o600;

/** Long enough that a healthy listener answers, short enough not to stall a start. */
export const CLAIM_PROBE_TIMEOUT_MS = 500;

/** @param {string} socketPath */
export function socketOwnerPath(socketPath) {
  return `${socketPath}${OWNER_SUFFIX}`;
}

/**
 * Records this process as the owner of `socketPath`.
 *
 * Called after the bind succeeds, never before: a claim written speculatively and then
 * abandoned would name a dead pid while the real incumbent kept listening, which is the
 * theft this module exists to prevent. The window between a successful bind and this
 * write is the one case that leaves an unclaimed socket, and an unclaimed socket
 * refuses — the narrow failure is a refusal, not a theft.
 *
 * @param {string} socketPath
 */
export function claimSocketAddress(socketPath) {
  writeFileSync(socketOwnerPath(socketPath), `${process.pid}\n`, { mode: OWNER_FILE_MODE });
}

/** @param {string} socketPath */
export function releaseSocketAddress(socketPath) {
  try {
    unlinkSync(socketOwnerPath(socketPath));
  } catch {
    // Already gone: another shutdown path, or an operator, removed it.
  }
}

/**
 * The pid claiming `socketPath`, or null when there is no readable claim.
 * @param {string} socketPath
 * @returns {number|null}
 */
export function readSocketOwner(socketPath) {
  let text;
  try {
    text = readFileSync(socketOwnerPath(socketPath), 'utf8');
  } catch {
    return null;
  }
  const pid = Number(text.trim());
  // A truncated or garbled claim is no claim: it cannot prove anybody dead.
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/**
 * What the claim beside `socketPath` says about its owner.
 *
 * `EPERM` means the process exists and belongs to another user, so it counts as live.
 * Only `ESRCH` — no such process — is proof of death.
 *
 * @param {string} socketPath
 * @returns {'unclaimed'|'gone'|'live'}
 */
export function socketOwnerState(socketPath) {
  const pid = readSocketOwner(socketPath);
  if (pid === null) return 'unclaimed';
  try {
    process.kill(pid, 0);
    return 'live';
  } catch (err) {
    return err?.code === 'ESRCH' ? 'gone' : 'live';
  }
}

/**
 * What a single `connect()` attempt observed.
 *
 * Three values rather than a boolean, because the three mean different things and only
 * one of them is ever allowed to authorise an unlink:
 *
 *   - `listening` — a connect succeeded. Proof of life.
 *   - `refused`   — the kernel rejected it. Consistent with an abandoned inode AND with
 *                   a live listener whose accept queue is full. Proves nothing on its own.
 *   - `indeterminate` — nothing answered within the window. A busy machine looks exactly
 *                   like this, so it is read as live.
 *
 * @param {string} socketPath
 * @param {{timeoutMs?:number}} [opts]
 * @returns {Promise<'listening'|'refused'|'indeterminate'>}
 */
export function probeSocketState(socketPath, { timeoutMs = CLAIM_PROBE_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const socket = connect({ path: socketPath });
    const finish = (state) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve(state);
    };
    socket.setTimeout(timeoutMs, () => finish('indeterminate'));
    socket.once('connect', () => finish('listening'));
    socket.once('error', () => finish('refused'));
  });
}

/**
 * Can `socketPath` be bound?
 *
 *   - `free`         — nothing is there.
 *   - `not-a-socket` — something else occupies the path. Never removable: that would make
 *                      this a file-deletion primitive pointed at an operator's data.
 *   - `stale`        — a socket whose owner is provably gone and which nothing answers on.
 *                      The only reclaimable state.
 *   - `occupied`     — a socket whose owner is live, or which answered a connect.
 *   - `unclaimed`    — a socket with no readable claim. Not provably dead, so not reclaimable.
 *
 * @param {string} socketPath
 * @param {{probe?:typeof probeSocketState, timeoutMs?:number}} [opts]
 * @returns {Promise<'free'|'not-a-socket'|'stale'|'occupied'|'unclaimed'>}
 */
export async function socketAddressState(
  socketPath,
  { probe = probeSocketState, timeoutMs = CLAIM_PROBE_TIMEOUT_MS } = {}
) {
  let stat;
  try {
    // lstat, not stat: a symlink at the address is not a socket, and following it would
    // aim the unlink at whatever it points to.
    stat = lstatSync(socketPath);
  } catch {
    return 'free';
  }
  if (!stat.isSocket()) return 'not-a-socket';

  const owner = socketOwnerState(socketPath);
  if (owner !== 'gone') return owner === 'live' ? 'occupied' : 'unclaimed';

  // The claim says the owner died. One last look for a listener anyway — an inherited
  // descriptor can outlive the process that opened it — and anything short of a hard
  // refusal keeps the address.
  return (await probe(socketPath, { timeoutMs })) === 'refused' ? 'stale' : 'occupied';
}

/**
 * Removes a socket proven stale, and the claim that proved it.
 * @param {string} socketPath
 */
export function unlinkSocketAddress(socketPath) {
  unlinkSync(socketPath);
  releaseSocketAddress(socketPath);
}
