import { statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { WalkieError, describeValue } from '../identity/errors.js';
import { assertNamespace } from '../identity/namespace.js';
import { canonicalizePath, containsOrEquals, isInside } from '../identity/paths.js';

/**
 * The per-identity config schema. **Every default value in the product lives here.** Consuming
 * logic must import DEFAULT_CONFIG (or the helpers below) rather than repeating a literal.
 */

export const CONFIG_SCHEMA_VERSION = 3;
export const WALKIE_DIRNAME = '.walkie-talkie';
export const CONFIG_FILENAME = 'config.json';
export const HISTORY_DIRNAME = 'history';
export const STORE_DIRNAME = 'store';

export const MODES = Object.freeze(['managed', 'standalone']);
export const PRUNE_CADENCES = Object.freeze(['daily', 'weekly', 'monthly']);
export const LOOPBACK_HOSTS = Object.freeze(['127.0.0.1', '::1']);

export const RETENTION_LIMITS = Object.freeze({
  hotDaysMin: 1,
  hotDaysMax: 3650,
  snapshotGenerationsMin: 2
});

/**
 * A JSON body below 1 KiB cannot hold a legal message; above 16 MiB it is a memory-exhaustion
 * lever against a single-process daemon. The HTTP limit is deliberately the looser outer bound —
 * a single message body is capped far tighter by core/validate.js.
 */
export const TRANSPORT_LIMITS = Object.freeze({
  maxBodyBytesMin: 1024,
  maxBodyBytesMax: 16 * 1024 * 1024,
  portMin: 0,
  portMax: 65535
});

/** The mode a directory holding a listening socket must have: owner-only, always. */
export const SOCKET_DIR_MODE = 0o700;

export const DEFAULT_CONFIG = Object.freeze({
  schemaVersion: CONFIG_SCHEMA_VERSION,
  mode: 'managed',
  transport: Object.freeze({
    unixSocket: true,
    // null means "derive from the runtime root via resolveTransportPaths()".
    socketPath: null,
    maxBodyBytes: 1024 * 1024,
    // port 0 asks the kernel for an ephemeral port; the host is always bound explicitly.
    tcp: Object.freeze({ enabled: false, host: '127.0.0.1', port: 0 })
  }),
  retention: Object.freeze({
    hotDays: 90,
    snapshotGenerations: 30,
    pruneCadence: 'weekly',
    // null means "derive from canonicalRoot via defaultHistoryDir()".
    historyDir: null
  }),
  routing: Object.freeze({ root: null, hubs: Object.freeze({}) })
});

/** `<canonicalRoot>/.walkie-talkie` */
export function walkieDir(canonicalRoot) {
  return join(canonicalRoot, WALKIE_DIRNAME);
}

/** `<canonicalRoot>/.walkie-talkie/config.json` */
export function configPath(canonicalRoot) {
  return join(walkieDir(canonicalRoot), CONFIG_FILENAME);
}

/** `<canonicalRoot>/.walkie-talkie/history` — snapshot/rollback material. */
export function defaultHistoryDir(canonicalRoot) {
  return join(walkieDir(canonicalRoot), HISTORY_DIRNAME);
}

/**
 * `<canonicalRoot>/.walkie-talkie/store` — the live SQLite store and its WAL/SHM siblings.
 * Reserved as a whole directory: the store owner clamps it to 0700 because it holds
 * capability-token hashes, so nothing else may resolve into it.
 */
export function storeDir(canonicalRoot) {
  return join(walkieDir(canonicalRoot), STORE_DIRNAME);
}

function invalid(message, detail) {
  return new WalkieError('config_invalid', message, detail);
}

function requirePlainObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid(`${label} must be an object (got ${describeValue(value)})`);
  }
  return value;
}

function rejectUnknownKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw invalid(`unknown key ${JSON.stringify(key)} in ${label}`, { key, allowed });
    }
  }
}

function pick(raw, key, fallback) {
  return raw[key] === undefined ? fallback : raw[key];
}

function requireBoolean(value, label) {
  if (typeof value !== 'boolean') {
    throw invalid(`${label} must be a boolean (got ${describeValue(value)})`);
  }
  return value;
}

function requireEnum(value, allowed, label) {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw invalid(`${label} must be one of ${allowed.join(' | ')} (got ${describeValue(value)})`, {
      allowed
    });
  }
  return value;
}

function requireIntegerAtLeast(value, min, label) {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw invalid(`${label} must be an integer (got ${describeValue(value)})`);
  }
  if (value < min) {
    throw invalid(`${label} must be >= ${min} (got ${value})`, { min });
  }
  return value;
}

function requireIntegerInRange(value, min, max, label) {
  requireIntegerAtLeast(value, min, label);
  if (value > max) {
    throw invalid(`${label} must be <= ${max} (got ${value})`, { min, max });
  }
  return value;
}

function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw invalid(`${label} must be a non-empty string (got ${describeValue(value)})`);
  }
  return value;
}

