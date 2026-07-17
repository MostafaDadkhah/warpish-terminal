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
const METADATA_FILE = path.join(DATA_DIR, 'sessions.json');
const ZDOTDIR = path.join(DATA_DIR, 'zdotdir');
const EVENTS_DIR = path.join(DATA_DIR, 'events');
const SHELL_INTEGRATION = path.join(__dirname, 'scripts/warpish-shell-integration.zsh');
const MAX_BLOCKS_PER_SESSION = 300;
const MAX_BLOCK_OUTPUT_CHARS = 24000;
const MAX_CAPTURE_CHARS = 500_000;
const MAX_EVENT_READ_BYTES = 1_000_000;
const BLOCK_OUTPUT_FLUSH_MS = 80;
const MAX_WS_BUFFERED_BYTES = 4_000_000;
const TOKEN_FILE = path.resolve(process.env.WARPISH_TOKEN_FILE || path.join(__dirname, '.auth-token'));

const activeBlockIds = new Map();
const pendingBlockOutputs = new Map();
const eventReadStates = new Map();
const sessionRuntimes = new Map();

ensureLocalBindAllowed();
const TOKEN = process.env.WARPISH_TOKEN || readOrCreateToken(TOKEN_FILE);
fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
fs.mkdirSync(EVENTS_DIR, { recursive: true, mode: 0o700 });
try { fs.chmodSync(DATA_DIR, 0o700); } catch {}
try { fs.chmodSync(EVENTS_DIR, 0o700); } catch {}

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

function defaultMetadata() {
  return { sessions: {}, nextIndex: 1 };
}

function normalizeMetadata(meta) {
  if (!meta || typeof meta !== 'object') return defaultMetadata();
  if (!meta.sessions || typeof meta.sessions !== 'object' || Array.isArray(meta.sessions)) meta.sessions = {};
  const nextIndex = Number(meta.nextIndex);
  meta.nextIndex = Number.isFinite(nextIndex) && nextIndex > 0 ? Math.floor(nextIndex) : Object.keys(meta.sessions).length + 1;
  for (const [id, record] of Object.entries(meta.sessions)) {
    if (!record || typeof record !== 'object') {
      delete meta.sessions[id];
      continue;
    }
    record.id = record.id || id;
    if (!Array.isArray(record.blocks)) record.blocks = [];
  }
  return meta;
}

function quarantineCorruptMetadata(error) {
  try {
    if (!fs.existsSync(METADATA_FILE)) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const corruptPath = `${METADATA_FILE}.corrupt-${stamp}`;
    fs.renameSync(METADATA_FILE, corruptPath);
    console.error(`Warpish metadata was corrupt and was moved to ${corruptPath}: ${error.message || error}`);
  } catch (moveError) {
    console.error(`Warpish metadata is corrupt and could not be moved aside: ${moveError.message || moveError}`);
  }
}

function readMetadata() {
  try {
    return normalizeMetadata(JSON.parse(fs.readFileSync(METADATA_FILE, 'utf8')));
  } catch (error) {
    if (error?.code === 'ENOENT') return defaultMetadata();
    quarantineCorruptMetadata(error);
    return defaultMetadata();
  }
}

function writeMetadata(meta) {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const temporaryFile = `${METADATA_FILE}.tmp`;
  fs.writeFileSync(temporaryFile, JSON.stringify(meta, null, 2), { mode: 0o600 });
  fs.chmodSync(temporaryFile, 0o600);
  fs.renameSync(temporaryFile, METADATA_FILE);
}

