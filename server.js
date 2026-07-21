import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';

import express from 'express';
import { WebSocketServer } from 'ws';

import { migrateLegacyStorage, openStorage } from './storage.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const APP_NAME = 'warpish-terminal';

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 8765);
const SHELL = process.env.WARPISH_SHELL || '/bin/zsh';
const PYTHON = process.env.PYTHON || '/usr/bin/python3';
const TMUX = process.env.TMUX_BIN || findExecutable(['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux'], 'tmux');
const PREFIX = (process.env.WARPISH_SESSION_PREFIX || 'warpish-').replace(/[^a-z0-9-]/gi, '').toLowerCase() || 'warpish-';
const DATA_DIR = path.resolve(process.env.WARPISH_DATA_DIR || path.join(__dirname, '.warpish'));
const DATABASE_FILE = path.resolve(process.env.WARPISH_DATABASE_FILE || path.join(DATA_DIR, 'warpish.sqlite3'));
const LEGACY_METADATA_FILE = path.join(DATA_DIR, 'sessions.json');
const LEGACY_EVENTS_DIR = path.join(DATA_DIR, 'events');
const ZDOTDIR = path.join(DATA_DIR, 'zdotdir');
const SHELL_INTEGRATION = path.join(__dirname, 'scripts/warpish-shell-integration.zsh');
const SHELL_EVENT_RECORDER = path.join(__dirname, 'scripts/record-shell-event.py');
const MAX_BLOCKS_PER_SESSION = 300;
const MAX_BLOCK_OUTPUT_CHARS = 24000;
const MAX_CAPTURE_CHARS = 500_000;
const BLOCK_OUTPUT_FLUSH_MS = 750;
const MAX_WS_BUFFERED_BYTES = 4_000_000;
const MAX_WS_PAYLOAD_BYTES = 512 * 1024;
const MAX_TERMINAL_INPUT_BYTES = 64 * 1024;
const MAX_CWD_MARKER_BYTES = 4096;
const MAX_OSC_MARKER_CHARS = 64 * 1024;
const MAX_BLOCK_COMMAND_BYTES = 32 * 1024;
const MAX_BLOCK_ID_CHARS = 180;
const MAX_INPUT_ID_CHARS = 160;
const MAX_WORKER_STDIN_BUFFER_BYTES = 1024 * 1024;
const SESSION_PROFILE_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,39})$/;
const COMMAND_PROBE_INTERVAL_MS = 120;
const COMMAND_PROBE_PENDING_LIMIT = 12;
const COMMAND_RUNNING_PROBE_INTERVAL_MS = 350;
const WS_HEARTBEAT_INTERVAL_MS = clampNumber(process.env.WARPISH_WS_HEARTBEAT_MS, 30_000, 1000, 120_000);
const PTY_RUNTIME_IDLE_GRACE_MS = clampNumber(process.env.WARPISH_PTY_IDLE_GRACE_MS, 30_000, 100, 600_000);
const TMUX_COMMAND_TIMEOUT_MS = clampNumber(process.env.WARPISH_TMUX_TIMEOUT_MS, 5000, 250, 60_000);
const TMUX_MAX_BUFFER_BYTES = 8 * 1024 * 1024;
const TMUX_FORMAT_SEPARATOR = '|';
const TOKEN_FILE = path.resolve(process.env.WARPISH_TOKEN_FILE || path.join(__dirname, '.auth-token'));
const INSTANCE_LOCK_FILE = path.join(DATA_DIR, 'server.lock');
const INSTANCE_LOCK_ID = crypto.randomUUID();

const activeBlockIds = new Map();
const pendingBlockOutputs = new Map();
const sessionRuntimes = new Map();
const workerWriteStates = new WeakMap();
let instanceLockOwned = false;
let storage;

ensureLocalBindAllowed();
const TOKEN = process.env.WARPISH_TOKEN || readOrCreateToken(TOKEN_FILE);
const AUTH_COOKIE_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 30;
fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
try { fs.chmodSync(DATA_DIR, 0o700); } catch {}
try {
  acquireInstanceLock();
  storage = openStorage(DATABASE_FILE);
  const migration = migrateLegacyStorage(storage, {
    metadataFile: LEGACY_METADATA_FILE,
    eventsDir: LEGACY_EVENTS_DIR,
  });
  if (migration) {
    console.log(`Migrated legacy session storage to SQLite. Recovery copy: ${migration.archiveDir}`);
  }
} catch (error) {
  releaseInstanceLock();
  console.error(error.message || error);
  process.exit(1);
}
process.once('exit', () => {
  try { storage?.close(); } catch {}
  releaseInstanceLock();
});

function findExecutable(candidates, fallback) {
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {}
  }
  return fallback;
}

function isLoopbackHost(host) {
  const value = String(host || '').toLowerCase();
  return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(value);
}

function ensureLocalBindAllowed() {
  if (isLoopbackHost(HOST)) return;
  if (process.env.WARPISH_ALLOW_REMOTE === '1') return;
  console.error(`Refusing to bind Warpish Terminal to non-loopback host "${HOST}".`);
  console.error('This app is equivalent to Terminal.app access. Set WARPISH_ALLOW_REMOTE=1 only behind strong auth/TLS/network allowlisting.');
  process.exit(1);
}

function sameOriginForReq(req) {
  const protocol = req.headers['x-forwarded-proto'] || (req.socket?.encrypted ? 'https' : 'http');
  return `${protocol}://${req.headers.host || `${HOST}:${PORT}`}`;
}

function isAllowedOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).origin === new URL(sameOriginForReq(req)).origin;
  } catch {
    return false;
  }
}

function forbidden(res, message = 'Forbidden origin') {
  res.statusCode = 403;
  res.setHeader('content-type', 'text/plain; charset=utf-8');
  res.end(message);
}

function isSecureRequest(req) {
  return Boolean(req.socket?.encrypted || req.headers['x-forwarded-proto'] === 'https');
}

function cookieOptions(req) {
  return {
    httpOnly: true,
    sameSite: 'strict',
    secure: isSecureRequest(req),
    maxAge: AUTH_COOKIE_MAX_AGE_MS,
  };
}

function isTrustedLoopbackRequestHost(req) {
  try {
    const hostname = new URL(`http://${req.headers.host || ''}`).hostname;
    return isLoopbackHost(hostname);
  } catch {
    return false;
  }
}

function isDirectLocalBootstrap(req) {
  return isLoopbackHost(HOST)
    && req.method === 'GET'
    && req.path === '/'
    && !req.headers.origin
    && isTrustedLoopbackRequestHost(req);
}

function limitText(value, maxChars = MAX_CAPTURE_CHARS) {
  const text = String(value || '');
  return text.length > maxChars ? text.slice(-maxChars) : text;
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function parseInstanceLock(text) {
  const value = String(text || '').trim();
  const [id, pid, startedAt, port] = value.split('\t');
  if (id && /^\d+$/.test(pid || '')) {
    return { id, pid: Number(pid), startedAt, port: Number(port) || null };
  }

  // Read the old lock shape during the storage migration without treating the
  // lock as application JSON storage. This keeps a running pre-SQLite server
  // protected from a second instance during a rolling local upgrade.
  const legacyPid = Number(value.match(/"pid"\s*:\s*(\d+)/)?.[1]);
  return {
    id: value.match(/"id"\s*:\s*"([^"]+)"/)?.[1] || '',
    pid: Number.isInteger(legacyPid) ? legacyPid : null,
    port: Number(value.match(/"port"\s*:\s*(\d+)/)?.[1]) || null,
  };
}

function acquireInstanceLock() {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let fd;
    try {
      fd = fs.openSync(INSTANCE_LOCK_FILE, 'wx', 0o600);
      fs.writeFileSync(fd, `${INSTANCE_LOCK_ID}\t${process.pid}\t${new Date().toISOString()}\t${PORT}\n`);
      fs.closeSync(fd);
      fd = null;
      instanceLockOwned = true;
      return;
    } catch (error) {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch {}
      }
      if (error?.code !== 'EEXIST') throw error;

      let owner = null;
      let ageMs = 0;
      try {
        owner = parseInstanceLock(fs.readFileSync(INSTANCE_LOCK_FILE, 'utf8'));
        ageMs = Date.now() - fs.statSync(INSTANCE_LOCK_FILE).mtimeMs;
      } catch {
        try { ageMs = Date.now() - fs.statSync(INSTANCE_LOCK_FILE).mtimeMs; } catch {}
      }
      const ownerPid = Number(owner?.pid);
      if (processIsAlive(ownerPid)) {
        throw new Error(`Warpish data directory is already owned by pid ${ownerPid}${owner?.port ? ` on port ${owner.port}` : ''}. Stop that instance or use a separate WARPISH_DATA_DIR.`);
      }
      if (!ownerPid && ageMs >= 0 && ageMs < 10_000) {
        throw new Error('Warpish data directory lock is being initialized by another process. Retry in a moment or use a separate WARPISH_DATA_DIR.');
      }
      try { fs.unlinkSync(INSTANCE_LOCK_FILE); } catch (unlinkError) {
        if (unlinkError?.code !== 'ENOENT') throw unlinkError;
      }
    }
  }
  throw new Error(`Could not acquire Warpish data directory lock at ${INSTANCE_LOCK_FILE}.`);
}

function releaseInstanceLock() {
  if (!instanceLockOwned) return;
  try {
    const owner = parseInstanceLock(fs.readFileSync(INSTANCE_LOCK_FILE, 'utf8'));
    if (owner?.id === INSTANCE_LOCK_ID) fs.unlinkSync(INSTANCE_LOCK_FILE);
  } catch {}
  instanceLockOwned = false;
}


