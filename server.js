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
const MAX_WORKER_STDIN_BUFFER_BYTES = 1024 * 1024;
const MAX_SESSION_TITLE_CHARS = 80;
const MAX_SESSION_PROFILE_CHARS = 40;
const SESSION_PROFILE_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,39})$/;
const WS_HEARTBEAT_INTERVAL_MS = clampNumber(process.env.WARPISH_WS_HEARTBEAT_MS, 30_000, 1000, 120_000);
const PTY_RUNTIME_IDLE_GRACE_MS = clampNumber(process.env.WARPISH_PTY_IDLE_GRACE_MS, 30_000, 100, 600_000);
const TMUX_COMMAND_TIMEOUT_MS = clampNumber(process.env.WARPISH_TMUX_TIMEOUT_MS, 5000, 250, 60_000);
const TMUX_MAX_BUFFER_BYTES = 8 * 1024 * 1024;
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
    maxAge: 1000 * 60 * 60 * 12,
  };
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

function tmuxPaneHistoryState(sessionId) {
  try {
    const panes = runTmux(['list-panes', '-s', '-t', sessionId, '-F', '#{pane_id}\t#{history_limit}\t#{history_size}'])
      .split('\n')
      .map((value) => value.trim())
      .filter(Boolean)
      .map((line) => {
        const [paneId, limit, size] = line.split('\t');
        return { paneId, limit: Number(limit), size: Number(size) };
      })
      .filter((pane) => /^%\d+$/u.test(pane.paneId) && Number.isFinite(pane.limit) && Number.isFinite(pane.size));
    return { ok: panes.length > 0, panes };
  } catch {
    return { ok: false, panes: [] };
  }
}

function privateSessionHistorySafe(sessionId) {
  const state = tmuxPaneHistoryState(sessionId);
  return state.ok && state.panes.every((pane) => pane.limit === 0);
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

function warpishShellCommand(sessionId, { privateSession = false, profile = 'default' } = {}) {
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
    'WARPISH_BLOCK_INTEGRATION=1',
    `WARPISH_PRIVATE_SESSION=${privateSession ? '1' : '0'}`,
    `WARPISH_SESSION_PROFILE=${shellQuote(profile)}`,
    `ZDOTDIR=${shellQuote(ZDOTDIR)}`,
    shellQuote(SHELL),
    '-l',
    '-i',
  ].join(' ');
}