function runTmux(args, options = {}) {
  const env = { ...process.env };
  delete env.TMUX;
  return execFileSync(TMUX, args, {
    cwd: __dirname,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
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

function warpishShellCommand(sessionId, eventFile) {
  ensureShellIntegration();
  return [
    'env',
    `WARPISH_SESSION_ID=${shellQuote(sessionId)}`,
    `WARPISH_EVENT_FILE=${shellQuote(eventFile)}`,
    'WARPISH_BLOCK_INTEGRATION=1',
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
  return new Date(millis).toISOString();
}

function parseMarkerPayload(payload) {
  const [event, ...parts] = String(payload).split(';');
  const fields = { event };
  for (const part of parts) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    fields[part.slice(0, index)] = part.slice(index + 1);
  }
  return fields;
}

function decodeBase64(value) {
  if (!value) return '';
  try {
    return Buffer.from(value, 'base64').toString('utf8');
  } catch {
    return '';
  }
}

function ensureSessionRecord(meta, sessionId) {
  if (!meta.sessions) meta.sessions = {};
  if (!meta.sessions[sessionId]) {
    meta.sessions[sessionId] = {
      id: sessionId,
      title: sessionId.replace(PREFIX, 'Terminal '),
      cwd: os.homedir(),
      createdAt: new Date().toISOString(),
    };
  }
  if (!Array.isArray(meta.sessions[sessionId].blocks)) meta.sessions[sessionId].blocks = [];
  return meta.sessions[sessionId];
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
  reconcileEventFile(sessionId);
  flushPendingBlockOutput(sessionId);
  const meta = readMetadata();
  const record = meta.sessions?.[sessionId];
  return Array.isArray(record?.blocks) ? record.blocks.map(normalizeBlock).slice().reverse() : [];
}

function upsertBlockStart(sessionId, marker) {
  const id = marker.id || `${sessionId}-${Date.now()}`;
  const pending = pendingBlockOutputs.get(sessionId);
  if (pending && pending.blockId !== id) flushPendingBlockOutput(sessionId);
  const meta = readMetadata();
  const record = ensureSessionRecord(meta, sessionId);
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
  block.command = decodeBase64(marker.command) || block.command || '';
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
  const clean = stripAnsi(text);
  if (!clean.trim()) return null;
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
  if (!pending) pending = { blockId, text: '', timer: null };
  pending.text = `${pending.text}${clean}`.slice(-MAX_BLOCK_OUTPUT_CHARS);
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

  const meta = readMetadata();
  const record = meta.sessions?.[sessionId];
  const block = record?.blocks?.find((candidate) => candidate.id === pending.blockId);
  if (!block || block.status !== 'running' || record?.activeBlockId !== pending.blockId) return null;
  block.output = `${block.output || ''}${pending.text}`.slice(-MAX_BLOCK_OUTPUT_CHARS);
  writeMetadata(meta);
  return normalizeBlock(block);
}

function finishBlock(sessionId, marker) {
  flushPendingBlockOutput(sessionId, marker.id || null);
  const meta = readMetadata();
  const record = meta.sessions?.[sessionId];
  if (!record || !Array.isArray(record.blocks)) return null;
  const id = marker.id || record.activeBlockId;
  const block = record.blocks.find((candidate) => candidate.id === id);
  if (!block) return null;
  if (block.status !== 'running' && block.endedAt) {
    if (activeBlockIds.get(sessionId) === id) activeBlockIds.delete(sessionId);
    return normalizeBlock(block);
  }
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

function handleBlockMarker(sessionId, payload) {
  const marker = parseMarkerPayload(payload);
  if (marker.event === 'Start') return { type: 'block-start', block: upsertBlockStart(sessionId, marker) };
  if (marker.event === 'End') {
    const block = enrichFinishedBlockOutput(sessionId, finishBlock(sessionId, marker));
    return { type: 'block-end', block };
  }
  return null;
}

function eventFileForSession(sessionId) {
  const meta = readMetadata();
  return meta.sessions?.[sessionId]?.eventFile || path.join(EVENTS_DIR, `${sessionId}.events`);
}

function reconcileEventFile(sessionId, onBlockEvent = () => {}) {
  const file = eventFileForSession(sessionId);
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return;
  }

  let state = eventReadStates.get(sessionId) || { ino: stat.ino, offset: 0, remainder: '' };
  if (state.ino !== stat.ino || stat.size < state.offset) {
    state = { ino: stat.ino, offset: 0, remainder: '' };
  }
  if (stat.size === state.offset) {
    eventReadStates.set(sessionId, state);
    return;
  }

  let start = state.offset;
  let discardPartialFirstLine = false;
  if (start === 0 && stat.size > MAX_EVENT_READ_BYTES) {
    start = stat.size - MAX_EVENT_READ_BYTES;
    discardPartialFirstLine = true;
  }

  const length = stat.size - start;
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, buffer, 0, length, start);
  } finally {
    fs.closeSync(fd);
  }
  state.ino = stat.ino;
  state.offset = stat.size;
  let text = state.remainder + buffer.toString('utf8');
  if (discardPartialFirstLine) {
    const firstNewline = text.indexOf('\n');
    text = firstNewline === -1 ? '' : text.slice(firstNewline + 1);
  }
  const lines = text.split('\n');
  state.remainder = lines.pop() || '';
  eventReadStates.set(sessionId, state);

  for (const line of lines) {
    if (!line.trim()) continue;
    const event = handleBlockMarker(sessionId, line.trim());
    if (event?.block) onBlockEvent(event);
  }
}

function createEventReader(sessionId, onBlockEvent) {
  return {
    poll() {
      reconcileEventFile(sessionId, onBlockEvent);
    },
  };
}

function inferOutputFromPane(sessionId, command) {
  if (!command) return '';
  let text = '';
  try {
    text = runTmux(['capture-pane', '-p', '-t', sessionId, '-S', '-160']);
  } catch {
    return '';
  }
  const lines = text.split('\n').map((line) => line.trimEnd());
  let commandLineIndex = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].includes(command)) {
      commandLineIndex = i;
      break;
    }
  }
  const slice = commandLineIndex >= 0 ? lines.slice(commandLineIndex + 1) : lines.slice(-24);
  const outputLines = [];
  for (const line of slice) {
    if (/^[^\s]+@[^\s]+\s+.*\s[%#]\s*$/.test(line) && outputLines.length > 0) break;
    outputLines.push(line);
  }
  return outputLines
    .filter((line) => !/^\s*$/.test(line))
    .filter((line) => !line.includes('\x1b]697;'))
    .join('\n')
    .slice(-MAX_BLOCK_OUTPUT_CHARS);
}

function enrichFinishedBlockOutput(sessionId, block) {
  if (!block || (block.output || '').trim()) return block;
  const inferred = inferOutputFromPane(sessionId, block.command || '');
  if (!inferred.trim()) return block;
  const meta = readMetadata();
  const record = meta.sessions?.[sessionId];
  const stored = record?.blocks?.find((candidate) => candidate.id === block.id);
  if (!stored) return block;
  stored.output = inferred;
  writeMetadata(meta);
  return normalizeBlock(stored);
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
    const safeText = stripTerminalFocusModeControls(stripped);
    if (!safeText) return;
    if (shouldRecordOutput()) appendBlockOutput(sessionId, safeText);
    onTerminalData(Buffer.from(safeText, 'utf8'));
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
        return;
      }

      const payload = buffer.slice(start + markerPrefix.length, end);
      buffer = buffer.slice(end + 1);
      if (buffer.startsWith('\x1b\\')) buffer = buffer.slice(2);
      const event = handleBlockMarker(sessionId, payload);
      if (event?.block) onBlockEvent(event);
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

function capturePaneText(id, { lines = 600, alternate = false, escape = false } = {}) {
  const args = ['capture-pane', '-p', '-J'];
  if (escape) args.push('-e');
  if (alternate) args.push('-a');
  else args.push('-S', `-${Math.max(20, Math.min(Number(lines) || 600, 5000))}`);
  args.push('-t', id);
  try {
    return runTmux(args)
      .split('\n')
      .map((line) => line.trimEnd())
      .join('\n')
      .trimEnd();
  } catch {
    return '';
  }
}

function captureContentLines(text) {
  return stripAnsi(text)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function alternateCaptureIsNormalTail(normal, alternate) {
  const alternateLines = captureContentLines(alternate)
    .filter((line) => !/^[~│╭╰╮╯─\s]+$/u.test(line))
    .slice(-12);
  if (!alternateLines.length) return false;
  const normalClean = captureContentLines(normal).join('\n');
  return alternateLines.filter((line) => normalClean.includes(line)).length / alternateLines.length >= 0.75;
}

function alternateCaptureLooksStandaloneTui(alternate) {
  const lines = captureContentLines(alternate);
  const joined = lines.join('\n');
  const vimTildeLines = lines.filter((line) => /^~\s*$/u.test(line)).length;
  return vimTildeLines >= 3
    || /--\s*(?:INSERT|NORMAL|VISUAL|REPLACE)\s*--/u.test(joined)
    || /\b(?:VIM - Vi IMproved|GNU nano|less\s+\d|htop|top -)\b/iu.test(joined)
    || /\(END\)(?:\s|$)/mu.test(joined);
}

function captureLooksLikeAgentScrollback(normal) {
  return /Hermes Agent|⚕|\bctx --\b|❯|\bgpt-[\w.]+\b/u.test(stripAnsi(normal));
}

function choosePaneCapture({ normal = '', alternate = '' } = {}) {
  if (!alternate.trim()) return { text: normal, usingAlternate: false, reason: 'normal-only' };
  if (!normal.trim()) return { text: alternate, usingAlternate: true, reason: 'alternate-only' };

  const normalLines = captureContentLines(normal).length;
  const alternateLines = captureContentLines(alternate).length;
  const normalHasHistory = normalLines >= Math.max(alternateLines + 20, alternateLines * 2);
  const alternateLooksTui = alternateCaptureLooksStandaloneTui(alternate);
  const alternateLooksLikeNormalTail = alternateCaptureIsNormalTail(normal, alternate);
  const normalLooksLikeAgentScrollback = captureLooksLikeAgentScrollback(normal);

  const agentScrollbackIsMuchRicher = normalLooksLikeAgentScrollback
    && alternateLines <= 60
    && normalLines >= Math.max(alternateLines + 120, alternateLines * 6);

  // In Hermes/prompt-toolkit-like panes tmux can expose a tiny alternate capture that is
  // only a stale/current viewport, while the normal capture contains the real scrollback.
  // Prefer the richer normal capture when it is the same tail or a recognizable, much
  // richer agent scrollback; keep true editor/TUI alternate screens (vim, less, htop,
  // unknown full-screen apps with meaningful alternate content, etc.) intact.
  if (normalHasHistory && !alternateLooksTui && (alternateLooksLikeNormalTail || agentScrollbackIsMuchRicher)) {
    return { text: normal, usingAlternate: false, reason: 'normal-rich-history' };
  }

  return { text: alternate, usingAlternate: true, reason: 'alternate-active' };
}

function summarizeSessions() {
  const meta = readMetadata();
  const activeResult = listActiveTmuxSessions();
  const active = activeResult.sessions;
  let changed = false;

  for (const [id, tmuxInfo] of activeResult.ok ? active.entries() : []) {
    if (!meta.sessions[id]) {
      meta.sessions[id] = {
        id,
        title: id.replace(PREFIX, 'Terminal '),
        cwd: os.homedir(),
        createdAt: new Date(tmuxInfo.createdAt || Date.now()).toISOString(),
      };
      changed = true;
    }
    const preview = capturePreview(id);
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
        preview: tmuxInfo ? (capturePreview(record.id) || record.lastPreview || '') : (record.lastPreview || ''),
      };
    })
    .sort((a, b) => {
      if (a.alive !== b.alive) return a.alive ? -1 : 1;
      return new Date(b.lastOpenedAt || b.createdAt || 0) - new Date(a.lastOpenedAt || a.createdAt || 0);
    });
}