function readOrCreateToken(file) {
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing.length >= 24) {
      try { fs.chmodSync(file, 0o600); } catch {}
      return existing;
    }
  } catch {}
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const next = crypto.randomBytes(24).toString('base64url');
  fs.writeFileSync(file, `${next}\n`, { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch {}
  return next;
}

function safeToken(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  const got = Buffer.from(value);
  const expected = Buffer.from(TOKEN);
  if (got.length !== expected.length) return false;
  return crypto.timingSafeEqual(got, expected);
}

function tokenFromReq(req) {
  let fromQuery = '';
  try {
    fromQuery = new URL(req.url || '/', 'http://localhost').searchParams.get('token') || '';
  } catch {}
  const fromHeader = req.headers['x-warpish-token'];
  const cookie = req.headers.cookie || '';
  const fromCookie = cookie.split(';').map((v) => v.trim()).find((v) => v.startsWith('warpish_token='))?.split('=')[1];
  let decodedCookie = '';
  try {
    decodedCookie = decodeURIComponent(fromCookie || '');
  } catch {}
  return fromQuery || fromHeader || decodedCookie;
}

function unauthorized(res) {
  res.statusCode = 401;
  res.setHeader('content-type', 'text/plain; charset=utf-8');
  res.end('Unauthorized. Open the printed URL that includes ?token=...');
}

function clampNumber(value, fallback, min, max) {
  const number = Number(value || fallback);
  if (Number.isNaN(number)) return fallback;
  return Math.max(min, Math.min(number, max));
}

function isValidSessionId(id) {
  return typeof id === 'string' && id.startsWith(PREFIX) && /^[a-z0-9-]+$/.test(id);
}

function readMetadata() {
  return storage.readMetadata();
}

function writeMetadata(meta) {
  storage.writeMetadata(meta);
}

function runTmux(args, options = {}) {
  const env = { ...process.env };
  delete env.TMUX;
  const timeout = clampNumber(options.timeout, TMUX_COMMAND_TIMEOUT_MS, 250, 60_000);
  try {
    return execFileSync(TMUX, args, {
      cwd: __dirname,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
      timeout,
      maxBuffer: TMUX_MAX_BUFFER_BYTES,
    });
  } catch (error) {
    const stderr = Buffer.isBuffer(error?.stderr) ? error.stderr.toString('utf8') : String(error?.stderr || '');
    const detail = stderr.trim() || String(error?.message || error).trim();
    const operation = String(args?.[0] || 'command');
    const timedOut = error?.code === 'ETIMEDOUT' || (error?.signal && error?.status === null && /timed?\s*out/iu.test(detail));
    const message = timedOut
      ? `tmux ${operation} timed out after ${timeout}ms`
      : `tmux ${operation} failed${error?.status !== undefined && error?.status !== null ? ` (exit ${error.status})` : ''}`;
    const wrapped = new Error(detail && !timedOut ? `${message}: ${detail}` : message, { cause: error });
    wrapped.code = timedOut ? 'ETIMEDOUT' : error?.code;
    wrapped.status = error?.status;
    wrapped.signal = error?.signal;
    wrapped.stdout = error?.stdout;
    wrapped.stderr = error?.stderr;
    throw wrapped;
  }
}

function enableTmuxSessionPassthrough(sessionId) {
  let previous = 'off';
  try {
    previous = runTmux(['show-options', '-t', sessionId, '-v', 'allow-passthrough']).trim() || 'off';
  } catch {}
  runTmux(['set-option', '-t', sessionId, 'allow-passthrough', 'on']);
  return ['off', 'on', 'all'].includes(previous) ? previous : 'off';
}

function restoreRuntimeTmuxPassthrough(runtime) {
  if (!runtime || runtime.passthroughRestored) return;
  runtime.passthroughRestored = true;
  try {
    runTmux([
      'set-option', '-t', runtime.sessionId,
      'allow-passthrough', runtime.allowPassthroughPrevious || 'off',
    ]);
  } catch {}
}

function tmuxSessionEnvironmentValue(sessionId, name) {
  try {
    const line = runTmux(['show-environment', '-t', sessionId, name]).trim();
    const prefix = `${name}=`;
    return line.startsWith(prefix) ? line.slice(prefix.length) : null;
  } catch {
    return null;
  }
}

function tmuxPaneCurrentPath(sessionId) {
  try {
    const cwd = runTmux(['display-message', '-p', '-t', sessionId, '#{pane_current_path}']).trim();
    if (!path.isAbsolute(cwd) || !fs.statSync(cwd).isDirectory()) return null;
    return path.resolve(cwd);
  } catch {
    return null;
  }
}

function tmuxPaneCurrentCommand(sessionId) {
  try {
    const activeLine = runTmux([
      'list-panes', '-s', '-t', sessionId,
      '-F', '#{window_active}|#{pane_active}|#{pane_current_command}',
    ])
      .split('\n')
      .find((line) => line.startsWith('1|1|'));
    return String(activeLine || '').split('|').slice(2).join('|').trim().slice(0, 160);
  } catch {
    return '';
  }
}

function foregroundCommandIsShell(command) {
  const value = String(command || '').trim();
  return !value || value === path.basename(SHELL);
}

function tmuxPaneHistoryState(sessionId) {
  try {
    const panes = runTmux(['list-panes', '-s', '-t', sessionId, '-F', [
      '#{pane_id}',
      '#{history_limit}',
      '#{history_size}',
    ].join(TMUX_FORMAT_SEPARATOR)])
      .split('\n')
      .map((value) => value.trim())
      .filter(Boolean)
      .map((line) => {
        const [paneId, limit, size] = line.split(TMUX_FORMAT_SEPARATOR);
        return { paneId, limit: Number(limit), size: Number(size) };
      })
      .filter((pane) => /^%\d+$/u.test(pane.paneId) && Number.isFinite(pane.limit) && Number.isFinite(pane.size));
    return { ok: panes.length > 0, panes };
  } catch {
    return { ok: false, panes: [] };
  }
}

function clearPrivateSessionHistory(sessionId) {
  const state = tmuxPaneHistoryState(sessionId);
  for (const pane of state.panes) {
    try { runTmux(['clear-history', '-t', pane.paneId]); } catch {}
  }
  return { ...state, safe: state.ok && state.panes.every((pane) => pane.limit === 0) };
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function ensureShellIntegration() {
  fs.mkdirSync(ZDOTDIR, { recursive: true });
  const sourceUserStartup = process.env.WARPISH_SKIP_USER_ZSHRC !== '1';
  const zprofile = [
    '# Generated by Warpish Terminal. Do not edit by hand.',
    '__warpish_zdotdir="$ZDOTDIR"',
    ...(sourceUserStartup ? [
      'export ZDOTDIR="$HOME"',
      'if [[ -r "$HOME/.zprofile" ]]; then source "$HOME/.zprofile"; fi',
      'export ZDOTDIR="$__warpish_zdotdir"',
    ] : []),
    '',
  ].join('\n');
  const zshrc = [
    '# Generated by Warpish Terminal. Do not edit by hand.',
    '__warpish_zdotdir="$ZDOTDIR"',
    ...(sourceUserStartup ? [
      'export ZDOTDIR="$HOME"',
      'if [[ -r "$HOME/.zshrc" ]]; then source "$HOME/.zshrc"; fi',
      'export ZDOTDIR="$__warpish_zdotdir"',
    ] : []),
    `if [[ -r ${shellQuote(SHELL_INTEGRATION)} ]]; then source ${shellQuote(SHELL_INTEGRATION)}; fi`,
    '',
  ].join('\n');
  fs.writeFileSync(path.join(ZDOTDIR, '.zprofile'), zprofile);
  fs.writeFileSync(path.join(ZDOTDIR, '.zshrc'), zshrc);
}

function warpishShellCommand(sessionId) {
  ensureShellIntegration();
  return [
    '/usr/bin/env',
    '-u',
    'NO_COLOR',
    'COLORTERM=truecolor',
    'WARPISH_TERMINAL=1',
    `WARPISH_SESSION_ID=${shellQuote(sessionId)}`,
    `WARPISH_DATABASE_FILE=${shellQuote(DATABASE_FILE)}`,
    `WARPISH_EVENT_RECORDER=${shellQuote(SHELL_EVENT_RECORDER)}`,
    `WARPISH_PYTHON=${shellQuote(PYTHON)}`,
    'WARPISH_ACTIVITY_INTEGRATION=1',
    'WARPISH_BLOCK_INTEGRATION=0',
    'WARPISH_PRIVATE_SESSION=0',
    'WARPISH_SESSION_PROFILE=default',
    `ZDOTDIR=${shellQuote(ZDOTDIR)}`,
    shellQuote(SHELL),
    '-l',
    '-i',
  ].join(' ');
}

function epochToIso(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return new Date().toISOString();
  const millis = number > 10_000_000_000 ? number : number * 1000;
  const date = new Date(millis);
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

function validMarkerEpoch(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return false;
  const millis = number > 10_000_000_000 ? number : number * 1000;
  return Number.isFinite(new Date(millis).getTime());
}

function parseMarkerPayload(payload) {
  const value = String(payload || '');
  if (!value || value.length > MAX_OSC_MARKER_CHARS) return null;
  const [event, ...parts] = value.split(';');
  const fields = { event };
  for (const part of parts) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    fields[part.slice(0, index)] = part.slice(index + 1);
  }
  return fields;
}

function decodeMarkerCommand(value) {
  const decoded = decodeBase64Strict(value, MAX_BLOCK_COMMAND_BYTES);
  if (!decoded.ok) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(decoded.bytes);
  } catch {
    return null;
  }
}

function validBlockMarkerId(sessionId, value) {
  return typeof value === 'string'
    && value.length <= MAX_BLOCK_ID_CHARS
    && value.startsWith(`${sessionId}-`)
    && /^[a-z0-9-]+$/u.test(value);
}

function validateBlockMarker(sessionId, marker) {
  if (!validBlockMarkerId(sessionId, marker?.id)) return false;
  if (marker.event === 'ActivityStart') {
    return validMarkerEpoch(marker.started);
  }
  if (marker.event === 'ActivityEnd') {
    const status = Number(marker.status);
    return validMarkerEpoch(marker.ended) && Number.isInteger(status) && status >= 0 && status <= 255;
  }
  if (marker.event === 'Start') {
    if (!validMarkerEpoch(marker.started)) return false;
    const command = decodeMarkerCommand(marker.command);
    if (!command) return false;
    marker.decodedCommand = command;
    return true;
  }
  if (marker.event === 'End') {
    const status = Number(marker.status);
    return validMarkerEpoch(marker.ended) && Number.isInteger(status) && status >= 0 && status <= 255;
  }
  return false;
}

function decodeBase64Strict(value, maxBytes) {
  if (typeof value !== 'string') return { ok: false, code: 'invalid-base64' };
  if (value.length > Math.ceil(maxBytes / 3) * 4) return { ok: false, code: 'input-too-large' };
  if (value === '') return { ok: true, bytes: Buffer.alloc(0) };
  if (value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    return { ok: false, code: 'invalid-base64' };
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > maxBytes) return { ok: false, code: 'input-too-large' };
  if (bytes.toString('base64') !== value) return { ok: false, code: 'invalid-base64' };
  return { ok: true, bytes };
}

function ensureSessionRecord(meta, sessionId) {
  if (!meta.sessions) meta.sessions = {};
  if (!meta.sessions[sessionId]) {
    meta.sessions[sessionId] = {
      id: sessionId,
      title: sessionId.replace(PREFIX, 'Terminal '),
      cwd: os.homedir(),
      createdAt: new Date().toISOString(),
      shell: SHELL,
      profile: 'default',
      private: false,
    };
  }
  if (!Array.isArray(meta.sessions[sessionId].blocks)) meta.sessions[sessionId].blocks = [];
  return meta.sessions[sessionId];
}

function sessionIsPrivate(sessionId, meta = null) {
  const metadata = meta || readMetadata();
  return Boolean(metadata.sessions?.[sessionId]?.private);
}

function normalizeBlock(block) {
  return {
    id: block.id,
    command: block.command || '',
    output: block.output || '',
    status: block.status || 'unknown',
    exitCode: block.exitCode ?? null,
    startedAt: block.startedAt || null,
    endedAt: block.endedAt || null,
    durationMs: block.durationMs ?? null,
  };
}

function upsertBlockStart(sessionId, marker) {
  const id = marker.id;
  if (!validBlockMarkerId(sessionId, id)) return null;
  const pending = pendingBlockOutputs.get(sessionId);
  if (pending && pending.blockId !== id) flushPendingBlockOutput(sessionId);
  const meta = readMetadata();
  const record = ensureSessionRecord(meta, sessionId);
  if (record.private) return null;
  let block = record.blocks.find((candidate) => candidate.id === id);
  if (block && block.status !== 'running' && block.endedAt) {
    activeBlockIds.delete(sessionId);
    return normalizeBlock(block);
  }
  const alreadyRunning = block?.status === 'running';
  if (!block) {
    block = { id, output: '' };
    record.blocks.push(block);
  }
  block.command = marker.decodedCommand || block.command || '';
  block.startedAt = block.startedAt || epochToIso(marker.started);
  block.endedAt = null;
  block.durationMs = null;
  block.exitCode = null;
  block.status = 'running';
  if (!alreadyRunning) block.output = '';
  record.activeBlockId = id;
  activeBlockIds.set(sessionId, id);
  record.blocks = record.blocks.slice(-MAX_BLOCKS_PER_SESSION);
  writeMetadata(meta);
  return normalizeBlock(block);
}

function appendBlockOutput(sessionId, text) {
  if (!text) return null;
  if (sessionIsPrivate(sessionId)) return null;
  let blockId = activeBlockIds.get(sessionId);
  if (!blockId) {
    const meta = readMetadata();
    blockId = meta.sessions?.[sessionId]?.activeBlockId;
    if (!blockId) return null;
    activeBlockIds.set(sessionId, blockId);
  }

  let pending = pendingBlockOutputs.get(sessionId);
  if (pending && pending.blockId !== blockId) {
    flushPendingBlockOutput(sessionId);
    pending = null;
  }
  if (!pending) pending = { blockId, timer: null };
  if (!pending.timer) {
    pending.timer = setTimeout(() => flushPendingBlockOutput(sessionId), BLOCK_OUTPUT_FLUSH_MS);
    pending.timer.unref?.();
  }
  pendingBlockOutputs.set(sessionId, pending);
  return null;
}

function flushPendingBlockOutput(sessionId, expectedBlockId = null) {
  const pending = pendingBlockOutputs.get(sessionId);
  if (!pending || (expectedBlockId && pending.blockId !== expectedBlockId)) return null;
  if (pending.timer) clearTimeout(pending.timer);
  pendingBlockOutputs.delete(sessionId);
  return replaceBlockOutputFromPane(sessionId, pending.blockId, { requireActive: true });
}

function finishBlock(sessionId, marker) {
  let meta = readMetadata();
  let record = meta.sessions?.[sessionId];
  if (record?.private) return null;
  if (!record || !Array.isArray(record.blocks)) return null;
  const id = marker.id;
  if (!validBlockMarkerId(sessionId, id)) return null;
  let block = record.blocks.find((candidate) => candidate.id === id);
  if (!block) return null;
  if (block.status !== 'running' && block.endedAt) {
    if (activeBlockIds.get(sessionId) === id) activeBlockIds.delete(sessionId);
    return normalizeBlock(block);
  }

  // End markers are intentionally replayable (OSC plus the database journal). Settle
  // and persist only on the first running -> finished transition; historical or
  // duplicate End events must never overwrite an older block with today's pane.
  flushPendingBlockOutput(sessionId, id);
  replaceBlockOutputFromPane(sessionId, id, { requireActive: true, settle: true });
  meta = readMetadata();
  record = meta.sessions?.[sessionId];
  block = record?.blocks?.find((candidate) => candidate.id === id);
  if (!block || block.status !== 'running') return block ? normalizeBlock(block) : null;

  const exitCode = Number(marker.status ?? 0);
  block.exitCode = Number.isFinite(exitCode) ? exitCode : null;
  block.endedAt = epochToIso(marker.ended);
  const duration = new Date(block.endedAt).getTime() - new Date(block.startedAt || block.endedAt).getTime();
  block.durationMs = Number.isFinite(duration) && duration >= 0 ? duration : null;
  block.status = block.exitCode === 0 ? 'success' : 'failed';
  if (record.activeBlockId === id) delete record.activeBlockId;
  if (activeBlockIds.get(sessionId) === id) activeBlockIds.delete(sessionId);
  writeMetadata(meta);
  return normalizeBlock(block);
}

function updateSessionCwd(sessionId, encodedPath) {
  if (!isValidSessionId(sessionId)) return null;
  const decoded = decodeBase64Strict(encodedPath, MAX_CWD_MARKER_BYTES);
  if (!decoded.ok || decoded.bytes.length === 0 || decoded.bytes.includes(0)) return null;

  let nextCwd;
  try {
    nextCwd = new TextDecoder('utf-8', { fatal: true }).decode(decoded.bytes);
  } catch {
    return null;
  }
  if (!path.isAbsolute(nextCwd)) return null;
  nextCwd = path.resolve(nextCwd);
  try {
    if (!fs.statSync(nextCwd).isDirectory()) return null;
  } catch {
    return null;
  }

  const meta = readMetadata();
  const record = meta.sessions?.[sessionId];
  if (!record) return null;
  if (record.cwd !== nextCwd) {
    record.cwd = nextCwd;
    writeMetadata(meta);
  }
  const runtime = sessionRuntimes.get(sessionId);
  if (runtime && !runtime.closed) runtime.cwd = nextCwd;
  return { type: 'session-meta', sessionId, cwd: nextCwd };
}

function handleBlockMarker(sessionId, payload) {
  const marker = parseMarkerPayload(payload);
  if (!marker) return null;
  if (
    ['ActivityStart', 'ActivityEnd', 'Start', 'End'].includes(marker.event)
    && !validateBlockMarker(sessionId, marker)
  ) return null;
  if (marker.event === 'ActivityStart') {
    return {
      type: 'command-start',
      activity: { id: marker.id, startedAt: epochToIso(marker.started) },
    };
  }
  if (marker.event === 'ActivityEnd') {
    return {
      type: 'command-end',
      activity: {
        id: marker.id,
        endedAt: epochToIso(marker.ended),
        exitCode: Number(marker.status),
      },
    };
  }
  if ((marker.event === 'Start' || marker.event === 'End') && sessionIsPrivate(sessionId)) return null;
  if (marker.event === 'Start') return { type: 'block-start', block: upsertBlockStart(sessionId, marker) };
  if (marker.event === 'End') {
    const block = finishBlock(sessionId, marker);
    return { type: 'block-end', block };
  }
  if (marker.event === 'Cwd') return updateSessionCwd(sessionId, marker.path);
  return null;
}

function reconcileDatabaseEvents(sessionId, onBlockEvent = () => {}) {
  const privateSession = sessionIsPrivate(sessionId);
  const processedIds = [];
  for (const row of storage.pendingEvents(sessionId)) {
    const event = handleBlockMarker(sessionId, row.payload.trim());
    if (event) onBlockEvent(event);
    processedIds.push(row.id);
  }
  if (privateSession) {
    // A private session's shell integration normally suppresses command events.
    // Delete any rows produced during an upgrade/race instead of retaining even
    // processed copies of private command lines in SQLite.
    storage.deleteShellEvents(sessionId);
  } else {
    storage.markEventsProcessed(processedIds);
    if (processedIds.length) storage.pruneProcessedEvents(sessionId, 1000);
  }
}

function createEventReader(sessionId, onBlockEvent) {
  return {
    poll() {
      reconcileDatabaseEvents(sessionId, onBlockEvent);
    },
  };
}

function wrappedCommandEndLine(lines, command) {
  const needle = String(command || '').replace(/[\r\n]/g, '');
  if (!needle) return -1;
  let flattened = '';
  const lineEndOffsets = [];
  for (const line of lines) {
    flattened += line;
    lineEndOffsets.push(flattened.length);
  }
  const commandIndex = flattened.lastIndexOf(needle);
  if (commandIndex < 0) return -1;
  const commandEndOffset = commandIndex + needle.length;
  return lineEndOffsets.findIndex((offset) => offset >= commandEndOffset);
}

function extractBlockOutputFromPane(text, command) {
  const lines = String(text || '').split('\n').map((line) => line.trimEnd());
  let commandLineIndex = -1;
  if (command) {
    let fallbackIndex = -1;
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const commandIndex = lines[i].lastIndexOf(command);
      if (commandIndex < 0) continue;
      if (fallbackIndex < 0) fallbackIndex = i;
      const prefix = lines[i].slice(0, commandIndex);
      if (!/(?:[%$#❯›➜>]\s*)$/u.test(prefix)) continue;
      commandLineIndex = i;
      break;
    }
    if (commandLineIndex < 0) {
      commandLineIndex = wrappedCommandEndLine(lines, command);
      if (commandLineIndex < 0) commandLineIndex = fallbackIndex;
    }
  }
  const slice = commandLineIndex >= 0 ? lines.slice(commandLineIndex + 1) : lines.slice(-160);
  const outputLines = [];
  for (const line of slice) {
    if (/^[^\s]+@[^\s]+\s+.*\s[%#]\s*$/.test(line) && outputLines.length > 0) break;
    outputLines.push(line);
  }
  while (outputLines.length && /^\s*$/.test(outputLines[0])) outputLines.shift();
  while (outputLines.length && /^\s*$/.test(outputLines.at(-1))) outputLines.pop();
  return outputLines
    .filter((line) => !line.includes('\x1b]697;'))
    .join('\n')
    .slice(-MAX_BLOCK_OUTPUT_CHARS);
}

function captureBlockOutputSnapshot(sessionId, command) {
  const alternateActive = paneAlternateScreenActive(sessionId);
  const current = capturePaneResult(sessionId, {
    lines: 1600,
    history: !alternateActive,
  });
  const alternateStillActive = paneAlternateScreenActive(sessionId);
  if (alternateStillActive !== alternateActive) {
    const retry = capturePaneResult(sessionId, {
      lines: 1600,
      history: !alternateStillActive,
    });
    if (!retry.ok) return { ok: false, output: '' };
    return {
      ok: true,
      output: extractBlockOutputFromPane(retry.text, command),
      preserveExisting: alternateStillActive && !retry.text.trim(),
    };
  }
  if (!current.ok) return { ok: false, output: '' };
  return {
    ok: true,
    output: extractBlockOutputFromPane(current.text, command),
    preserveExisting: alternateActive && !current.text.trim(),
  };
}

function replaceBlockOutputFromPane(sessionId, blockId, {
  requireActive = false,
  settle = false,
} = {}) {
  const before = readMetadata();
  const beforeRecord = before.sessions?.[sessionId];
  if (beforeRecord?.private) return null;
  const beforeBlock = beforeRecord?.blocks?.find((candidate) => candidate.id === blockId);
  if (!beforeBlock) return null;
  if (requireActive && beforeRecord.activeBlockId !== blockId) return null;

  let snapshot = captureBlockOutputSnapshot(sessionId, beforeBlock.command || '');
  if (settle) {
    // The precmd End marker can reach the attached client a few milliseconds
    // before tmux has committed the final primary-screen redraw. Sample through
    // that bounded window and use the newest canonical pane state. This also
    // behaves correctly for commands whose legitimate output is empty.
    const sleeper = new Int32Array(new SharedArrayBuffer(4));
    for (let attempt = 0; attempt < 3; attempt += 1) {
      Atomics.wait(sleeper, 0, 0, 20);
      const next = captureBlockOutputSnapshot(sessionId, beforeBlock.command || '');
      if (next.ok) snapshot = next;
    }
  }
  if (!snapshot.ok) return null;

  const meta = readMetadata();
  const record = meta.sessions?.[sessionId];
  const block = record?.blocks?.find((candidate) => candidate.id === blockId);
  if (!block) return null;
  if (requireActive && record.activeBlockId !== blockId) return null;
  if (snapshot.preserveExisting && (block.output || '').trim()) return normalizeBlock(block);
  if ((block.output || '') === snapshot.output) return normalizeBlock(block);
  block.output = snapshot.output;
  writeMetadata(meta);
  return normalizeBlock(block);
}

function refreshActiveBlockOutput(sessionId) {
  const meta = readMetadata();
  if (meta.sessions?.[sessionId]?.private) return null;
  const blockId = meta.sessions?.[sessionId]?.activeBlockId;
  if (!blockId) return null;
  return replaceBlockOutputFromPane(sessionId, blockId, { requireActive: true });
}

function createOutputProcessor(sessionId, { onTerminalData, onBlockEvent, shouldRecordOutput = () => true }) {
  const markerPrefix = '\x1b]697;';
  const tmuxPrefix = '\x1bPtmux;\x1b';
  const focusModeControls = [
    '\x1b[?1004h',
    '\x1b[?1004l',
    '\x1bPtmux;\x1b\x1b[?1004h\x1b\\',
    '\x1bPtmux;\x1b\x1b[?1004l\x1b\\',
  ];
  const partialSequences = [markerPrefix, ...focusModeControls];
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  let lastUpdateAt = 0;
  const partialSuffixLength = Math.max(...partialSequences.map((sequence) => sequence.length - 1));

  function forward(text) {
    if (!text) return;
    const stripped = text.endsWith(tmuxPrefix) ? text.slice(0, -tmuxPrefix.length) : text;
    if (!stripped) return;
    const recordableText = stripTerminalFocusModeControls(stripped);
    if (shouldRecordOutput() && recordableText) appendBlockOutput(sessionId, recordableText);
    // Focus tracking is a real terminal capability used by full-screen TUIs.
    // Keep its mode controls in the PTY byte stream while excluding them from
    // persisted command output. Incoming focus reports are filtered separately.
    onTerminalData(Buffer.from(stripped, 'utf8'));
  }

  function processText(text) {
    buffer += text;
    while (buffer.length) {
      const start = buffer.indexOf(markerPrefix);
      if (start === -1) {
        let keep = 0;
        for (let i = 1; i <= partialSuffixLength; i += 1) {
          const suffix = buffer.slice(-i);
          if (partialSequences.some((sequence) => sequence.startsWith(suffix))) keep = i;
        }
        forward(buffer.slice(0, buffer.length - keep));
        buffer = buffer.slice(buffer.length - keep);
        return;
      }

      forward(buffer.slice(0, start));
      const end = buffer.indexOf('\x07', start + markerPrefix.length);
      if (end === -1) {
        buffer = buffer.slice(start);
        if (buffer.length > MAX_OSC_MARKER_CHARS) {
          // A terminal program can print the marker prefix without a terminator.
          // Drop only the private prefix and resume normal output instead of
          // retaining an unbounded buffer and blanking the client forever.
          const malformedPayload = buffer.slice(markerPrefix.length);
          buffer = '';
          forward(malformedPayload);
        }
        return;
      }

      const payload = buffer.slice(start + markerPrefix.length, end);
      buffer = buffer.slice(end + 1);
      if (buffer.startsWith('\x1b\\')) buffer = buffer.slice(2);
      const event = handleBlockMarker(sessionId, payload);
      if (event) onBlockEvent(event);
    }
  }

  return {
    processBytes(bytes) {
      processText(decoder.write(Buffer.from(bytes)));
    },
    flush() {
      processText(decoder.end());
      forward(buffer);
      buffer = '';
      flushPendingBlockOutput(sessionId);
    },
  };
}

let lastKnownActiveTmuxSessions = new Map();

function listActiveTmuxSessions() {
  let output = '';
  try {
    // tmux sanitizes literal control characters in format strings when launchd
    // starts the process without a locale. A tab delimiter then becomes `_`,
    // merging every field into a fake session id. Session ids cannot contain
    // `|`, so use a printable separator that is stable with or without LANG.
    output = runTmux(['list-sessions', '-F', [
      '#{session_name}',
      '#{session_created}',
      '#{session_attached}',
      '#{session_windows}',
    ].join(TMUX_FORMAT_SEPARATOR)]);
  } catch (error) {
    const detail = `${error?.stderr || ''}\n${error?.message || ''}`;
    if (/no server running/iu.test(detail)) {
      lastKnownActiveTmuxSessions = new Map();
      return { ok: true, sessions: new Map(), error: null };
    }
    console.error(`Could not enumerate tmux sessions: ${detail.trim() || error}`);
    return { ok: false, sessions: new Map(lastKnownActiveTmuxSessions), error };
  }

  const active = new Map();
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const [name, created, attached, windows] = line.split(TMUX_FORMAT_SEPARATOR);
    if (!name?.startsWith(PREFIX)) continue;
    active.set(name, {
      id: name,
      createdAt: Number(created || 0) * 1000,
      attached: Number(attached || 0),
      windows: Number(windows || 0),
    });
  }
  lastKnownActiveTmuxSessions = new Map(active);
  return { ok: true, sessions: active, error: null };
}

function capturePreview(id, lines = 28) {
  if (sessionIsPrivate(id)) return '';
  try {
    const text = runTmux(['capture-pane', '-p', '-t', id, '-S', `-${lines}`]);
    return text
      .split('\n')
      .map((line) => line.trimEnd())
      .filter((line) => line.trim().length > 0)
      .slice(-8)
      .join('\n')
      .slice(-1600);
  } catch {
    return '';
  }
}

function capturePaneResult(id, {
  lines = 600,
  alternate = false,
  escape = false,
  history = true,
  historyOnly = false,
} = {}) {
  const args = ['capture-pane', '-p', '-J'];
  if (escape) args.push('-e');
  if (alternate) args.push('-a');
  else if (history) {
    args.push('-S', `-${Math.max(20, Math.min(Number(lines) || 600, 5000))}`);
    if (historyOnly) args.push('-E', '-1');
  }
  args.push('-t', id);
  try {
    const text = runTmux(args)
      .split('\n')
      .map((line) => line.trimEnd())
      .join('\n')
      .trimEnd();
    return { ok: true, text };
  } catch {
    return { ok: false, text: '' };
  }
}

function capturePaneText(id, options = {}) {
  return capturePaneResult(id, options).text;
}

function paneAlternateScreenActive(id) {
  try {
    return runTmux(['display-message', '-p', '-t', id, '#{alternate_on}']).trim() === '1';
  } catch {
    return false;
  }
}

function paneCursorState(id) {
  try {
    const [alternate, x, y, visible] = runTmux([
      'display-message',
      '-p',
      '-t',
      id,
      '#{alternate_on}|#{cursor_x}|#{cursor_y}|#{cursor_flag}',
    ]).trim().split('|');
    return {
      ok: true,
      alternateActive: alternate === '1',
      x: Math.max(0, Number.parseInt(x, 10) || 0),
      y: Math.max(0, Number.parseInt(y, 10) || 0),
      visible: visible !== '0',
    };
  } catch {
    return { ok: false, alternateActive: false, x: 0, y: 0, visible: true };
  }
}

function inspectKnownInteractivePane(sessionId, { privateSession = false, processName = '' } = {}) {
  if (privateSession || !/^(?:hermes|python(?:\d+(?:\.\d+)*)?)$/iu.test(String(processName).trim())) return null;
  const cursor = paneCursorState(sessionId);
  if (!cursor.ok) return null;
  const current = capturePaneResult(sessionId, {
    alternate: cursor.alternateActive,
    history: false,
  });
  if (!current.ok) return null;

  const lines = current.text.split('\n');
  const cursorLine = lines[cursor.y] || '';
  const nearby = lines
    .slice(Math.max(0, cursor.y - 7), Math.min(lines.length, cursor.y + 3))
    .join('\n');

  // Hermes keeps a compact status row immediately above its prompt. The
  // foreground process remains Python both while Hermes is idle and while it
  // is working, so process-name polling alone cannot distinguish those states.
  // Read only the current tmux screen and use Hermes' own live prompt contract:
  // a working composer starts with the staff symbol, while an input-ready
  // composer exposes one of the user-facing prompt symbols below.
  if (!nearby.includes('⏲')) return null;
  if (/^\s*(?:⚕|◉)(?:\s|$)/u.test(cursorLine)
    || nearby.includes('msg=interrupt · /queue · /bg · /steer · Ctrl+C cancel')
    || nearby.includes('command in progress · input temporarily disabled')) {
    return { state: 'busy', processName: 'Hermes' };
  }
  if (cursor.visible && /^\s*(?:❯|\?|⚠|✎|🔐|🔑|🎤|●)(?:\s|$)/u.test(cursorLine)) {
    return { state: 'ready', processName: 'Hermes' };
  }
  return { state: 'unknown', processName: 'Hermes' };
}

function summarizeSessions() {
  const meta = readMetadata();
  const activeResult = listActiveTmuxSessions();
  const active = activeResult.sessions;
  const privateHistorySafety = new Map();
  let changed = false;

  for (const [id, tmuxInfo] of activeResult.ok ? active.entries() : []) {
    const privateEnvironment = tmuxSessionEnvironmentValue(id, 'WARPISH_PRIVATE_SESSION');
    const profileEnvironment = tmuxSessionEnvironmentValue(id, 'WARPISH_SESSION_PROFILE');
    if (!meta.sessions[id]) {
      // Unknown sessions may be remnants of a private create interrupted before
      // SQLite commit. Default to private unless tmux explicitly says otherwise,
      // so recovery never captures content merely because metadata is missing.
      const adoptedPrivate = privateEnvironment !== '0';
      meta.sessions[id] = {
        id,
        title: id.replace(PREFIX, 'Terminal '),
        cwd: tmuxPaneCurrentPath(id) || os.homedir(),
        createdAt: new Date(tmuxInfo.createdAt || Date.now()).toISOString(),
        shell: SHELL,
        profile: SESSION_PROFILE_PATTERN.test(profileEnvironment || '') ? profileEnvironment : 'default',
        private: adoptedPrivate,
      };
      changed = true;
    }
    const record = meta.sessions[id];
    if (privateEnvironment === '1' && !record.private) {
      record.private = true;
      changed = true;
    }
    if (SESSION_PROFILE_PATTERN.test(profileEnvironment || '') && record.profile !== profileEnvironment) {
      record.profile = profileEnvironment;
      changed = true;
    }
    if (record.private && (record.lastPreview || record.activeBlockId || record.blocks?.length)) {
      delete record.lastPreview;
      delete record.lastPreviewAt;
      delete record.activeBlockId;
      record.blocks = [];
      storage.deleteShellEvents(id);
      changed = true;
    }
    if (record.private) privateHistorySafety.set(id, clearPrivateSessionHistory(id).safe);
    const preview = record.private ? '' : capturePreview(id);
    if (preview && meta.sessions[id].lastPreview !== preview) {
      meta.sessions[id].lastPreview = preview;
      meta.sessions[id].lastPreviewAt = new Date().toISOString();
      changed = true;
    }
  }

  if (activeResult.ok) {
    for (const [id, record] of Object.entries(meta.sessions)) {
      if (!active.has(id) && !record.stoppedAt) {
        record.stoppedAt = new Date().toISOString();
        changed = true;
      }
    }
  }

  if (changed) writeMetadata(meta);

  return Object.values(meta.sessions)
    .map((record) => {
      const tmuxInfo = active.get(record.id);
      return {
        id: record.id,
        title: record.title || record.id,
        cwd: record.cwd || os.homedir(),
        createdAt: record.createdAt,
        lastOpenedAt: record.lastOpenedAt,
        stoppedAt: tmuxInfo ? null : record.stoppedAt || null,
        alive: Boolean(tmuxInfo),
        attached: tmuxInfo?.attached || 0,
        windows: tmuxInfo?.windows || 0,
        shell: record.shell || SHELL,
        profile: record.profile || 'default',
        private: Boolean(record.private),
        privacyQuarantined: Boolean(tmuxInfo && record.private && privateHistorySafety.get(record.id) !== true),
        preview: record.private
          ? ''
          : (tmuxInfo ? (capturePreview(record.id) || record.lastPreview || '') : (record.lastPreview || '')),
      };
    })
    .sort((a, b) => {
      if (a.alive !== b.alive) return a.alive ? -1 : 1;
      return new Date(b.lastOpenedAt || b.createdAt || 0) - new Date(a.lastOpenedAt || a.createdAt || 0);
    });
}

function requestError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function createSession() {
  const meta = readMetadata();
  const now = new Date();
  const index = meta.nextIndex || Object.keys(meta.sessions).length + 1;
  const id = `${PREFIX}${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
  const safeCwd = os.homedir();
  const sessionTitle = `Terminal ${index}`;
  const profile = 'default';
  const privateSession = false;
  let tmuxCreated = false;
  let metadataWritten = false;

  try {
    const bootstrapWindow = 'warpish-bootstrap';
    // tmux copies history-limit into each pane only when that pane is created.
    // Create a content-free bootstrap first, configure the session, then launch
    // the real shell in a new pane so the normal 50000-line limit is effective.
    runTmux(['new-session', '-d', '-s', id, '-n', bootstrapWindow, '-c', safeCwd, '/bin/sleep 60']);
    tmuxCreated = true;
    runTmux(['set-option', '-t', id, 'status', 'off']);
    runTmux(['set-option', '-t', id, 'history-limit', '50000']);
    runTmux(['set-option', '-t', id, 'allow-rename', 'off']);
    runTmux(['set-option', '-t', id, 'focus-events', 'on']);
    runTmux(['set-option', '-t', id, 'mouse', 'on']);
    runTmux(['set-environment', '-u', '-t', id, 'NO_COLOR']);
    runTmux(['set-environment', '-t', id, 'COLORTERM', 'truecolor']);
    runTmux(['set-environment', '-t', id, 'WARPISH_TERMINAL', '1']);
    runTmux(['set-environment', '-t', id, 'WARPISH_SESSION_ID', id]);
    runTmux(['set-environment', '-t', id, 'WARPISH_DATABASE_FILE', DATABASE_FILE]);
    runTmux(['set-environment', '-t', id, 'WARPISH_EVENT_RECORDER', SHELL_EVENT_RECORDER]);
    runTmux(['set-environment', '-t', id, 'WARPISH_PYTHON', PYTHON]);
    runTmux(['set-environment', '-t', id, 'WARPISH_ACTIVITY_INTEGRATION', '1']);
    runTmux(['set-environment', '-t', id, 'WARPISH_BLOCK_INTEGRATION', '0']);
    runTmux(['set-environment', '-t', id, 'WARPISH_PRIVATE_SESSION', '0']);
    runTmux(['set-environment', '-t', id, 'WARPISH_SESSION_PROFILE', profile]);
    runTmux(['set-environment', '-t', id, 'ZDOTDIR', ZDOTDIR]);
    runTmux([
      'new-window',
      '-d',
      '-t', `${id}:`,
      '-n', 'terminal',
      '-c', safeCwd,
      warpishShellCommand(id),
    ]);
    runTmux(['kill-window', '-t', `${id}:${bootstrapWindow}`]);

    meta.nextIndex = index + 1;
    meta.sessions[id] = {
      id,
      title: sessionTitle,
      cwd: safeCwd,
      createdAt: now.toISOString(),
      lastOpenedAt: now.toISOString(),
      shell: SHELL,
      profile,
      private: privateSession,
      blocks: [],
    };
    writeMetadata(meta);
    metadataWritten = true;
    ensureSessionRuntime({ id, cwd: safeCwd, private: privateSession }, { cols: 120, rows: 36 });
    return summarizeSessions().find((session) => session.id === id);
  } catch (error) {
    const runtime = sessionRuntimes.get(id);
    if (runtime) terminateSessionRuntime(runtime);
    if (tmuxCreated) {
      try { runTmux(['kill-session', '-t', id]); } catch {}
    }
    if (metadataWritten) {
      const rollbackMeta = readMetadata();
      delete rollbackMeta.sessions?.[id];
      try { writeMetadata(rollbackMeta); } catch {}
    }
    clearSessionTransientState(id);
    throw error;
  }
}

function touchSession(id) {
  const meta = readMetadata();
  if (meta.sessions[id]) {
    meta.sessions[id].lastOpenedAt = new Date().toISOString();
    writeMetadata(meta);
  }
}

function clearSessionTransientState(id) {
  const pending = pendingBlockOutputs.get(id);
  if (pending?.timer) clearTimeout(pending.timer);
  pendingBlockOutputs.delete(id);
  activeBlockIds.delete(id);
}

function killSession(id) {
  const meta = readMetadata();
  const privateSession = Boolean(meta.sessions?.[id]?.private);
  if (!privateSession) flushPendingBlockOutput(id);
  let preview = '';
  if (meta.sessions[id] && !privateSession) {
    preview = capturePreview(id);
  }
  try {
    runTmux(['kill-session', '-t', id]);
  } catch (error) {
    const detail = `${error?.stderr || ''}\n${error?.message || ''}`;
    if (!/can't find session|no server running/iu.test(detail)) {
      error.statusCode = 503;
      throw error;
    }
  }
  if (meta.sessions[id]) {
    if (privateSession) {
      delete meta.sessions[id].lastPreview;
      delete meta.sessions[id].lastPreviewAt;
      delete meta.sessions[id].activeBlockId;
      meta.sessions[id].blocks = [];
      storage.deleteShellEvents(id);
    } else if (preview) {
      meta.sessions[id].lastPreview = preview;
    }
    meta.sessions[id].stoppedAt = new Date().toISOString();
    writeMetadata(meta);
  }
  const runtime = sessionRuntimes.get(id);
  if (runtime) terminateSessionRuntime(runtime);
}

function purgeSession(id) {
  const meta = readMetadata();
  const record = meta.sessions?.[id];
  if (!record) return false;
  delete meta.sessions[id];
  writeMetadata(meta);
  storage.deleteShellEvents(id);
  clearSessionTransientState(id);
  return true;
}

function purgeStoppedSessions() {
  const meta = readMetadata();
  const activeResult = listActiveTmuxSessions();
  if (!activeResult.ok) {
    const error = new Error('tmux session state is temporarily unavailable; no session history was removed');
    error.statusCode = 503;
    throw error;
  }
  const active = activeResult.sessions;
  const purged = [];

  for (const id of Object.keys(meta.sessions || {})) {
    if (active.has(id)) continue;
    purged.push(id);
    delete meta.sessions[id];
    storage.deleteShellEvents(id);
    clearSessionTransientState(id);
  }

  if (purged.length) writeMetadata(meta);
  return purged;
}

function workerWriteState(worker) {
  let state = workerWriteStates.get(worker);
  if (state) return state;
  state = {
    queue: [],
    queuedBytes: 0,
    waitingForDrain: false,
    closed: false,
  };
  workerWriteStates.set(worker, state);
  worker.stdin.once('close', () => {
    state.closed = true;
    state.queue = [];
    state.queuedBytes = 0;
  });
  return state;
}

function flushWorkerWriteQueue(worker, state) {
  if (state.closed || state.waitingForDrain || !worker?.stdin?.writable || worker.stdin.destroyed) return;
  while (state.queue.length) {
    const payload = state.queue.shift();
    state.queuedBytes -= payload.length;
    let accepted;
    try {
      accepted = worker.stdin.write(payload);
    } catch (error) {
      state.closed = true;
      state.queue = [];
      state.queuedBytes = 0;
      try { worker.stdin.destroy(error); } catch {}
      return;
    }
    if (!accepted) {
      state.waitingForDrain = true;
      worker.stdin.once('drain', () => {
        state.waitingForDrain = false;
        flushWorkerWriteQueue(worker, state);
      });
      return;
    }
  }
}

function queueWorkerMessage(worker, message) {
  if (!worker?.stdin || worker.stdin.destroyed || !worker.stdin.writable) {
    return { ok: false, code: 'pty-input-unavailable', message: 'PTY input is unavailable; reconnect to resume.' };
  }
  let payload;
  try {
    payload = Buffer.from(`${JSON.stringify(message)}\n`, 'utf8');
  } catch {
    return { ok: false, code: 'pty-input-invalid', message: 'PTY input could not be encoded.' };
  }

  const state = workerWriteState(worker);
  const bufferedBytes = state.queuedBytes + (worker.stdin.writableLength || 0);
  if (state.closed) {
    return { ok: false, code: 'pty-input-unavailable', message: 'PTY input is unavailable; reconnect to resume.' };
  }
  if (bufferedBytes + payload.length > MAX_WORKER_STDIN_BUFFER_BYTES) {
    return {
      ok: false,
      code: 'pty-input-backpressure',
      message: 'PTY input queue is full; wait for the terminal to catch up and try again.',
    };
  }

  if (state.waitingForDrain || state.queue.length) {
    state.queue.push(payload);
    state.queuedBytes += payload.length;
    return { ok: true };
  }

  try {
    if (!worker.stdin.write(payload)) {
      state.waitingForDrain = true;
      worker.stdin.once('drain', () => {
        state.waitingForDrain = false;
        flushWorkerWriteQueue(worker, state);
      });
    }
    return { ok: true };
  } catch (error) {
    state.closed = true;
    try { worker.stdin.destroy(error); } catch {}
    return { ok: false, code: 'pty-input-unavailable', message: 'PTY input is unavailable; reconnect to resume.' };
  }
}

function writeWorker(worker, message) {
  return queueWorkerMessage(worker, message).ok;
}

function stripTerminalFocusReports(data) {
  return String(data || '').replace(/\x1b\[(?:I|O)/g, '');
}

function stripTerminalFocusModeControls(data) {
  return String(data || '')
    .replace(/\x1bPtmux;\x1b\x1b\[\?1004[hl]\x1b\\/g, '')
    .replace(/\x1b\[\?1004[hl]/g, '');
}

const TMUX_ESCAPE_KEYS = [
  ['\x1b[A', 'Up'],
  ['\x1b[B', 'Down'],
  ['\x1b[C', 'Right'],
  ['\x1b[D', 'Left'],
  ['\x1b[H', 'Home'],
  ['\x1b[F', 'End'],
  ['\x1b[3~', 'Delete'],
  ['\x1b[5~', 'PageUp'],
  ['\x1b[6~', 'PageDown'],
];

function tmuxControlKey(code) {
  if (code === 0) return 'C-Space';
  if (code === 3) return 'C-c';
  if (code === 4) return 'C-d';
  if (code === 7) return 'C-g';
  if (code === 9) return 'Tab';
  if (code === 10 || code === 13) return 'Enter';
  if (code === 12) return 'C-l';
  if (code === 18) return 'C-r';
  if (code === 21) return 'C-u';
  if (code === 23) return 'C-w';
  if (code === 27) return 'Escape';
  if (code === 28) return 'C-\\';
  if (code === 29) return 'C-]';
  if (code === 30) return 'C-^';
  if (code === 31) return 'C-_';
  if (code === 127) return 'BSpace';
  if (code >= 1 && code <= 26) return `C-${String.fromCharCode(96 + code)}`;
  return null;
}

function sendTmuxLiteral(sessionId, literal) {
  if (!literal) return;
  runTmux(['send-keys', '-t', sessionId, '-l', literal]);
}

function sendTmuxKey(sessionId, key) {
  runTmux(['send-keys', '-t', sessionId, key]);
}

function writeTmuxInput(sessionId, data) {
  const value = String(data || '');
  let literal = '';
  const flushLiteral = () => {
    if (!literal) return;
    sendTmuxLiteral(sessionId, literal);
    literal = '';
  };

  for (let index = 0; index < value.length;) {
    const escape = TMUX_ESCAPE_KEYS.find(([sequence]) => value.startsWith(sequence, index));
    if (escape) {
      flushLiteral();
      sendTmuxKey(sessionId, escape[1]);
      index += escape[0].length;
      continue;
    }

    const code = value.charCodeAt(index);
    const controlKey = code < 32 || code === 127 ? tmuxControlKey(code) : null;
    if (controlKey) {
      flushLiteral();
      sendTmuxKey(sessionId, controlKey);
      index += 1;
      continue;
    }

    const codePoint = value.codePointAt(index);
    const char = String.fromCodePoint(codePoint);
    literal += char;
    index += char.length;
  }
  flushLiteral();
  return true;
}

function createPtyWorker({ sessionId, cwd, cols, rows, privateSession = false, profile = 'default' }) {
  const workerPath = path.join(__dirname, 'scripts/pty-worker.py');
  const env = {
    ...process.env,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    WARPISH_TERMINAL: '1',
    WARPISH_PRIVATE_SESSION: privateSession ? '1' : '0',
    WARPISH_SESSION_PROFILE: profile,
  };
  delete env.TMUX;
  delete env.TMUX_PANE;
  delete env.NO_COLOR;
  return spawn(PYTHON, [
    workerPath,
    '--shell', SHELL,
    '--cwd', cwd,
    '--cols', String(cols),
    '--rows', String(rows),
    '--tmux-bin', TMUX,
    '--tmux-session', sessionId,
    '--max-pending-input-bytes', String(MAX_WORKER_STDIN_BUFFER_BYTES),
  ], {
    cwd: __dirname,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

const app = express();

app.use((req, res, next) => {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:; base-uri 'none'; frame-ancestors 'none'");
  next();
});

app.use((req, res, next) => {
  if (!isAllowedOrigin(req)) return forbidden(res);
  if (req.path === '/healthz') return next();
  const token = tokenFromReq(req);
  if (!safeToken(token)) {
    if (!isDirectLocalBootstrap(req)) return unauthorized(res);
    res.cookie('warpish_token', TOKEN, cookieOptions(req));
    return next();
  }
  if (req.query.token) {
    res.cookie('warpish_token', token, cookieOptions(req));
  }
  next();
});

app.use(express.json({ limit: '64kb' }));

function readinessReport() {
  const checks = [];
  const add = (name, ok, detail = '') => checks.push({ name, ok: Boolean(ok), detail });
  add('shell-executable', (() => {
    try {
      fs.accessSync(SHELL, fs.constants.X_OK);
      return fs.statSync(SHELL).isFile();
    } catch { return false; }
  })(), SHELL);
  try {
    const version = execFileSync(PYTHON, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    add('python-executable', true, `${PYTHON} ${version}`.trim());
  } catch (error) {
    add('python-executable', false, error.message || String(error));
  }
  try {
    const version = runTmux(['-V']).trim();
    add('tmux-version', true, `${TMUX} ${version}`);
  } catch (error) {
    add('tmux-version', false, error.message || String(error));
  }
  add('data-dir-writable', (() => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.accessSync(DATA_DIR, fs.constants.W_OK);
      return true;
    } catch { return false; }
  })(), DATA_DIR);
  add('sqlite-database', (() => {
    try { return storage.check(); } catch { return false; }
  })(), DATABASE_FILE);
  add('pty-worker-present', fs.existsSync(path.join(__dirname, 'scripts/pty-worker.py')), 'scripts/pty-worker.py');
  add('shell-event-recorder-present', fs.existsSync(SHELL_EVENT_RECORDER), 'scripts/record-shell-event.py');
  return { ok: checks.every((check) => check.ok), checks };
}

app.get('/healthz', (_req, res) => {
  res.json({ app: APP_NAME, ok: true, host: HOST, port: PORT, shell: SHELL, python: PYTHON, tmux: TMUX, platform: process.platform });
});

app.get('/readyz', (_req, res) => {
  const readiness = readinessReport();
  res.status(readiness.ok ? 200 : 503).json({ app: APP_NAME, ...readiness });
});

app.post('/api/auth/refresh', (req, res) => {
  res.cookie('warpish_token', TOKEN, cookieOptions(req));
  res.json({ ok: true });
});

app.get('/api/sessions', (_req, res) => {
  res.json({ sessions: summarizeSessions() });
});

app.delete('/api/sessions', (req, res) => {
  if (req.query.stopped !== '1') return res.status(400).json({ error: 'set stopped=1 to clear stopped session history' });
  try {
    const purged = purgeStoppedSessions();
    res.json({ ok: true, purged, sessions: summarizeSessions() });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message || String(error) });
  }
});

app.post('/api/sessions', (_req, res) => {
  try {
    const session = createSession();
    res.status(201).json({ session, sessions: summarizeSessions() });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message || String(error) });
  }
});

app.delete('/api/sessions/:id', (req, res) => {
  const { id } = req.params;
  if (!isValidSessionId(id)) return res.status(400).json({ error: 'invalid session id' });
  try {
    killSession(id);
    if (req.query.purge === '1') purgeSession(id);
    res.json({ ok: true, sessions: summarizeSessions() });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message || String(error) });
  }
});

const vendor = {
  '/vendor/xterm.css': 'node_modules/@xterm/xterm/css/xterm.css',
  '/vendor/xterm.js': 'node_modules/@xterm/xterm/lib/xterm.js',
  '/vendor/fit.js': 'node_modules/@xterm/addon-fit/lib/addon-fit.js',
  '/vendor/web-links.js': 'node_modules/@xterm/addon-web-links/lib/addon-web-links.js',
};

for (const [route, relPath] of Object.entries(vendor)) {
  app.get(route, (_req, res) => res.sendFile(path.join(__dirname, relPath)));
}
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD_BYTES });

function sendWsControl(ws, message) {
  if (ws.readyState !== ws.OPEN) return false;
  try {
    ws.send(JSON.stringify(message));
    return true;
  } catch {
    return false;
  }
}

function sendWsInputError(ws, code, message) {
  return sendWsControl(ws, { type: 'server-error', code, message });
}

function initialRuntimeCommandState(sessionId, privateSession = false) {
  const processName = tmuxPaneCurrentCommand(sessionId);
  const interactive = inspectKnownInteractivePane(sessionId, { privateSession, processName });
  if (interactive?.state === 'ready') return null;
  if (interactive?.state === 'busy') {
    return {
      running: true,
      phase: 'running',
      source: 'interactive',
      activityId: null,
      startedAt: null,
      processName: privateSession ? '' : interactive.processName,
    };
  }

  const record = readMetadata().sessions?.[sessionId];
  const activeBlock = record?.blocks?.find((block) => (
    block.id === record.activeBlockId && block.status === 'running'
  ));
  if (activeBlock) {
    return {
      running: true,
      phase: 'running',
      source: 'shell',
      activityId: activeBlock.id,
      startedAt: activeBlock.startedAt || null,
      processName: privateSession ? '' : path.basename(SHELL),
    };
  }

  // A non-shell foreground process is not positive proof of work at attach
  // time: editors, REPLs, and agents remain foreground while waiting for input.
  // Process fallback begins only after this browser actually submits Enter.
  return null;
}

function runtimeCommandStateMessage(runtime, extra = {}) {
  return {
    type: 'command-state',
    sessionId: runtime.sessionId,
    running: Boolean(runtime.commandState?.running),
    state: runtime.commandState || null,
    ...extra,
  };
}

function publishRuntimeCommandState(runtime, state, extra = {}) {
  const previous = runtime.commandState;
  runtime.commandState = state?.running ? state : null;
  const changed = JSON.stringify(previous || null) !== JSON.stringify(runtime.commandState || null);
  if (changed || extra.completed) {
    broadcastRuntimeControl(runtime, runtimeCommandStateMessage(runtime, extra));
  }
}

function stopRuntimeCommandProbe(runtime) {
  runtime.commandProbeToken += 1;
  clearRuntimeTimer(runtime, 'commandProbeTimer');
  runtime.commandProbeAttempts = 0;
  runtime.commandProbeSawBusy = false;
  runtime.commandProbeInitialProcess = '';
}

function scheduleRuntimeCommandProbe(runtime, token, delay = COMMAND_PROBE_INTERVAL_MS) {
  if (runtime.closed || runtime.stopping || token !== runtime.commandProbeToken) return;
  clearRuntimeTimer(runtime, 'commandProbeTimer');
  runtime.commandProbeTimer = setTimeout(() => {
    runtime.commandProbeTimer = null;
    if (runtime.closed || runtime.stopping || token !== runtime.commandProbeToken) return;

    // The shell recorder writes activity events synchronously, but a quiet
    // command such as `sleep` may not produce another PTY chunk to trigger the
    // normal event-reader poll. Consume the journal before using the foreground
    // process fallback so exact Start/End state never depends on incidental output.
    runtime.eventReader?.poll();
    if (runtime.closed || runtime.stopping || token !== runtime.commandProbeToken) return;

    runtime.commandProbeAttempts += 1;
    const processName = tmuxPaneCurrentCommand(runtime.sessionId);
    const interactive = inspectKnownInteractivePane(runtime.sessionId, {
      privateSession: runtime.private,
      processName,
    });

    if (interactive?.state === 'busy') {
      runtime.commandProbeSawBusy = true;
      publishRuntimeCommandState(runtime, {
        running: true,
        phase: 'running',
        source: 'interactive',
        activityId: null,
        startedAt: runtime.commandState?.startedAt || new Date().toISOString(),
        processName: runtime.private ? '' : interactive.processName,
      });
      scheduleRuntimeCommandProbe(runtime, token, COMMAND_RUNNING_PROBE_INTERVAL_MS);
      return;
    }

    if (interactive?.state === 'ready') {
      const shellLaunchReachedPrompt = runtime.commandState?.source === 'shell';
      const submittedInputSettled = runtime.commandProbeSawBusy
        || runtime.commandProbeAttempts >= COMMAND_PROBE_PENDING_LIMIT;
      if (shellLaunchReachedPrompt || submittedInputSettled) {
        publishRuntimeCommandState(runtime, null, { completed: true });
        stopRuntimeCommandProbe(runtime);
      } else {
        scheduleRuntimeCommandProbe(runtime, token);
      }
      return;
    }

    if (runtime.commandState?.source === 'shell') {
      scheduleRuntimeCommandProbe(runtime, token, COMMAND_RUNNING_PROBE_INTERVAL_MS);
      return;
    }

    if (runtime.commandState?.source === 'input' && runtime.commandProbeAttempts < 3) {
      scheduleRuntimeCommandProbe(runtime, token);
      return;
    }

    const initialProcess = runtime.commandProbeInitialProcess;
    const unchangedInteractiveProcess = !foregroundCommandIsShell(initialProcess)
      && processName === initialProcess;
    if (!foregroundCommandIsShell(processName)) {
      if (unchangedInteractiveProcess) {
        if (runtime.commandProbeAttempts >= COMMAND_PROBE_PENDING_LIMIT) {
          publishRuntimeCommandState(runtime, null, { completed: true });
          stopRuntimeCommandProbe(runtime);
        } else {
          scheduleRuntimeCommandProbe(runtime, token);
        }
        return;
      }
      runtime.commandProbeSawBusy = true;
      publishRuntimeCommandState(runtime, {
        running: true,
        phase: 'running',
        source: 'process',
        activityId: null,
        startedAt: runtime.commandState?.startedAt || new Date().toISOString(),
        processName: runtime.private ? '' : processName,
      });
      scheduleRuntimeCommandProbe(runtime, token, COMMAND_RUNNING_PROBE_INTERVAL_MS);
      return;
    }

    if (runtime.commandProbeSawBusy || runtime.commandProbeAttempts >= COMMAND_PROBE_PENDING_LIMIT) {
      publishRuntimeCommandState(runtime, null, { completed: true });
      stopRuntimeCommandProbe(runtime);
      return;
    }
    scheduleRuntimeCommandProbe(runtime, token);
  }, delay);
  runtime.commandProbeTimer.unref?.();
}

function startRuntimeCommandProbe(runtime, { submitted = false, initialProcess = null } = {}) {
  if (runtime.commandState?.source === 'shell') return;
  const processBeforeSubmission = initialProcess === null
    ? tmuxPaneCurrentCommand(runtime.sessionId)
    : String(initialProcess);
  stopRuntimeCommandProbe(runtime);
  runtime.commandProbeInitialProcess = processBeforeSubmission;
  const token = runtime.commandProbeToken;
  if (submitted) {
    publishRuntimeCommandState(runtime, {
      running: true,
      phase: 'pending',
      source: 'input',
      activityId: null,
      startedAt: new Date().toISOString(),
      processName: '',
    });
    scheduleRuntimeCommandProbe(runtime, token);
    return;
  }

  const processName = processBeforeSubmission;
  const interactive = inspectKnownInteractivePane(runtime.sessionId, {
    privateSession: runtime.private,
    processName,
  });
  if (interactive?.state === 'ready') {
    publishRuntimeCommandState(runtime, null);
    return;
  }
  if (interactive?.state === 'busy') {
    runtime.commandProbeSawBusy = true;
    publishRuntimeCommandState(runtime, {
      running: true,
      phase: 'running',
      source: 'interactive',
      activityId: null,
      startedAt: runtime.commandState?.startedAt || null,
      processName: runtime.private ? '' : interactive.processName,
    });
    scheduleRuntimeCommandProbe(runtime, token, COMMAND_RUNNING_PROBE_INTERVAL_MS);
    return;
  }
  const processBusy = !foregroundCommandIsShell(processName);
  runtime.commandProbeSawBusy = processBusy;
  if (processBusy) {
    publishRuntimeCommandState(runtime, {
      running: true,
      phase: 'running',
      source: 'process',
      activityId: null,
      startedAt: runtime.commandState?.startedAt || null,
      processName: runtime.private ? '' : processName,
    });
  }
  scheduleRuntimeCommandProbe(
    runtime,
    token,
    processBusy ? COMMAND_RUNNING_PROBE_INTERVAL_MS : COMMAND_PROBE_INTERVAL_MS,
  );
}

function terminalInputSubmitsLine(bytes) {
  return Buffer.from(bytes || '').some((byte) => byte === 0x0a || byte === 0x0d);
}

function noteRuntimeCommandSubmission(runtime, bytes, initialProcess = null) {
  if (!terminalInputSubmitsLine(bytes)) return;
  if (runtime.commandState?.source === 'shell') return;
  if (runtime.commandState?.source === 'process') {
    if (!runtime.commandProbeTimer) startRuntimeCommandProbe(runtime);
    return;
  }
  startRuntimeCommandProbe(runtime, { submitted: true, initialProcess });
}

function handleRuntimeShellEvent(runtime, event) {
  if (!event) return;
  if (event.type === 'command-start' || event.type === 'block-start') {
    const activity = event.activity || event.block || {};
    stopRuntimeCommandProbe(runtime);
    publishRuntimeCommandState(runtime, {
      running: true,
      phase: 'running',
      source: 'shell',
      activityId: activity.id || null,
      startedAt: activity.startedAt || new Date().toISOString(),
      processName: '',
    });
    scheduleRuntimeCommandProbe(runtime, runtime.commandProbeToken, COMMAND_RUNNING_PROBE_INTERVAL_MS);
  } else if (event.type === 'command-end' || event.type === 'block-end') {
    const activity = event.activity || event.block || {};
    if (!runtime.commandState?.activityId || !activity.id || runtime.commandState.activityId === activity.id) {
      stopRuntimeCommandProbe(runtime);
      publishRuntimeCommandState(runtime, null, {
        completed: true,
        exitCode: Number.isInteger(activity.exitCode) ? activity.exitCode : null,
        durationMs: Number.isFinite(activity.durationMs) ? activity.durationMs : null,
      });
    }
  }
  broadcastRuntimeControl(runtime, event);
}

function writeRuntimeInput(runtime, ws, bytes) {
  if (!bytes?.length) return true;
  const initialProcess = terminalInputSubmitsLine(bytes)
    ? tmuxPaneCurrentCommand(runtime.sessionId)
    : null;
  const result = queueWorkerMessage(runtime.worker, {
    type: 'input',
    data: Buffer.from(bytes).toString('base64'),
  });
  if (!result.ok) sendWsInputError(ws, result.code, result.message);
  else noteRuntimeCommandSubmission(runtime, bytes, initialProcess);
  return result.ok;
}

function parseInputId(value) {
  if (typeof value !== 'string' || value.length > MAX_INPUT_ID_CHARS) return null;
  const match = /^([a-z0-9._-]{1,128}):([1-9][0-9]{0,15})$/iu.exec(value);
  if (!match) return null;
  const sequence = Number(match[2]);
  if (!Number.isSafeInteger(sequence) || sequence < 1) return null;
  return { clientId: match[1], sequence };
}

function validInputId(value) {
  return Boolean(parseInputId(value));
}

function acknowledgeRuntimeInput(runtime, ws, inputId) {
  if (!inputId) return;
  runtime.acceptedInputIds.set(inputId, Date.now());
  while (runtime.acceptedInputIds.size > 65_536) {
    runtime.acceptedInputIds.delete(runtime.acceptedInputIds.keys().next().value);
  }
  sendWsControl(ws, {
    type: 'input-ack',
    sessionId: runtime.sessionId,
    inputId,
  });
}

function inputWasAccepted(runtime, ws, inputId) {
  if (!inputId || !runtime.acceptedInputIds.has(inputId)) return false;
  sendWsControl(ws, {
    type: 'input-ack',
    sessionId: runtime.sessionId,
    inputId,
  });
  return true;
}

function broadcastRuntimeControl(runtime, message) {
  for (const ws of runtime.subscribers) sendWsControl(ws, message);
}

function runtimeSocketIsOpen(ws) {
  return Boolean(ws && ws.readyState === ws.OPEN);
}

function sendRuntimeRole(runtime, ws) {
  return sendWsControl(ws, {
    type: 'role',
    role: ws === runtime.controller ? 'controller' : 'spectator',
    sessionId: runtime.sessionId,
  });
}

function broadcastRuntimeRoles(runtime) {
  for (const ws of runtime.subscribers) sendRuntimeRole(runtime, ws);
}

function resizeRuntime(runtime, dimensions) {
  const workerResized = writeWorker(runtime.worker, {
    type: 'resize',
    cols: dimensions.cols,
    rows: dimensions.rows,
  });
  let tmuxResized = false;
  try {
    // A detached tmux window does not reliably follow the outer attach PTY's
    // SIGWINCH on every macOS/tmux version. Resize the one-pane window
    // explicitly so the active controller's geometry is authoritative.
    runTmux([
      'resize-window', '-t', runtime.sessionId,
      '-x', String(dimensions.cols), '-y', String(dimensions.rows),
    ]);
    tmuxResized = true;
  } catch {}
  return workerResized || tmuxResized;
}

function resizeRuntimeForController(runtime) {
  const controller = runtime.controller;
  if (!runtimeSocketIsOpen(controller) || !runtime.subscribers.has(controller)) return false;
  const dimensions = runtime.clientDimensions.get(controller) || { cols: 120, rows: 36 };
  return resizeRuntime(runtime, dimensions);
}

function setRuntimeController(runtime, ws, { resize = true } = {}) {
  if (runtime.closed || runtime.stopping) return false;
  if (!runtime.subscribers.has(ws) || !runtimeSocketIsOpen(ws)) return false;
  runtime.controller = ws;
  broadcastRuntimeRoles(runtime);
  if (resize) resizeRuntimeForController(runtime);
  return true;
}

function promoteRuntimeController(runtime) {
  if (runtime.closed || runtime.stopping) {
    runtime.controller = null;
    return null;
  }
  for (const candidate of runtime.subscribers) {
    if (runtimeSocketIsOpen(candidate) && setRuntimeController(runtime, candidate)) return candidate;
  }
  runtime.controller = null;
  broadcastRuntimeRoles(runtime);
  return null;
}

function addRuntimeSubscriber(runtime, ws, dimensions) {
  clearRuntimeTimer(runtime, 'idleTeardownTimer');
  runtime.subscribers.add(ws);
  runtime.clientDimensions.set(ws, dimensions);
  if (!runtimeSocketIsOpen(runtime.controller) || !runtime.subscribers.has(runtime.controller)) {
    promoteRuntimeController(runtime);
  } else {
    broadcastRuntimeRoles(runtime);
  }
}

function removeRuntimeSubscriber(runtime, ws) {
  const wasSubscriber = runtime.subscribers.delete(ws);
  runtime.clientDimensions.delete(ws);
  if (!wasSubscriber) return false;
  if (runtime.controller === ws) {
    runtime.controller = null;
    promoteRuntimeController(runtime);
  }
  if (runtime.subscribers.size === 0) scheduleRuntimeIdleTeardown(runtime);
  return true;
}

function broadcastRuntimeData(runtime, bytes) {
  for (const ws of runtime.subscribers) {
    if (ws.readyState !== ws.OPEN) continue;
    if (ws.bufferedAmount > MAX_WS_BUFFERED_BYTES) {
      sendWsControl(ws, { type: 'server-error', message: 'Terminal client fell too far behind; reconnect to resume.' });
      removeRuntimeSubscriber(runtime, ws);
      ws.close(1013, 'terminal client too slow');
      continue;
    }
    try { ws.send(bytes); } catch {}
  }
}

function clearRuntimeTimer(runtime, name) {
  if (!runtime[name]) return;
  clearTimeout(runtime[name]);
  runtime[name] = null;
}

function scheduleRuntimeIdleTeardown(runtime) {
  if (!runtime || runtime.closed || runtime.stopping || runtime.subscribers.size !== 0 || runtime.idleTeardownTimer) return;
  runtime.idleTeardownTimer = setTimeout(() => {
    runtime.idleTeardownTimer = null;
    if (runtime.closed || runtime.stopping || runtime.subscribers.size !== 0) return;
    if (sessionRuntimes.get(runtime.sessionId) !== runtime) return;
    terminateSessionRuntime(runtime);
  }, PTY_RUNTIME_IDLE_GRACE_MS);
  runtime.idleTeardownTimer.unref?.();
}

function terminateSessionRuntime(runtime) {
  if (!runtime || runtime.closed || runtime.stopping) return;
  runtime.stopping = true;
  clearRuntimeTimer(runtime, 'idleTeardownTimer');
  clearRuntimeTimer(runtime, 'commandProbeTimer');
  restoreRuntimeTmuxPassthrough(runtime);
  writeWorker(runtime.worker, { type: 'kill' });
  if (Number.isInteger(runtime.workerPid) && runtime.workerPid > 0) {
    try { process.kill(runtime.workerPid, 'SIGHUP'); } catch {}
  }
  runtime.forceKillTimer = setTimeout(() => {
    if (runtime.worker.exitCode === null && runtime.worker.signalCode === null) {
      try { runtime.worker.kill('SIGTERM'); } catch {}
    }
  }, 500);
  runtime.forceKillTimer.unref?.();
}

function closeRuntimeSubscribers(runtime, message) {
  clearRuntimeTimer(runtime, 'idleTeardownTimer');
  const subscribers = [...runtime.subscribers];
  runtime.controller = null;
  runtime.subscribers.clear();
  runtime.clientDimensions.clear();
  for (const ws of subscribers) {
    if (message) sendWsControl(ws, message);
    try { ws.close(); } catch {}
  }
}

function createSessionRuntime(session, { cols = 120, rows = 36 } = {}) {
  reconcileDatabaseEvents(session.id);
  const persistedRecord = readMetadata().sessions?.[session.id];
  const persistedCwd = persistedRecord?.cwd || session.cwd || os.homedir();
  const privateSession = Boolean(persistedRecord?.private || session.private);
  const profile = persistedRecord?.profile || session.profile || 'default';
  let privateHistoryState = null;
  let allowPassthroughPrevious = 'off';
  try {
    // These options affect future panes. An existing private pane is accepted
    // below only if its own immutable history capacity is already zero.
    runTmux(['set-option', '-t', session.id, 'focus-events', 'on']);
    runTmux(['set-option', '-t', session.id, 'history-limit', privateSession ? '0' : '50000']);
    runTmux(['set-option', '-t', session.id, 'mouse', 'on']);
    // This cannot rewrite the environment of an already-running shell, but it
    // makes respawned panes and future windows in older sessions color-capable.
    runTmux(['set-environment', '-u', '-t', session.id, 'NO_COLOR']);
    runTmux(['set-environment', '-t', session.id, 'COLORTERM', 'truecolor']);
    runTmux(['set-environment', '-t', session.id, 'WARPISH_TERMINAL', '1']);
    runTmux(['set-environment', '-t', session.id, 'WARPISH_ACTIVITY_INTEGRATION', '1']);
    runTmux(['set-environment', '-t', session.id, 'WARPISH_BLOCK_INTEGRATION', '0']);
    runTmux(['set-environment', '-t', session.id, 'WARPISH_PRIVATE_SESSION', privateSession ? '1' : '0']);
    runTmux(['set-environment', '-t', session.id, 'WARPISH_SESSION_PROFILE', profile]);
    if (privateSession) privateHistoryState = clearPrivateSessionHistory(session.id);
  } catch (error) {
    if (privateSession) {
      throw requestError(`private session is quarantined because tmux privacy checks failed: ${error.message || error}`, 409);
    }
    console.warn(`Could not refresh tmux capabilities for ${session.id}: ${error.message || error}`);
  }
  if (privateSession && !privateHistoryState?.safe) {
    throw requestError('private session is quarantined because an existing pane has a nonzero tmux history capacity', 409);
  }
  try {
    // Scope passthrough to this Warpish-owned session. It is restored when the
    // web PTY runtime tears down, leaving unrelated tmux sessions untouched.
    allowPassthroughPrevious = enableTmuxSessionPassthrough(session.id);
  } catch (error) {
    console.warn(`Could not enable tmux activity passthrough for ${session.id}; using process-state fallback: ${error.message || error}`);
  }
  const worker = createPtyWorker({
    sessionId: session.id,
    cwd: persistedCwd,
    privateSession,
    profile,
    cols,
    rows,
  });
  const runtime = {
    sessionId: session.id,
    epoch: crypto.randomUUID(),
    cwd: persistedCwd,
    private: privateSession,
    profile,
    worker,
    workerPid: null,
    subscribers: new Set(),
    clientDimensions: new Map(),
    acceptedInputIds: new Map(),
    controller: null,
    allowPassthroughPrevious,
    passthroughRestored: false,
    commandState: initialRuntimeCommandState(session.id, privateSession),
    commandProbeTimer: null,
    commandProbeToken: 0,
    commandProbeAttempts: 0,
    commandProbeSawBusy: false,
    commandProbeInitialProcess: '',
    stdoutBuffer: '',
    stderrBuffer: '',
    forceKillTimer: null,
    idleTeardownTimer: null,
    stopping: false,
    closed: false,
    lastExitMessage: null,
  };
  sessionRuntimes.set(session.id, runtime);

  runtime.outputProcessor = createOutputProcessor(session.id, {
    shouldRecordOutput() {
      return !runtime.private && sessionRuntimes.get(runtime.sessionId) === runtime;
    },
    onTerminalData(bytes) {
      broadcastRuntimeData(runtime, bytes);
    },
    onBlockEvent(event) {
      handleRuntimeShellEvent(runtime, event);
    },
  });
  runtime.eventReader = createEventReader(session.id, (event) => handleRuntimeShellEvent(runtime, event));

  worker.stdin.on('error', (error) => {
    runtime.stderrBuffer = `${runtime.stderrBuffer}\nstdin ${error.code || 'error'}: ${error.message || error}`.slice(-4096);
    closeRuntimeSubscribers(runtime, {
      type: 'server-error',
      message: `PTY input closed: ${error.code || error.message || 'stdin error'}`,
    });
  });

  worker.stdout.on('data', (chunk) => {
    runtime.stdoutBuffer += chunk.toString('utf8');
    let newlineIndex;
    while ((newlineIndex = runtime.stdoutBuffer.indexOf('\n')) >= 0) {
      const line = runtime.stdoutBuffer.slice(0, newlineIndex);
      runtime.stdoutBuffer = runtime.stdoutBuffer.slice(newlineIndex + 1);
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.type === 'output') {
        const bytes = Buffer.from(message.data, 'base64');
        runtime.eventReader.poll();
        runtime.outputProcessor.processBytes(bytes);
        runtime.eventReader.poll();
      } else if (message.type === 'ready') {
        runtime.workerPid = message.pid;
        broadcastRuntimeControl(runtime, {
          type: 'hello',
          pid: runtime.workerPid,
          sessionId: runtime.sessionId,
          runtimeEpoch: runtime.epoch,
          cwd: runtime.cwd,
          shell: SHELL,
          commandState: runtime.commandState,
        });
      } else if (message.type === 'exit') {
        runtime.lastExitMessage = { type: 'detached', exitCode: message.exitCode, signal: message.signal };
        broadcastRuntimeControl(runtime, runtime.lastExitMessage);
      } else if (message.type === 'error') {
        const code = typeof message.code === 'string' ? message.code.slice(0, 80) : 'pty-worker-error';
        const detail = typeof message.message === 'string' ? message.message.slice(0, 500) : 'PTY worker rejected input.';
        runtime.stderrBuffer = `${runtime.stderrBuffer}\n${code}: ${detail}`.slice(-4096);
        broadcastRuntimeControl(runtime, { type: 'server-error', code, message: detail });
      }
    }
  });

  worker.stderr.on('data', (chunk) => {
    runtime.stderrBuffer += chunk.toString('utf8');
    if (runtime.stderrBuffer.length > 4096) runtime.stderrBuffer = runtime.stderrBuffer.slice(-4096);
  });

  worker.on('error', (error) => {
    closeRuntimeSubscribers(runtime, { type: 'server-error', message: error.message });
  });

  worker.on('close', (code, signal) => {
    runtime.closed = true;
    clearRuntimeTimer(runtime, 'forceKillTimer');
    clearRuntimeTimer(runtime, 'idleTeardownTimer');
    clearRuntimeTimer(runtime, 'commandProbeTimer');
    restoreRuntimeTmuxPassthrough(runtime);
    runtime.eventReader.poll();
    runtime.outputProcessor.flush();
    if (sessionRuntimes.get(runtime.sessionId) === runtime) sessionRuntimes.delete(runtime.sessionId);
    const detached = runtime.lastExitMessage || {
      type: 'detached',
      exitCode: code,
      signal,
      stderr: runtime.stderrBuffer.slice(-1000),
    };
    closeRuntimeSubscribers(runtime, detached);
  });

  scheduleRuntimeIdleTeardown(runtime);
  if (['process', 'interactive'].includes(runtime.commandState?.source)) startRuntimeCommandProbe(runtime);
  return runtime;
}

function ensureSessionRuntime(session, dimensions = {}) {
  let runtime = sessionRuntimes.get(session.id);
  let created = false;
  if (!runtime || runtime.closed || runtime.stopping) {
    runtime = createSessionRuntime(session, dimensions);
    created = true;
  }
  return { runtime, created };
}

function sendRuntimeSnapshot(ws, sessionId) {
  let cursor = paneCursorState(sessionId);
  let current = capturePaneText(sessionId, { escape: true, history: false });
  let cursorAfterCapture = paneCursorState(sessionId);
  if (cursor.ok && cursorAfterCapture.ok && cursor.alternateActive !== cursorAfterCapture.alternateActive) {
    current = capturePaneText(sessionId, { escape: true, history: false });
    cursorAfterCapture = paneCursorState(sessionId);
  }
  cursor = cursorAfterCapture.ok ? cursorAfterCapture : cursor;
  if (!current) return;
  const activeText = current.replace(/\n/g, '\r\n');
  const cursorState = `\x1b[0m\x1b[?25${cursor.visible ? 'h' : 'l'}\x1b[${cursor.y + 1};${cursor.x + 1}H`;
  // The PTY stream belongs to the outer tmux client, which keeps its own
  // alternate screen for the lifetime of the attach. Mirror that outer client
  // state here; pane-level 1049h/l transitions are already rendered by tmux as
  // screen updates and must not switch the browser's outer buffer independently.
  const snapshot = `\x1b[?1049h\x1b[0m\x1b[?25h\x1b[2J\x1b[H${activeText}${cursorState}`;
  if (ws.readyState === ws.OPEN) ws.send(Buffer.from(snapshot, 'utf8'));
}

server.on('upgrade', (req, socket, head) => {
  if (!isAllowedOrigin(req)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }
  const token = tokenFromReq(req);
  if (!safeToken(token)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (ws, req) => {
  ws.warpishAlive = true;
  ws.on('pong', () => { ws.warpishAlive = true; });
  ws.on('error', (error) => {
    console.warn(`WebSocket client error: ${error?.message || error}`);
  });

  let url;
  try {
    url = new URL(req.url || '/', 'http://localhost');
  } catch {
    sendWsControl(ws, { type: 'server-error', message: 'Malformed WebSocket URL' });
    ws.close();
    return;
  }
  const sessionId = url.searchParams.get('sessionId');
  if (!isValidSessionId(sessionId)) {
    sendWsControl(ws, { type: 'server-error', message: 'Missing or invalid sessionId' });
    ws.close();
    return;
  }
  const sessions = summarizeSessions();
  const session = sessions.find((candidate) => candidate.id === sessionId);
  if (!session?.alive) {
    sendWsControl(ws, { type: 'server-error', message: 'Session is not running. Create a new terminal.' });
    ws.close();
    return;
  }
  if (session.privacyQuarantined) {
    sendWsControl(ws, {
      type: 'server-error',
      code: 'private-history-quarantined',
      message: 'Private session is quarantined because an existing tmux pane has nonzero history capacity. Kill it or continue it directly in tmux; Warpish will not attach or capture it.',
    });
    ws.close();
    return;
  }

  touchSession(sessionId);
  const cols = clampNumber(url.searchParams.get('cols'), 120, 20, 300);
  const rows = clampNumber(url.searchParams.get('rows'), 36, 5, 120);
  let runtime;
  let created;
  try {
    ({ runtime, created } = ensureSessionRuntime(session, { cols, rows }));
  } catch (error) {
    const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
    const message = error?.message || 'Terminal runtime could not be attached.';
    const code = statusCode === 409 && message.startsWith('private session is quarantined')
      ? 'private-history-quarantined'
      : 'runtime-attach-failed';
    sendWsControl(ws, { type: 'server-error', code, statusCode, message });
    try { ws.close(statusCode >= 500 ? 1011 : 1008, code); } catch {}
    return;
  }
  addRuntimeSubscriber(runtime, ws, { cols, rows });
  if (runtime.workerPid) {
    sendWsControl(ws, {
      type: 'hello',
      pid: runtime.workerPid,
      sessionId,
      runtimeEpoch: runtime.epoch,
      cwd: runtime.cwd,
      shell: SHELL,
      commandState: runtime.commandState,
    });
  }
  if (!created) sendRuntimeSnapshot(ws, sessionId);

  ws.on('message', (raw, isBinary) => {
    if (isBinary) {
      sendWsInputError(ws, 'unsupported-binary-frame', 'Send binary terminal input as JSON type=input-binary with base64 data.');
      return;
    }
    const rawText = String(raw);
    let msg;
    try {
      msg = JSON.parse(rawText);
    } catch {
      if (runtime.controller !== ws) {
        sendRuntimeRole(runtime, ws);
        return;
      }
      if (Buffer.byteLength(rawText, 'utf8') > MAX_TERMINAL_INPUT_BYTES) {
        sendWsInputError(ws, 'input-too-large', `Terminal input exceeds the ${MAX_TERMINAL_INPUT_BYTES}-byte limit.`);
        return;
      }
      const rawInputData = stripTerminalFocusReports(String(raw));
      if (rawInputData) writeRuntimeInput(runtime, ws, Buffer.from(rawInputData, 'utf8'));
      return;
    }

    if (msg?.type === 'input') {
      if (runtime.controller !== ws) {
        sendRuntimeRole(runtime, ws);
        return;
      }
      if (typeof msg.data !== 'string') {
        sendWsInputError(ws, 'invalid-input', 'Terminal input data must be a string.');
        return;
      }
      if (Buffer.byteLength(msg.data, 'utf8') > MAX_TERMINAL_INPUT_BYTES) {
        sendWsInputError(ws, 'input-too-large', `Terminal input exceeds the ${MAX_TERMINAL_INPUT_BYTES}-byte limit.`);
        return;
      }
      if (msg.inputId !== undefined && !validInputId(msg.inputId)) {
        sendWsInputError(ws, 'invalid-input-id', 'Terminal input id is invalid.');
        return;
      }
      if (inputWasAccepted(runtime, ws, msg.inputId)) return;
      const inputData = msg.allowFocusReports ? msg.data : stripTerminalFocusReports(msg.data);
      if (!inputData) {
        acknowledgeRuntimeInput(runtime, ws, msg.inputId);
        return;
      }
      let accepted = false;
      if (msg.directTmux) {
        const initialProcess = terminalInputSubmitsLine(Buffer.from(inputData, 'utf8'))
          ? tmuxPaneCurrentCommand(runtime.sessionId)
          : null;
        try {
          writeTmuxInput(sessionId, inputData);
          accepted = true;
          noteRuntimeCommandSubmission(runtime, Buffer.from(inputData, 'utf8'), initialProcess);
        } catch (error) {
          sendWsControl(ws, { type: 'server-error', message: `tmux input failed: ${error.message || error}` });
        }
      } else {
        accepted = writeRuntimeInput(runtime, ws, Buffer.from(inputData, 'utf8'));
      }
      if (accepted) acknowledgeRuntimeInput(runtime, ws, msg.inputId);
    } else if (msg?.type === 'input-binary') {
      if (runtime.controller !== ws) {
        sendRuntimeRole(runtime, ws);
        return;
      }
      const decoded = decodeBase64Strict(msg.data, MAX_TERMINAL_INPUT_BYTES);
      if (!decoded.ok) {
        const message = decoded.code === 'input-too-large'
          ? `Binary terminal input exceeds the ${MAX_TERMINAL_INPUT_BYTES}-byte limit.`
          : 'Binary terminal input must contain canonical base64 data.';
        sendWsInputError(ws, decoded.code, message);
        return;
      }
      if (msg.inputId !== undefined && !validInputId(msg.inputId)) {
        sendWsInputError(ws, 'invalid-input-id', 'Binary terminal input id is invalid.');
        return;
      }
      if (inputWasAccepted(runtime, ws, msg.inputId)) return;
      if (writeRuntimeInput(runtime, ws, decoded.bytes)) {
        acknowledgeRuntimeInput(runtime, ws, msg.inputId);
      }
    } else if (msg?.type === 'resize') {
      const dimensions = {
        cols: clampNumber(msg.cols, 120, 20, 300),
        rows: clampNumber(msg.rows, 36, 5, 120),
      };
      runtime.clientDimensions.set(ws, dimensions);
      if (runtime.controller === ws) {
        resizeRuntime(runtime, dimensions);
      }
    } else if (msg?.type === 'take-control') {
      const currentDimensions = runtime.clientDimensions.get(ws) || { cols: 120, rows: 36 };
      const dimensions = {
        cols: clampNumber(msg.cols, currentDimensions.cols, 20, 300),
        rows: clampNumber(msg.rows, currentDimensions.rows, 5, 120),
      };
      runtime.clientDimensions.set(ws, dimensions);
      setRuntimeController(runtime, ws);
    } else if (msg?.type === 'detach') {
      removeRuntimeSubscriber(runtime, ws);
      ws.close(1000, 'detached');
    }
  });

  ws.on('close', () => {
    removeRuntimeSubscriber(runtime, ws);
  });
});

const wsHeartbeatTimer = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.readyState !== ws.OPEN) continue;
    if (ws.warpishAlive === false) {
      ws.terminate();
      continue;
    }
    ws.warpishAlive = false;
    try { ws.ping(); } catch { ws.terminate(); }
  }
}, WS_HEARTBEAT_INTERVAL_MS);
wsHeartbeatTimer.unref?.();

let shuttingDown = false;
function shutdownServer(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(wsHeartbeatTimer);
  for (const ws of wss.clients) {
    try { ws.close(1001, 'server shutting down'); } catch {}
  }
  for (const runtime of sessionRuntimes.values()) terminateSessionRuntime(runtime);
  const forceExitTimer = setTimeout(() => process.exit(0), 1500);
  server.close(() => {
    clearTimeout(forceExitTimer);
    process.exit(0);
  });
  console.log(`Received ${signal}; shutting down Warpish web/PTY runtimes while keeping tmux sessions alive.`);
}

process.once('SIGINT', () => shutdownServer('SIGINT'));
process.once('SIGTERM', () => shutdownServer('SIGTERM'));

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}/?token=${encodeURIComponent(TOKEN)}`;
  const printedUrl = process.env.WARPISH_REDACT_LOG_TOKEN === '1'
    ? `http://${HOST}:${PORT}/?token=<redacted>`
    : url;
  console.log(isLoopbackHost(HOST) ? 'Warpish Terminal is running local-only.' : 'Warpish Terminal is running with explicit remote-bind opt-in.');
  console.log(`URL: ${printedUrl}`);
  console.log(`Shell: ${SHELL}`);
  console.log(`tmux: ${TMUX}`);
  console.log(`Token file: ${TOKEN_FILE}`);
});
