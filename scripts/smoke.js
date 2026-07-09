import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import WebSocket from 'ws';

const port = Number(process.env.PORT || 8876);
const projectRoot = new URL('..', import.meta.url).pathname;
const smokeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'warpish-smoke-'));
const smokeDataDir = path.join(smokeRoot, 'data');
const smokeTokenFile = path.join(smokeRoot, 'token');
const smokePrefix = `warpishsmoke-${process.pid.toString(36)}-`;
const child = spawn(process.execPath, ['server.js'], {
  cwd: projectRoot,
  env: {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    WARPISH_DATA_DIR: smokeDataDir,
    WARPISH_TOKEN_FILE: smokeTokenFile,
    WARPISH_SESSION_PREFIX: smokePrefix,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let stdout = '';
let stderr = '';
let tokenUrl;
let smokeSessionId;
let stoppedCleanupSessionId;

child.stdout.on('data', (chunk) => {
  stdout += chunk.toString();
  const match = stdout.match(/URL: (http:\/\/[^\s]+)/);
  if (match) tokenUrl = match[1];
});
child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function waitForServer() {
  for (let i = 0; i < 100; i += 1) {
    if (tokenUrl) return;
    await delay(100);
  }
  throw new Error(`server did not print URL. stdout=${stdout} stderr=${stderr}`);
}

function httpJson(pathname, { method = 'GET', token, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: pathname,
      method,
      headers: {
        ...(token ? { 'x-warpish-token': token } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
    }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode}: ${text}`));
          return;
        }
        resolve(text ? JSON.parse(text) : {});
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function httpText(pathname, { token } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: pathname,
      method: 'GET',
      headers: token ? { 'x-warpish-token': token } : {},
    }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode}: ${text}`));
          return;
        }
        resolve(text);
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function wsUntilMarker({ token, sessionId, sendCommand, markerRegex, directTmux = false }) {
  const wsUrl = new URL('/ws', tokenUrl);
  wsUrl.protocol = 'ws:';
  wsUrl.searchParams.set('token', token);
  wsUrl.searchParams.set('sessionId', sessionId);
  wsUrl.searchParams.set('cols', '100');
  wsUrl.searchParams.set('rows', '30');

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let output = '';
    const timer = setTimeout(() => reject(new Error(`timeout waiting for PTY marker. output=${JSON.stringify(output.slice(-800))}`)), 10000);

    ws.on('open', () => {
      if (sendCommand) {
        setTimeout(() => ws.send(JSON.stringify({ type: 'input', data: sendCommand, directTmux })), 500);
      }
    });

    ws.on('message', (raw, isBinary) => {
      if (isBinary) {
        output += Buffer.from(raw).toString('utf8');
        if (markerRegex.test(output)) {
          clearTimeout(timer);
          ws.close();
          resolve(output);
        }
        return;
      }

      const msg = JSON.parse(String(raw));
      if (msg.type === 'server-error') reject(new Error(msg.message));
    });
    ws.on('error', reject);
  });
}

async function waitForBlock({ token, sessionId, commandNeedle, outputNeedle }) {
  for (let i = 0; i < 160; i += 1) {
    const payload = await httpJson(`/api/sessions/${sessionId}/blocks`, { token });
    const block = (payload.blocks || []).find((candidate) => candidate.command?.includes(commandNeedle));
    if (block && block.status !== 'running' && (!outputNeedle || block.output?.includes(outputNeedle))) {
      return block;
    }
    await delay(250);
  }
  const payload = await httpJson(`/api/sessions/${sessionId}/blocks`, { token });
  throw new Error(`block not found/complete. blocks=${JSON.stringify(payload.blocks || [])}`);
}