/**
 * A socket path is a credential boundary: the kernel's only check on "who may talk to this
 * daemon" is the mode of the directory holding the socket. So the path must be absolute (a
 * relative AF_UNIX path resolves against an attacker-influenceable cwd), and if its parent
 * already exists it must already be owner-only. A parent that does not exist yet is fine —
 * the transport creates it at SOCKET_DIR_MODE.
 */
function validateSocketPath(value) {
  if (value === undefined || value === null) return DEFAULT_CONFIG.transport.socketPath;
  const path = requireNonEmptyString(value, 'transport.socketPath');
  if (!isAbsolute(path)) {
    throw invalid(
      `transport.socketPath must be an absolute path (got ${describeValue(path)})`
    );
  }
  const parent = dirname(path);
  let mode;
  try {
    mode = statSync(parent).mode & 0o777;
  } catch {
    // Not created yet: the transport will mkdir it at SOCKET_DIR_MODE.
    return path;
  }
  if (mode !== SOCKET_DIR_MODE) {
    throw invalid(
      'the directory holding transport.socketPath must be owner-only ' +
        `(mode ${SOCKET_DIR_MODE.toString(8)}, found ${mode.toString(8)})`,
      { required: SOCKET_DIR_MODE.toString(8), found: mode.toString(8) }
    );
  }
  return path;
}

function validateTransport(raw) {
  const transport = requirePlainObject(
    pick(raw, 'transport', DEFAULT_CONFIG.transport),
    'transport'
  );
  rejectUnknownKeys(
    transport,
    ['unixSocket', 'socketPath', 'maxBodyBytes', 'tcp'],
    'transport'
  );
  const unixSocket = requireBoolean(
    pick(transport, 'unixSocket', DEFAULT_CONFIG.transport.unixSocket),
    'transport.unixSocket'
  );
  const socketPath = validateSocketPath(transport.socketPath);
  const maxBodyBytes = requireIntegerInRange(
    pick(transport, 'maxBodyBytes', DEFAULT_CONFIG.transport.maxBodyBytes),
    TRANSPORT_LIMITS.maxBodyBytesMin,
    TRANSPORT_LIMITS.maxBodyBytesMax,
    'transport.maxBodyBytes'
  );
  const tcpRaw = requirePlainObject(
    pick(transport, 'tcp', DEFAULT_CONFIG.transport.tcp),
    'transport.tcp'
  );
  rejectUnknownKeys(tcpRaw, ['enabled', 'host', 'port'], 'transport.tcp');
  const enabled = requireBoolean(
    pick(tcpRaw, 'enabled', DEFAULT_CONFIG.transport.tcp.enabled),
    'transport.tcp.enabled'
  );
  const host = requireNonEmptyString(
    pick(tcpRaw, 'host', DEFAULT_CONFIG.transport.tcp.host),
    'transport.tcp.host'
  );
  const port = requireIntegerInRange(
    pick(tcpRaw, 'port', DEFAULT_CONFIG.transport.tcp.port),
    TRANSPORT_LIMITS.portMin,
    TRANSPORT_LIMITS.portMax,
    'transport.tcp.port'
  );
  if (enabled && !LOOPBACK_HOSTS.includes(host)) {
    throw invalid(
      `transport.tcp.host must be loopback (${LOOPBACK_HOSTS.join(' or ')}) when tcp is ` +
        `enabled (got ${describeValue(host)})`,
      { allowed: LOOPBACK_HOSTS }
    );
  }
  // TCP-only means the tcp address IS the address every client dials, and there is no port
  // file any more for the kernel's choice to be published in: `resolveClientContext` reads
  // `transport.tcp.port` straight out of this config. Port 0 therefore binds an ephemeral
  // port that nothing can ever discover — the service comes up healthy and every client
  // fails with `unavailable`, blaming the operator for a service that is running. Port 0
  // stays legal while the Unix socket is on, where tcp is only ever an extra listener.
  if (!unixSocket && port === 0) {
    throw invalid(
      'transport.tcp.port must be a fixed non-zero port when transport.unixSocket is false: ' +
        'port 0 asks the kernel for an ephemeral port, and with no Unix socket and no port ' +
        'file there is nothing for a client to read it from',
      { port, unixSocket }
    );
  }
  return { unixSocket, socketPath, maxBodyBytes, tcp: { enabled, host, port } };
}