function stripAnsi(text) {
  return String(text)
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[()][A-Za-z0-9]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n');
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

function getBlocks(sessionId) {
  if (sessionIsPrivate(sessionId)) return [];
  reconcileDatabaseEvents(sessionId);
  if (!flushPendingBlockOutput(sessionId)) refreshActiveBlockOutput(sessionId);
  const meta = readMetadata();
  const record = meta.sessions?.[sessionId];
  return Array.isArray(record?.blocks) ? record.blocks.map(normalizeBlock).slice().reverse() : [];
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
  if ((marker.event === 'Start' || marker.event === 'End') && !validateBlockMarker(sessionId, marker)) return null;
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
    output = runTmux(['list-sessions', '-F', '#{session_name}\t#{session_created}\t#{session_attached}\t#{session_windows}']);
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
    const [name, created, attached, windows] = line.split('\t');
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

function captureContentLines(text) {
  return stripAnsi(text)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function joinCaptureSections(first, second) {
  if (!first) return second || '';
  if (!second) return first;
  return `${first.trimEnd()}\n${second.replace(/^\n+/, '')}`.trimEnd();
}

function capturePaneState(id, { lines = 600, escape = false, retryCount = 0 } = {}) {
  const alternateActive = paneAlternateScreenActive(id);
  if (!alternateActive) {
    const normal = capturePaneText(id, { lines, escape });
    if (paneAlternateScreenActive(id) !== alternateActive && retryCount < 2) {
      return capturePaneState(id, { lines, escape, retryCount: retryCount + 1 });
    }
    return {
      alternateActive,
      normal,
      alternate: '',
      active: normal,
      history: normal,
    };
  }

  const prefix = capturePaneText(id, { lines, escape, historyOnly: true });
  const active = capturePaneText(id, { escape, history: false });
  const alternate = capturePaneText(id, { alternate: true, escape });
  if (paneAlternateScreenActive(id) !== alternateActive && retryCount < 2) {
    return capturePaneState(id, { lines, escape, retryCount: retryCount + 1 });
  }
  const normal = joinCaptureSections(prefix, active);
  const history = joinCaptureSections(prefix, alternate);
  return { alternateActive, normal, alternate, active, history };
}

function captureLooksStandaloneTui(capture) {
  const lines = captureContentLines(capture);
  const joined = lines.join('\n');
  const vimTildeLines = lines.filter((line) => /^~\s*$/u.test(line)).length;
  return vimTildeLines >= 3
    || /--\s*(?:INSERT|NORMAL|VISUAL|REPLACE)\s*--/u.test(joined)
    || /\b(?:VIM - Vi IMproved|GNU nano|less\s+\d|htop|top -)\b/iu.test(joined)
    || /\(END\)(?:\s|$)/mu.test(joined);
}

function choosePaneCapture({ normal = '', active = '', history = '', alternateActive = false } = {}) {
  // tmux capture-pane without -a always captures the buffer that is currently
  // visible. When alternate_on=1, `capture-pane -a` is the displaced/saved
  // primary screen, not the live alternate-screen viewport. Keep the legacy
  // normal/alternate argument names for the API, but never select `alternate`
  // as the live screen while an alternate buffer is active.
  if (!alternateActive && normal.trim()) {
    return { text: normal, usingAlternate: false, reason: 'normal-active' };
  }
  if (!alternateActive) return { text: normal, usingAlternate: false, reason: 'normal-empty' };

  const historyLines = captureContentLines(history).length;
  const activeLines = captureContentLines(active).length;
  const historyIsMuchRicher = historyLines >= Math.max(activeLines + 20, activeLines * 2);
  const activeLooksTui = captureLooksStandaloneTui(active);

  if (!active.trim()) {
    return historyIsMuchRicher
      ? { text: history, usingAlternate: false, reason: 'normal-rich-history' }
      : { text: '', usingAlternate: true, reason: 'alternate-empty' };
  }

  // tmux may prepend scrollback to the active alternate viewport. Classify that
  // combined capture as history for Hermes/prompt-toolkit-like panes so the
  // readable surface can retain its canonical scrollback and merge live redraws.
  // A recognizable standalone editor/TUI remains screen content.
  if (historyIsMuchRicher && !activeLooksTui) {
    return { text: history, usingAlternate: false, reason: 'normal-rich-history' };
  }

  return { text: active, usingAlternate: true, reason: 'alternate-active' };
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

function validateSessionTitle(value, { allowEmpty = true } = {}) {
  if (value !== undefined && value !== null && typeof value !== 'string') {
    throw requestError('title must be a string');
  }
  const title = String(value || '').trim();
  if (!allowEmpty && !title) throw requestError('title must not be empty');
  if (title.length > MAX_SESSION_TITLE_CHARS) {
    throw requestError(`title must be ${MAX_SESSION_TITLE_CHARS} characters or fewer`);
  }
  if (/[\u0000-\u001f\u007f]/u.test(title)) {
    throw requestError('title must not contain control characters');
  }
  return title;
}

function validateNewSessionInput(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw requestError('request body must be a JSON object');
  }

  const title = validateSessionTitle(input.title);

  let requestedCwd = input.cwd;
  if (requestedCwd !== undefined && requestedCwd !== null && typeof requestedCwd !== 'string') {
    throw requestError('cwd must be a string');
  }
  requestedCwd = String(requestedCwd || '').trim();
  if (requestedCwd.includes('\u0000')) throw requestError('cwd must not contain NUL bytes');
  if (!requestedCwd) requestedCwd = os.homedir();
  if (requestedCwd === '~') requestedCwd = os.homedir();
  else if (requestedCwd.startsWith('~/')) requestedCwd = path.join(os.homedir(), requestedCwd.slice(2));
  if (!path.isAbsolute(requestedCwd)) {
    throw requestError('cwd must be an absolute directory path or start with ~/');
  }
  const cwd = path.resolve(requestedCwd);
  try {
    if (!fs.statSync(cwd).isDirectory()) throw requestError('cwd must reference an existing directory');
    fs.accessSync(cwd, fs.constants.X_OK);
  } catch (error) {
    if (error?.statusCode) throw error;
    throw requestError('cwd must reference an existing accessible directory');
  }

  let profile = input.profile;
  if (profile !== undefined && profile !== null && typeof profile !== 'string') {
    throw requestError('profile must be a string');
  }
  profile = String(profile || 'default').trim();
  if (profile.length > MAX_SESSION_PROFILE_CHARS || !SESSION_PROFILE_PATTERN.test(profile)) {
    throw requestError(`profile must be a lowercase identifier of ${MAX_SESSION_PROFILE_CHARS} characters or fewer using letters, numbers, dot, underscore, or dash`);
  }

  if (input.private !== undefined && typeof input.private !== 'boolean') {
    throw requestError('private must be a boolean');
  }

  return { title, cwd, profile, privateSession: Boolean(input.private) };
}

function createSession(input = {}) {
  const { title, cwd, profile, privateSession } = validateNewSessionInput(input);
  const meta = readMetadata();
  const now = new Date();
  const index = meta.nextIndex || Object.keys(meta.sessions).length + 1;
  const id = `${PREFIX}${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
  const safeCwd = cwd;
  const sessionTitle = title || `Terminal ${index}`;
  let tmuxCreated = false;
  let metadataWritten = false;

  try {
    const bootstrapWindow = 'warpish-bootstrap';
    // tmux copies history-limit into each pane only when that pane is created.
    // Create a content-free bootstrap first, configure the session, then launch
    // the real shell in a new pane so 0/50000 is effective rather than cosmetic.
    runTmux(['new-session', '-d', '-s', id, '-n', bootstrapWindow, '-c', safeCwd, '/bin/sleep 60']);
    tmuxCreated = true;
    runTmux(['set-option', '-t', id, 'status', 'off']);
    runTmux(['set-option', '-t', id, 'history-limit', privateSession ? '0' : '50000']);
    runTmux(['set-option', '-t', id, 'allow-rename', 'off']);
    runTmux(['set-option', '-t', id, 'allow-passthrough', 'on']);
    runTmux(['set-option', '-t', id, 'focus-events', 'on']);
    runTmux(['set-environment', '-u', '-t', id, 'NO_COLOR']);
    runTmux(['set-environment', '-t', id, 'COLORTERM', 'truecolor']);
    runTmux(['set-environment', '-t', id, 'WARPISH_TERMINAL', '1']);
    runTmux(['set-environment', '-t', id, 'WARPISH_SESSION_ID', id]);
    runTmux(['set-environment', '-t', id, 'WARPISH_DATABASE_FILE', DATABASE_FILE]);
    runTmux(['set-environment', '-t', id, 'WARPISH_EVENT_RECORDER', SHELL_EVENT_RECORDER]);
    runTmux(['set-environment', '-t', id, 'WARPISH_PYTHON', PYTHON]);
    runTmux(['set-environment', '-t', id, 'WARPISH_BLOCK_INTEGRATION', '1']);
    runTmux(['set-environment', '-t', id, 'WARPISH_PRIVATE_SESSION', privateSession ? '1' : '0']);
    runTmux(['set-environment', '-t', id, 'WARPISH_SESSION_PROFILE', profile]);
    runTmux(['set-environment', '-t', id, 'ZDOTDIR', ZDOTDIR]);
    runTmux([
      'new-window',
      '-d',
      '-t', `${id}:`,
      '-n', 'terminal',
      '-c', safeCwd,
      warpishShellCommand(id, { privateSession, profile }),
    ]);
    runTmux(['kill-window', '-t', `${id}:${bootstrapWindow}`]);
    if (privateSession && !clearPrivateSessionHistory(id).safe) {
      throw new Error('private tmux pane was not created with an effective zero history limit');
    }

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

function renameSession(id, title) {
  const meta = readMetadata();
  if (!meta.sessions[id]) return null;
  meta.sessions[id].title = validateSessionTitle(title, { allowEmpty: false });
  writeMetadata(meta);
  return summarizeSessions().find((session) => session.id === id) || null;
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

function requireSessionRecord(id) {
  const record = readMetadata().sessions?.[id];
  if (!record) throw requestError('session not found', 404);
  return record;
}

function requireLiveSession(id) {
  const record = requireSessionRecord(id);
  const activeResult = listActiveTmuxSessions();
  if (!activeResult.ok) {
    throw requestError('tmux session state is temporarily unavailable', 503);
  }
  if (!activeResult.sessions.has(id)) {
    throw requestError('session is stopped; pane operations require a live session', 409);
  }
  return record;
}

function paneCount(id) {
  const value = Number.parseInt(runTmux(['display-message', '-p', '-t', id, '#{window_panes}']).trim(), 10);
  return Number.isFinite(value) ? value : null;
}

function splitSessionPane(id, direction) {
  const record = requireLiveSession(id);
  if (record.private && !privateSessionHistorySafe(id)) {
    throw requestError('private session is quarantined because an existing pane has nonzero tmux history capacity', 409);
  }
  if (direction !== 'vertical' && direction !== 'horizontal') {
    throw requestError('direction must be either vertical or horizontal');
  }
  try {
    const splitFlag = direction === 'vertical' ? '-h' : '-v';
    const paneId = runTmux([
      'split-window',
      splitFlag,
      '-P',
      '-F',
      '#{pane_id}',
      '-t',
      id,
      '-c',
      '#{pane_current_path}',
      warpishShellCommand(id, {
        privateSession: Boolean(record.private),
        profile: record.profile || 'default',
      }),
    ]).trim();
    if (record.private) clearPrivateSessionHistory(id);
    return { paneId, panes: paneCount(id), direction };
  } catch (error) {
    error.statusCode = error.statusCode || 503;
    throw error;
  }
}

function selectNextSessionPane(id) {
  const record = requireLiveSession(id);
  if (record.private && !privateSessionHistorySafe(id)) {
    throw requestError('private session is quarantined because an existing pane has nonzero tmux history capacity', 409);
  }
  try {
    runTmux(['select-pane', '-t', `${id}:.+`]);
    const paneId = runTmux(['display-message', '-p', '-t', id, '#{pane_id}']).trim();
    return { paneId, panes: paneCount(id) };
  } catch (error) {
    error.statusCode = error.statusCode || 503;
    throw error;
  }
}

function exportFilename(record) {
  const stem = String(record.title || record.id || 'terminal')
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'terminal';
  const date = new Date().toISOString().slice(0, 10);
  return `${stem}-${date}.txt`;
}

function sessionExport(id) {
  const record = requireSessionRecord(id);
  const privateSession = Boolean(record.private);
  const activeResult = listActiveTmuxSessions();
  const alive = activeResult.ok && activeResult.sessions.has(id);
  const blocks = privateSession ? [] : getBlocks(id).slice().reverse();
  let capture = '';

  if (alive) {
    if (!privateSession) {
      const selected = choosePaneCapture(capturePaneState(id, { lines: 5000 }));
      capture = selected.text;
    }
  } else if (!privateSession) {
    capture = record.lastPreview || '';
  }

  const lines = [
    `Warpish Terminal export`,
    `Title: ${record.title || record.id}`,
    `Session: ${record.id}`,
    `Created: ${record.createdAt || 'unknown'}`,
    `State: ${alive ? 'live' : 'stopped'}`,
    `Working directory: ${record.cwd || os.homedir()}`,
    `Shell: ${record.shell || SHELL}`,
    `Profile: ${record.profile || 'default'}`,
    `Private: ${privateSession ? 'yes' : 'no'}`,
    `Exported: ${new Date().toISOString()}`,
    '',
  ];

  if (privateSession) {
    lines.push('Private session: command blocks, previews, scrollback, and terminal capture were not retained or exported.');
    lines.push('');
  }

  if (blocks.length) {
    lines.push('Command blocks', '==============', '');
    blocks.forEach((block, index) => {
      lines.push(
        `[${index + 1}] ${block.command || '(empty command)'}`,
        `Status: ${block.status || 'unknown'}${block.exitCode === null ? '' : ` (exit ${block.exitCode})`}`,
        `Started: ${block.startedAt || 'unknown'}`,
        `Ended: ${block.endedAt || 'unknown'}`,
      );
      if (block.output) lines.push('', stripAnsi(block.output));
      lines.push('', '---', '');
    });
  }

  if (capture) {
    lines.push(privateSession ? 'Current pane' : 'Terminal capture', '================', '', stripAnsi(limitText(capture)), '');
  } else {
    lines.push(privateSession ? 'No private terminal content is available.' : 'No terminal capture is available.', '');
  }

  return { filename: exportFilename(record), text: lines.join('\n').trimEnd() + '\n' };
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
  if (!safeToken(token)) return unauthorized(res);
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

app.post('/api/sessions', (req, res) => {
  try {
    const session = createSession(req.body || {});
    res.status(201).json({ session, sessions: summarizeSessions() });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message || String(error) });
  }
});

app.get('/api/sessions/:id/blocks', (req, res) => {
  const { id } = req.params;
  if (!isValidSessionId(id)) return res.status(400).json({ error: 'invalid session id' });
  if (!readMetadata().sessions?.[id]) return res.status(404).json({ error: 'session not found' });
  res.json({ blocks: getBlocks(id) });
});

app.get('/api/sessions/:id/export', (req, res) => {
  const { id } = req.params;
  if (!isValidSessionId(id)) return res.status(400).json({ error: 'invalid session id' });
  try {
    res.json(sessionExport(id));
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message || String(error) });
  }
});

app.post('/api/sessions/:id/panes', (req, res) => {
  const { id } = req.params;
  if (!isValidSessionId(id)) return res.status(400).json({ error: 'invalid session id' });
  try {
    const pane = splitSessionPane(id, req.body?.direction);
    res.status(201).json({ ok: true, pane, sessions: summarizeSessions() });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message || String(error) });
  }
});

app.post('/api/sessions/:id/panes/next', (req, res) => {
  const { id } = req.params;
  if (!isValidSessionId(id)) return res.status(400).json({ error: 'invalid session id' });
  try {
    const pane = selectNextSessionPane(id);
    res.json({ ok: true, pane, sessions: summarizeSessions() });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message || String(error) });
  }
});

app.get('/api/sessions/:id/capture', (req, res) => {
  const { id } = req.params;
  if (!isValidSessionId(id)) return res.status(400).json({ error: 'invalid session id' });
  const record = readMetadata().sessions?.[id];
  if (!record) return res.status(404).json({ error: 'session not found' });
  if (record.private) {
    const alternateActive = paneAlternateScreenActive(id);
    return res.json({
      text: '',
      normal: '',
      alternate: '',
      active: '',
      savedPrimary: '',
      history: '',
      usingAlternate: alternateActive,
      alternateActive,
      captureReason: alternateActive ? 'alternate-active' : 'private-session',
      ansi: req.query.ansi === '1' || req.query.escape === '1',
      private: true,
      warning: 'Private sessions do not expose terminal capture or scrollback.',
    });
  }
  const lines = clampNumber(req.query.lines, 600, 20, 5000);
  const escape = req.query.ansi === '1' || req.query.escape === '1';
  const capture = capturePaneState(id, { lines, escape });
  const selected = choosePaneCapture(capture);
  res.json({
    text: limitText(selected.text),
    // Backward-compatible names: `normal` is tmux's current/active capture;
    // while alternate_on=1, `alternate` is the saved primary buffer from -a.
    normal: limitText(capture.normal),
    alternate: limitText(capture.alternate),
    active: limitText(capture.active),
    savedPrimary: limitText(capture.alternate),
    history: limitText(capture.history),
    usingAlternate: selected.usingAlternate,
    alternateActive: capture.alternateActive,
    captureReason: selected.reason,
    ansi: escape,
  });
});

app.patch('/api/sessions/:id', (req, res) => {
  const { id } = req.params;
  if (!isValidSessionId(id)) return res.status(400).json({ error: 'invalid session id' });
  try {
    const session = renameSession(id, req.body?.title);
    if (!session) return res.status(404).json({ error: 'session not found' });
    res.json({ session, sessions: summarizeSessions() });
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
  '/vendor/search.js': 'node_modules/@xterm/addon-search/lib/addon-search.js',
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

function writeRuntimeInput(runtime, ws, bytes) {
  if (!bytes?.length) return true;
  const result = queueWorkerMessage(runtime.worker, {
    type: 'input',
    data: Buffer.from(bytes).toString('base64'),
  });
  if (!result.ok) sendWsInputError(ws, result.code, result.message);
  return result.ok;
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
  try {
    // These options affect future panes. An existing private pane is accepted
    // below only if its own immutable history capacity is already zero.
    runTmux(['set-option', '-t', session.id, 'focus-events', 'on']);
    runTmux(['set-option', '-t', session.id, 'history-limit', privateSession ? '0' : '50000']);
    // This cannot rewrite the environment of an already-running shell, but it
    // makes respawned panes and future windows in older sessions color-capable.
    runTmux(['set-environment', '-u', '-t', session.id, 'NO_COLOR']);
    runTmux(['set-environment', '-t', session.id, 'COLORTERM', 'truecolor']);
    runTmux(['set-environment', '-t', session.id, 'WARPISH_TERMINAL', '1']);
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
    cwd: persistedCwd,
    private: privateSession,
    profile,
    worker,
    workerPid: null,
    subscribers: new Set(),
    clientDimensions: new Map(),
    controller: null,
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
      broadcastRuntimeControl(runtime, event);
    },
  });
  runtime.eventReader = createEventReader(session.id, (event) => broadcastRuntimeControl(runtime, event));

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
          cwd: runtime.cwd,
          shell: SHELL,
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
      cwd: runtime.cwd,
      shell: SHELL,
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
      const inputData = msg.allowFocusReports ? msg.data : stripTerminalFocusReports(msg.data);
      if (!inputData) return;
      if (msg.directTmux) {
        try {
          writeTmuxInput(sessionId, inputData);
        } catch (error) {
          sendWsControl(ws, { type: 'server-error', message: `tmux input failed: ${error.message || error}` });
        }
      } else {
        writeRuntimeInput(runtime, ws, Buffer.from(inputData, 'utf8'));
      }
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
      writeRuntimeInput(runtime, ws, decoded.bytes);
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