try {
  await waitForServer();
  const parsed = new URL(tokenUrl);
  const token = parsed.searchParams.get('token');
  const health = await httpJson('/healthz');
  const indexHtml = await httpText('/', { token });
  const appJs = await httpText('/app.js', { token });
  const stylesCss = await httpText('/styles.css', { token });
  const serverJs = fs.readFileSync(path.join(projectRoot, 'server.js'), 'utf8');
  const terminalNativeUiVerified = !indexHtml.includes('terminal-input-mask')
    && !indexHtml.includes('composerToggle')
    && indexHtml.includes('clearStoppedSessions')
    && indexHtml.includes('blocksToggle')
    && indexHtml.includes('Readable: on')
    && appJs.includes('terminal-native-mode')
    && appJs.includes('warpish_readable_terminal_v1')
    && appJs.includes('warpish_blocks_open')
    && appJs.includes('function handleTerminalInput(data)')
    && appJs.includes('sendRaw(data)')
    && appJs.includes('directTmux')
    && appJs.includes('function handleReadableTerminalKeydown(event)')
    && appJs.includes('function looksLikePromptOnly(text =')
    && appJs.includes('XTERM_COLOR_MODE_PALETTE')
    && appJs.includes('function getLineStyledSegments(line, text)')
    && appJs.includes('function applyTextStyle(element, style = {})')
    && appJs.includes('function parseAnsiCaptureEntries(text =')
    && appJs.includes('function applyAnsiSgr(style, rawCodes =')
    && appJs.includes('capture?lines=1200&ansi=1')
    && serverJs.includes('escape = req.query.ansi')
    && serverJs.includes("args.push('-e')")
    && serverJs.includes('function writeTmuxInput(sessionId, data)')
    && serverJs.includes("['\\x1b[A', 'Up']")
    && !appJs.includes('warpish_composer_open')
    && !appJs.includes('shouldAutoOpenRtlComposer')
    && !appJs.includes('openComposerCapture')
    && !appJs.includes('commandInputDirection')
    && appJs.includes('function shouldPreserveControlFocus(event)')
    && appJs.includes('function focusTerminalReliably()')
    && appJs.includes("terminalCard?.addEventListener('pointerdown'")
    && appJs.includes('function handleBidiReaderWheel(event)')
    && appJs.includes('refreshBidiReaderForScroll(event.deltaY)')
    && appJs.includes('function getReadableTerminalEntries(limit = BIDI_READER_MAX_LINES)')
    && appJs.includes("ghost.className = 'bidi-ghost'")
    && appJs.includes("cursor.className = 'bidi-inline-cursor'")
    && appJs.includes('BIDI_READER_RENDER_INTERVAL_MS')
    && appJs.includes('BIDI_CAPTURE_REFRESH_INTERVAL_MS')
    && appJs.includes('function isTerminalAlternateBuffer()')
    && appJs.includes('function setBidiReaderHasContent(hasContent)')
    && appJs.includes('lastCapturedReaderEntries')
    && appJs.includes('function refreshReadableFromTmuxSoon')
    && appJs.includes('preferCapture = false')
    && appJs.includes('preferCapture\n        || !xtermHasText')
    && appJs.includes('refreshBidiReaderFromCapture({ keepScroll: true, preferCapture: true })')
    && !appJs.includes('renderBidiReader(entries.length ? entries : fallbackEntries')
    && appJs.includes('function splitPromptRtlSuffix(value =')
    && appJs.includes("segment.className = 'bidi-segment rtl'")
    && appJs.includes('function appendBidiRunWithBoundarySpace(element, text, dir)')
    && appJs.includes('pendingText += token')
    && appJs.includes('element.dir = sourceDir')
    && appJs.includes('run.dir = dir')
    && appJs.includes('row.dataset.logicalText')
    && stylesCss.includes('.bidi-segment.rtl')
    && stylesCss.includes('.bidi-ghost')
    && stylesCss.includes('.bidi-inline-cursor')
    && stylesCss.includes('.bidi-style-run')
    && stylesCss.includes('--reader-fg')
    && stylesCss.includes('pointer-events: auto')
    && stylesCss.includes('overscroll-behavior: contain')
    && stylesCss.includes('body.bidi-mode.bidi-reader-has-content #terminal .xterm-screen')
    && stylesCss.includes('body.bidi-mode:not(.bidi-reader-has-content) .bidi-reader')
    && stylesCss.includes('opacity: 0')
    && stylesCss.includes('display: inline-block')
    && stylesCss.includes('.bidi-line.rtl')
    && stylesCss.includes('direction: rtl')
    && stylesCss.includes('text-align: right')
    && stylesCss.includes('#terminal .xterm-rows > div')
    && stylesCss.includes("content: '▌'")
    && stylesCss.includes('unicode-bidi: plaintext')
    && appJs.includes('scrollLines')
    && appJs.includes('BLOCK_OUTPUT_PREVIEW_CHARS')
    && !appJs.includes('isAlternateBufferActive');
  if (!terminalNativeUiVerified) {
    throw new Error('terminal-native raw/default-readable UI source verification failed');
  }
  const created = await httpJson('/api/sessions', {
    method: 'POST',
    token,
    body: { title: 'Smoke resume session' },
  });
  smokeSessionId = created.session.id;

  const markerRegex = /__WARPISH_SMOKE__:[^$:\r\n]+:\/Users\/[^\r\n]+/;
  await wsUntilMarker({
    token,
    sessionId: smokeSessionId,
    sendCommand: 'echo __WARPISH_SMOKE__:$USER:$PWD\r',
    markerRegex,
  });

  await delay(700);
  const resumedOutput = await wsUntilMarker({
    token,
    sessionId: smokeSessionId,
    sendCommand: '',
    markerRegex,
  });
  const marker = resumedOutput.match(markerRegex)?.[0] || 'marker-found';
  const directTmuxText = '__WARPISH_DIRECT_TMUX__';
  await wsUntilMarker({
    token,
    sessionId: smokeSessionId,
    sendCommand: `echo ${directTmuxText}\r`,
    markerRegex: new RegExp(directTmuxText),
    directTmux: true,
  });
  const block = await waitForBlock({
    token,
    sessionId: smokeSessionId,
    commandNeedle: 'echo __WARPISH_SMOKE__',
    outputNeedle: '__WARPISH_SMOKE__',
  });

  const escapeForRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const bidiText = 'سلام Mostafa، command: git status و path: /Users/test خواناست';
  const bidiCommand = `echo ${JSON.stringify(bidiText)}`;
  const bidiRegex = new RegExp(escapeForRegex(bidiText));
  await wsUntilMarker({
    token,
    sessionId: smokeSessionId,
    sendCommand: `${bidiCommand}\r`,
    markerRegex: bidiRegex,
  });
  const bidiBlock = await waitForBlock({
    token,
    sessionId: smokeSessionId,
    commandNeedle: 'echo',
    outputNeedle: bidiText,
  });

  const stoppedCreated = await httpJson('/api/sessions', {
    method: 'POST',
    token,
    body: { title: 'Stopped cleanup smoke' },
  });
  stoppedCleanupSessionId = stoppedCreated.session.id;
  await httpJson(`/api/sessions/${stoppedCleanupSessionId}`, { method: 'DELETE', token });
  const beforeCleanup = await httpJson('/api/sessions', { token });
  const stoppedBeforeCleanup = beforeCleanup.sessions.find((session) => session.id === stoppedCleanupSessionId);
  if (!stoppedBeforeCleanup || stoppedBeforeCleanup.alive) {
    throw new Error(`stopped cleanup fixture was not stopped. sessions=${JSON.stringify(beforeCleanup.sessions)}`);
  }
  const cleanupPayload = await httpJson('/api/sessions?stopped=1', { method: 'DELETE', token });
  const liveAfterCleanup = cleanupPayload.sessions.find((session) => session.id === smokeSessionId);
  const stoppedAfterCleanup = cleanupPayload.sessions.find((session) => session.id === stoppedCleanupSessionId);
  const stoppedCleanupVerified = Boolean(cleanupPayload.purged?.includes(stoppedCleanupSessionId))
    && Boolean(liveAfterCleanup?.alive)
    && !stoppedAfterCleanup;
  if (!stoppedCleanupVerified) {
    throw new Error(`stopped cleanup failed. payload=${JSON.stringify(cleanupPayload)}`);
  }

  const listed = await httpJson('/api/sessions', { token });
  const listedSession = listed.sessions.find((session) => session.id === smokeSessionId);

  console.log(JSON.stringify({
    ok: true,
    health,
    createdSession: smokeSessionId,
    resumeVerified: Boolean(listedSession?.alive),
    sidebarPreviewHasMarker: Boolean(listedSession?.preview?.includes('__WARPISH_SMOKE__')),
    terminalNativeUiVerified,
    directTmuxInputVerified: true,
    blockVerified: block.status === 'success' && block.output.includes('__WARPISH_SMOKE__'),
    blockCommand: block.command,
    blockStatus: block.status,
    bidiBlockVerified: bidiBlock.status === 'success' && bidiBlock.output.includes(bidiText),
    bidiBlockOutput: bidiBlock.output,
    stoppedCleanupVerified,
    stoppedCleanupPurged: cleanupPayload.purged,
    isolatedRuntime: {
      dataDir: smokeDataDir,
      sessionPrefix: smokePrefix,
    },
    marker,
  }, null, 2));
} finally {
  try {
    if (tokenUrl) {
      const token = new URL(tokenUrl).searchParams.get('token');
      if (smokeSessionId) await httpJson(`/api/sessions/${smokeSessionId}?purge=1`, { method: 'DELETE', token });
      if (stoppedCleanupSessionId) await httpJson(`/api/sessions/${stoppedCleanupSessionId}?purge=1`, { method: 'DELETE', token });
    }
  } catch {}
  child.kill('SIGTERM');
  try { fs.rmSync(smokeRoot, { recursive: true, force: true }); } catch {}
}