function createSession({ title, cwd } = {}) {
  const meta = readMetadata();
  const now = new Date();
  const index = meta.nextIndex || Object.keys(meta.sessions).length + 1;
  const id = `${PREFIX}${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
  const resolvedCwd = path.resolve(cwd || os.homedir());
  let safeCwd = os.homedir();
  try {
    if (fs.statSync(resolvedCwd).isDirectory()) safeCwd = resolvedCwd;
  } catch {}
  const sessionTitle = String(title || `Terminal ${index}`).trim().slice(0, 80) || `Terminal ${index}`;
  const eventFile = path.join(EVENTS_DIR, `${id}.events`);
  let tmuxCreated = false;
  let metadataWritten = false;

  try {
    fs.writeFileSync(eventFile, '', { mode: 0o600 });
    runTmux(['new-session', '-d', '-s', id, '-c', safeCwd, warpishShellCommand(id, eventFile)]);
    tmuxCreated = true;
    runTmux(['set-option', '-t', id, 'status', 'off']);
    runTmux(['set-option', '-t', id, 'history-limit', '50000']);
    runTmux(['set-option', '-t', id, 'allow-rename', 'off']);
    runTmux(['set-option', '-t', id, 'allow-passthrough', 'on']);
    runTmux(['set-environment', '-t', id, 'WARPISH_SESSION_ID', id]);
    runTmux(['set-environment', '-t', id, 'WARPISH_EVENT_FILE', eventFile]);
    runTmux(['set-environment', '-t', id, 'WARPISH_BLOCK_INTEGRATION', '1']);
    runTmux(['set-environment', '-t', id, 'ZDOTDIR', ZDOTDIR]);

    meta.nextIndex = index + 1;
    meta.sessions[id] = {
      id,
      title: sessionTitle,
      cwd: safeCwd,
      createdAt: now.toISOString(),
      lastOpenedAt: now.toISOString(),
      eventFile,
      blocks: [],
    };
    writeMetadata(meta);
    metadataWritten = true;
    ensureSessionRuntime({ id, cwd: safeCwd }, { cols: 120, rows: 36 });
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
    try { fs.unlinkSync(eventFile); } catch {}
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
  meta.sessions[id].title = String(title || '').trim().slice(0, 80) || meta.sessions[id].title;
  writeMetadata(meta);
  return summarizeSessions().find((session) => session.id === id) || null;
}

function clearSessionTransientState(id) {
  const pending = pendingBlockOutputs.get(id);
  if (pending?.timer) clearTimeout(pending.timer);
  pendingBlockOutputs.delete(id);
  activeBlockIds.delete(id);
  eventReadStates.delete(id);
}

function killSession(id) {
  flushPendingBlockOutput(id);
  const meta = readMetadata();
  let preview = '';
  if (meta.sessions[id]) {
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
    if (preview) meta.sessions[id].lastPreview = preview;
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
  if (record.eventFile) {
    try { fs.unlinkSync(record.eventFile); } catch {}
  }
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

  for (const [id, record] of Object.entries(meta.sessions || {})) {
    if (active.has(id)) continue;
    purged.push(id);
    delete meta.sessions[id];
    if (record.eventFile) {
      try { fs.unlinkSync(record.eventFile); } catch {}
    }
    clearSessionTransientState(id);
  }

  if (purged.length) writeMetadata(meta);
  return purged;
}

function writeWorker(worker, message) {
  if (!worker?.stdin || worker.stdin.destroyed || !worker.stdin.writable) return false;
  try {
    worker.stdin.write(`${JSON.stringify(message)}\n`);
    return true;
  } catch {
    return false;
  }
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

function createPtyWorker({ sessionId, cwd, cols, rows }) {
  const workerPath = path.join(__dirname, 'scripts/pty-worker.py');
  const env = {
    ...process.env,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    WARPISH_TERMINAL: '1',
  };
  delete env.TMUX;
  return spawn(PYTHON, [
    workerPath,
    '--shell', SHELL,
    '--cwd', cwd,
    '--cols', String(cols),
    '--rows', String(rows),
    '--tmux-bin', TMUX,
    '--tmux-session', sessionId,
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
  add('pty-worker-present', fs.existsSync(path.join(__dirname, 'scripts/pty-worker.py')), 'scripts/pty-worker.py');
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
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/sessions/:id/blocks', (req, res) => {
  const { id } = req.params;
  if (!isValidSessionId(id)) return res.status(400).json({ error: 'invalid session id' });
  res.json({ blocks: getBlocks(id) });
});

app.get('/api/sessions/:id/capture', (req, res) => {
  const { id } = req.params;
  if (!isValidSessionId(id)) return res.status(400).json({ error: 'invalid session id' });
  const lines = clampNumber(req.query.lines, 600, 20, 5000);
  const escape = req.query.ansi === '1' || req.query.escape === '1';
  const normal = capturePaneText(id, { lines, escape });
  const alternate = capturePaneText(id, { alternate: true, escape });
  const selected = choosePaneCapture({ normal, alternate });
  res.json({
    text: limitText(selected.text),
    normal: limitText(normal),
    alternate: limitText(alternate),
    usingAlternate: selected.usingAlternate,
    captureReason: selected.reason,
    ansi: escape,
  });
});

app.patch('/api/sessions/:id', (req, res) => {
  const { id } = req.params;
  if (!isValidSessionId(id)) return res.status(400).json({ error: 'invalid session id' });
  const session = renameSession(id, req.body?.title);
  if (!session) return res.status(404).json({ error: 'session not found' });
  res.json({ session, sessions: summarizeSessions() });
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
const wss = new WebSocketServer({ noServer: true });

function sendWsControl(ws, message) {
  if (ws.readyState !== ws.OPEN) return false;
  try {
    ws.send(JSON.stringify(message));
    return true;
  } catch {
    return false;
  }
}

function broadcastRuntimeControl(runtime, message) {
  for (const ws of runtime.subscribers) sendWsControl(ws, message);
}

function broadcastRuntimeData(runtime, bytes) {
  for (const ws of runtime.subscribers) {
    if (ws.readyState !== ws.OPEN) continue;
    if (ws.bufferedAmount > MAX_WS_BUFFERED_BYTES) {
      sendWsControl(ws, { type: 'server-error', message: 'Terminal client fell too far behind; reconnect to resume.' });
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

function terminateSessionRuntime(runtime) {
  if (!runtime || runtime.closed || runtime.stopping) return;
  runtime.stopping = true;
  writeWorker(runtime.worker, { type: 'kill' });
  runtime.forceKillTimer = setTimeout(() => {
    if (runtime.worker.exitCode === null && runtime.worker.signalCode === null) {
      try { runtime.worker.kill('SIGTERM'); } catch {}
    }
  }, 500);
  runtime.forceKillTimer.unref?.();
}

function closeRuntimeSubscribers(runtime, message) {
  for (const ws of [...runtime.subscribers]) {
    if (message) sendWsControl(ws, message);
    try { ws.close(); } catch {}
  }
}

function createSessionRuntime(session, { cols = 120, rows = 36 } = {}) {
  reconcileEventFile(session.id);
  const worker = createPtyWorker({
    sessionId: session.id,
    cwd: session.cwd || os.homedir(),
    cols,
    rows,
  });
  const runtime = {
    sessionId: session.id,
    cwd: session.cwd || os.homedir(),
    worker,
    workerPid: null,
    subscribers: new Set(),
    stdoutBuffer: '',
    stderrBuffer: '',
    forceKillTimer: null,
    stopping: false,
    closed: false,
    lastExitMessage: null,
  };
  sessionRuntimes.set(session.id, runtime);

  runtime.outputProcessor = createOutputProcessor(session.id, {
    shouldRecordOutput() {
      return sessionRuntimes.get(runtime.sessionId) === runtime;
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
  const normal = capturePaneText(sessionId, { lines: 1200, escape: true });
  const alternate = capturePaneText(sessionId, { alternate: true, escape: true });
  const selected = choosePaneCapture({ normal, alternate });
  if (!selected.text) return;
  const snapshot = `\x1b[2J\x1b[H${selected.text.replace(/\n/g, '\r\n')}`;
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

  touchSession(sessionId);
  const cols = clampNumber(url.searchParams.get('cols'), 120, 20, 300);
  const rows = clampNumber(url.searchParams.get('rows'), 36, 5, 120);
  const { runtime, created } = ensureSessionRuntime(session, { cols, rows });
  runtime.subscribers.add(ws);
  writeWorker(runtime.worker, { type: 'resize', cols, rows });
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
    if (isBinary) return;
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      const rawInputData = stripTerminalFocusReports(String(raw));
      if (rawInputData) writeWorker(runtime.worker, { type: 'input', data: Buffer.from(rawInputData, 'utf8').toString('base64') });
      return;
    }

    if (msg.type === 'input' && typeof msg.data === 'string') {
      const inputData = msg.allowFocusReports ? msg.data : stripTerminalFocusReports(msg.data);
      if (!inputData) return;
      if (msg.directTmux) {
        try {
          writeTmuxInput(sessionId, inputData);
        } catch (error) {
          sendWsControl(ws, { type: 'server-error', message: `tmux input failed: ${error.message || error}` });
        }
      } else {
        writeWorker(runtime.worker, { type: 'input', data: Buffer.from(inputData, 'utf8').toString('base64') });
      }
    } else if (msg.type === 'resize') {
      writeWorker(runtime.worker, {
        type: 'resize',
        cols: clampNumber(msg.cols, 120, 20, 300),
        rows: clampNumber(msg.rows, 36, 5, 120),
      });
    } else if (msg.type === 'detach') {
      ws.close(1000, 'detached');
    }
  });

  ws.on('close', () => {
    runtime.subscribers.delete(ws);
  });
});

let shuttingDown = false;
function shutdownServer(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
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