function validateHistoryDir(value, { canonicalRoot, liveStoreDir }) {
  const raw = value === undefined || value === null ? defaultHistoryDir(canonicalRoot) : value;
  if (typeof raw !== 'string' || raw.length === 0) {
    throw invalid(`retention.historyDir must be a non-empty string (got ${describeValue(raw)})`);
  }
  const historyDir = canonicalizePath(isAbsolute(raw) ? raw : join(canonicalRoot, raw));
  if (historyDir === canonicalRoot) {
    throw invalid('retention.historyDir must not be the canonicalRoot itself');
  }
  if (!isInside(historyDir, canonicalRoot)) {
    throw invalid('retention.historyDir must be inside canonicalRoot', {
      historyDir,
      canonicalRoot
    });
  }
  if (containsOrEquals(historyDir, liveStoreDir) || containsOrEquals(liveStoreDir, historyDir)) {
    throw invalid('retention.historyDir must not overlap the live store directory', {
      historyDir,
      storeDir: liveStoreDir
    });
  }
  return historyDir;
}

function validateRetention(raw, { canonicalRoot, liveStoreDir }) {
  const retention = requirePlainObject(
    pick(raw, 'retention', DEFAULT_CONFIG.retention),
    'retention'
  );
  rejectUnknownKeys(
    retention,
    ['hotDays', 'snapshotGenerations', 'pruneCadence', 'historyDir'],
    'retention'
  );
  const hotDays = requireIntegerInRange(
    pick(retention, 'hotDays', DEFAULT_CONFIG.retention.hotDays),
    RETENTION_LIMITS.hotDaysMin,
    RETENTION_LIMITS.hotDaysMax,
    'retention.hotDays'
  );
  const snapshotGenerations = requireIntegerAtLeast(
    pick(retention, 'snapshotGenerations', DEFAULT_CONFIG.retention.snapshotGenerations),
    RETENTION_LIMITS.snapshotGenerationsMin,
    'retention.snapshotGenerations'
  );
  const pruneCadence = requireEnum(
    pick(retention, 'pruneCadence', DEFAULT_CONFIG.retention.pruneCadence),
    PRUNE_CADENCES,
    'retention.pruneCadence'
  );
  const historyDir = validateHistoryDir(retention.historyDir, { canonicalRoot, liveStoreDir });
  return { hotDays, snapshotGenerations, pruneCadence, historyDir };
}

function validateTarget(value, label) {
  const target = requirePlainObject(value, label);
  rejectUnknownKeys(target, ['paseoAgentId'], label);
  return { paseoAgentId: requireNonEmptyString(target.paseoAgentId, `${label}.paseoAgentId`) };
}

function validateRouting(raw) {
  const routing = requirePlainObject(pick(raw, 'routing', DEFAULT_CONFIG.routing), 'routing');
  rejectUnknownKeys(routing, ['root', 'hubs'], 'routing');
  const rootRaw = pick(routing, 'root', DEFAULT_CONFIG.routing.root);
  const root = rootRaw === null ? null : validateTarget(rootRaw, 'routing.root');
  const hubsRaw = requirePlainObject(
    pick(routing, 'hubs', DEFAULT_CONFIG.routing.hubs),
    'routing.hubs'
  );
  const hubs = {};
  for (const [name, hub] of Object.entries(hubsRaw)) {
    requireNonEmptyString(name, 'routing.hubs key');
    hubs[name] = validateTarget(hub, `routing.hubs.${name}`);
  }
  return { root, hubs };
}

/**
 * Validates a raw per-identity config and returns the effective config with schema defaults
 * applied. Fails closed with `config_invalid` and a precise message.
 *
 * @param {unknown} raw
 * @param {{canonicalRoot:string, expectNamespace?:string, storeDir?:string}} opts
 */
export function validateConfig(raw, opts) {
  const { expectNamespace } = opts ?? {};
  if (typeof opts?.canonicalRoot !== 'string' || !isAbsolute(opts.canonicalRoot)) {
    throw invalid(
      `canonicalRoot must be an absolute path (got ${describeValue(opts?.canonicalRoot)})`
    );
  }
  const canonicalRoot = canonicalizePath(opts.canonicalRoot);
  const liveStoreDir = canonicalizePath(
    opts.storeDir === undefined ? storeDir(canonicalRoot) : resolve(opts.storeDir)
  );

  const config = requirePlainObject(raw, 'config');
  rejectUnknownKeys(
    config,
    ['schemaVersion', 'namespace', 'mode', 'transport', 'retention', 'routing'],
    'config'
  );

  if (config.schemaVersion !== CONFIG_SCHEMA_VERSION) {
    throw invalid(
      `config schemaVersion must be ${CONFIG_SCHEMA_VERSION} ` +
        `(got ${describeValue(config.schemaVersion)})`
    );
  }
  const namespace = assertNamespace(config.namespace, { label: 'config.namespace' });
  if (expectNamespace !== undefined && namespace !== expectNamespace) {
    throw invalid(`config.namespace is ${namespace} but this root resolves to ${expectNamespace}`, {
      configured: namespace,
      resolved: expectNamespace
    });
  }

  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    namespace,
    mode: requireEnum(pick(config, 'mode', DEFAULT_CONFIG.mode), MODES, 'mode'),
    transport: validateTransport(config),
    retention: validateRetention(config, { canonicalRoot, liveStoreDir }),
    routing: validateRouting(config)
  };
}
