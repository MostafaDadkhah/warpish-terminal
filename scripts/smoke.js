import { spawn } from 'node:child_process';
import http from 'node:http';
import process from 'node:process';
import WebSocket from 'ws';

const port = Number(process.env.PORT || 8876);
const child = spawn(process.execPath, ['server.js'], {
  cwd: new URL('..', import.meta.url).pathname,
  env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let stdout = '';
let stderr = '';
let tokenUrl;
let smokeSessionId;

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

async function wsUntilMarker({ token, sessionId, sendCommand, markerRegex }) {
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
        setTimeout(() => ws.send(JSON.stringify({ type: 'input', data: sendCommand })), 500);
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
  const terminalFirstUiVerified = indexHtml.includes('passthroughToggle')
    && indexHtml.includes('inputModeHint')
    && appJs.includes('terminal-first-mode')
    && appJs.includes('Raw passthrough')
    && !appJs.includes('isAlternateBufferActive');
  if (!terminalFirstUiVerified) {
    throw new Error('terminal-first/raw-passthrough UI source verification failed');
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

  const listed = await httpJson('/api/sessions', { token });
  const listedSession = listed.sessions.find((session) => session.id === smokeSessionId);

  console.log(JSON.stringify({
    ok: true,
    health,
    createdSession: smokeSessionId,
    resumeVerified: Boolean(listedSession?.alive),
    sidebarPreviewHasMarker: Boolean(listedSession?.preview?.includes('__WARPISH_SMOKE__')),
    terminalFirstUiVerified,
    blockVerified: block.status === 'success' && block.output.includes('__WARPISH_SMOKE__'),
    blockCommand: block.command,
    blockStatus: block.status,
    bidiBlockVerified: bidiBlock.status === 'success' && bidiBlock.output.includes(bidiText),
    bidiBlockOutput: bidiBlock.output,
    marker,
  }, null, 2));
} finally {
  try {
    if (tokenUrl && smokeSessionId) {
      const token = new URL(tokenUrl).searchParams.get('token');
      await httpJson(`/api/sessions/${smokeSessionId}`, { method: 'DELETE', token });
    }
  } catch {}
  child.kill('SIGTERM');
}
