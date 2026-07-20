import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const port = process.env.PORT ? Number(process.env.PORT) : await freePort();
const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const smokeRoot = fs.mkdtempSync(path.join('/tmp', 'warpish-smoke-'));
const smokeDataDir = path.join(smokeRoot, 'data');
const smokeTokenFile = path.join(smokeRoot, 'token');
const smokeTmuxDir = path.join(smokeRoot, 'tmux');
fs.mkdirSync(smokeTmuxDir, { recursive: true, mode: 0o700 });
const smokePrefix = `warpishsmoke-${process.pid.toString(36)}-`;
const tmuxFormatSeparator = '|';
const tmuxBin = process.env.TMUX_BIN
  || ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux'].find((candidate) => fs.existsSync(candidate))
  || 'tmux';

function isolatedTmuxEnvironment(extra = {}) {
  const env = { ...process.env, ...extra, TMUX_TMPDIR: smokeTmuxDir };
  delete env.TMUX;
  delete env.TMUX_PANE;
  return env;
}

function launchdLikeServerEnvironment(extra = {}) {
  const env = isolatedTmuxEnvironment(extra);
  delete env.LANG;
  for (const key of Object.keys(env)) {
    if (key.startsWith('LC_')) delete env[key];
  }
  return env;
}

function paneHistoryState(sessionId) {
  const output = execFileSync(tmuxBin, [
    'list-panes', '-s', '-t', sessionId, '-F', [
      '#{pane_id}',
      '#{history_limit}',
      '#{history_size}',
    ].join(tmuxFormatSeparator),
  ], { encoding: 'utf8', env: isolatedTmuxEnvironment() });
  return output.trim().split('\n').filter(Boolean).map((line) => {
    const [paneId, limit, size] = line.split(tmuxFormatSeparator);
    return { paneId, limit: Number(limit), size: Number(size) };
  });
}

let child;
let stdout = '';
let stderr = '';
let tokenUrl;
let smokeSessionId;
let stoppedCleanupSessionId;
let quarantinedSessionId;

function startServerProcess() {
  stdout = '';
  stderr = '';
  tokenUrl = undefined;
  const serverProcess = spawn(process.execPath, ['server.js'], {
    cwd: projectRoot,
    // A user LaunchAgent commonly has no LANG/LC_* variables. Keep the full
    // smoke suite in that environment so tmux list parsing cannot regress.
    env: launchdLikeServerEnvironment({
      PORT: String(port),
      HOST: '127.0.0.1',
      WARPISH_DATA_DIR: smokeDataDir,
      WARPISH_TOKEN_FILE: smokeTokenFile,
      WARPISH_SESSION_PREFIX: smokePrefix,
      WARPISH_SKIP_USER_ZSHRC: '1',
      TMUX_TMPDIR: smokeTmuxDir,
      TERM: 'dumb',
      NO_COLOR: '1',
      COLORTERM: '',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProcess.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
    const match = stdout.match(/URL: (http:\/\/[^\s]+)/);
    if (match) tokenUrl = match[1];
  });
  serverProcess.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  child = serverProcess;
  return serverProcess;
}

startServerProcess();

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      srv.close(() => resolve(address.port));
    });
    srv.on('error', reject);
  });
}

async function waitForServer() {
  for (let i = 0; i < 100; i += 1) {
    if (tokenUrl) return;
    await delay(100);
  }
  throw new Error(`server did not print URL. stdout=${stdout} stderr=${stderr}`);
}

async function waitForSessionPreview({ token, sessionId, needle }) {
  let lastSession = null;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const payload = await httpJson('/api/sessions', { token });
    lastSession = payload.sessions?.find((session) => session.id === sessionId) || null;
    if (lastSession?.preview?.includes(needle)) return lastSession;
    await delay(100);
  }
  throw new Error(`session preview did not contain ${needle}. session=${JSON.stringify(lastSession)}`);
}

function httpResponse(pathname, {
  method = 'GET', token, body, headers = {}, timeoutMs = 5000,
} = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: pathname,
      method,
      headers: {
        ...(token ? { 'x-warpish-token': token } : {}),
        ...(payload ? {
          'content-type': 'application/json',
          'content-length': String(payload.length),
        } : {}),
        ...headers,
      },
    }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        resolve({ status: res.statusCode || 0, headers: res.headers, text });
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`${method} ${pathname} timed out after ${timeoutMs}ms`)));
    if (payload) req.write(payload);
    req.end();
  });
}

function expectHttpOk(response, label) {
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`${label} -> HTTP ${response.status}: ${response.text}`);
  }
  return response;
}

async function httpJson(pathname, options = {}) {
  const response = expectHttpOk(await httpResponse(pathname, options), `${options.method || 'GET'} ${pathname}`);
  if (!response.text) return {};
  try {
    return JSON.parse(response.text);
  } catch (error) {
    throw new Error(`${options.method || 'GET'} ${pathname} returned invalid JSON: ${error.message}; body=${response.text.slice(0, 500)}`);
  }
}

async function httpText(pathname, options = {}) {
  return expectHttpOk(await httpResponse(pathname, options), `${options.method || 'GET'} ${pathname}`).text;
}

function assert(condition, message, details = undefined) {
  if (condition) return;
  const suffix = details === undefined ? '' : `\n${JSON.stringify(details, null, 2)}`;
  throw new Error(`${message}${suffix}`);
}

function escapeForRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

async function websocketHandshakeStatus({ token, origin }) {
  const wsUrl = new URL('/ws', tokenUrl);
  wsUrl.protocol = 'ws:';
  if (token) wsUrl.searchParams.set('token', token);
  wsUrl.searchParams.set('sessionId', `${smokePrefix}invalid`);

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, {
      headers: origin ? { Origin: origin } : {},
    });
    let settled = false;
    const timer = setTimeout(() => finish(new Error('WebSocket handshake status timed out')), 5000);

    function finish(error, status) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(status);
    }

    ws.on('unexpected-response', (_request, response) => {
      const status = response.statusCode || 0;
      response.resume();
      finish(null, status);
    });
    ws.on('open', () => {
      finish(null, 101);
      ws.close();
    });
    ws.on('error', (error) => finish(error));
  });
}

async function verifyHttpAndWebSocketSecurity(token) {
  const sameOrigin = `http://127.0.0.1:${port}`;
  const missingToken = await httpResponse('/api/sessions');
  const wrongToken = await httpResponse('/api/sessions', { token: `${token}-wrong` });
  const hostileOrigin = await httpResponse('/api/sessions', {
    token,
    headers: { Origin: 'https://attacker.invalid' },
  });
  const acceptedOrigin = await httpResponse('/api/sessions', {
    token,
    headers: { Origin: sameOrigin },
  });
  assert(missingToken.status === 401, 'missing HTTP token was not rejected', missingToken);
  assert(wrongToken.status === 401, 'invalid HTTP token was not rejected', wrongToken);
  assert(hostileOrigin.status === 403, 'cross-origin HTTP request was not rejected', hostileOrigin);
  assert(acceptedOrigin.status === 200, 'same-origin HTTP request was rejected', acceptedOrigin);

  const bootstrap = await httpResponse(`/?token=${encodeURIComponent(token)}`);
  assert(bootstrap.status === 200, 'token bootstrap request failed', bootstrap);
  const setCookie = (bootstrap.headers['set-cookie'] || []).find((value) => value.startsWith('warpish_token='));
  assert(setCookie, 'token bootstrap did not set the auth cookie', bootstrap.headers);
  assert(/;\s*HttpOnly(?:;|$)/i.test(setCookie), 'auth cookie is missing HttpOnly', setCookie);
  assert(/;\s*SameSite=Strict(?:;|$)/i.test(setCookie), 'auth cookie is missing SameSite=Strict', setCookie);
  assert(/;\s*Max-Age=2592000(?:;|$)/i.test(setCookie), 'auth cookie does not retain long-running tabs for 30 days', setCookie);
  assert(bootstrap.headers['referrer-policy'] === 'no-referrer', 'bootstrap response must suppress token referrers', bootstrap.headers);
  const cookie = setCookie.split(';', 1)[0];
  const cookieAuth = await httpResponse('/readyz', { headers: { Cookie: cookie } });
  assert(cookieAuth.status === 200, 'HttpOnly cookie did not authenticate a follow-up request', cookieAuth);
  const missingRefreshAuth = await httpResponse('/api/auth/refresh', { method: 'POST' });
  assert(missingRefreshAuth.status === 401, 'unauthenticated cookie refresh was not rejected', missingRefreshAuth);
  const refreshedAuth = await httpResponse('/api/auth/refresh', {
    method: 'POST',
    headers: { Cookie: cookie },
  });
  const refreshedCookie = (refreshedAuth.headers['set-cookie'] || [])
    .find((value) => value.startsWith('warpish_token='));
  assert(refreshedAuth.status === 200 && refreshedCookie, 'authenticated cookie refresh failed', refreshedAuth);
  assert(/;\s*HttpOnly(?:;|$)/i.test(refreshedCookie)
    && /;\s*SameSite=Strict(?:;|$)/i.test(refreshedCookie)
    && /;\s*Max-Age=2592000(?:;|$)/i.test(refreshedCookie), 'refreshed auth cookie lost its security or lifetime attributes', refreshedCookie);

  const hostileWs = await websocketHandshakeStatus({ token, origin: 'https://attacker.invalid' });
  const unauthenticatedWs = await websocketHandshakeStatus({ origin: sameOrigin });
  assert(hostileWs === 403, 'cross-origin WebSocket handshake was not rejected', { status: hostileWs });
  assert(unauthenticatedWs === 401, 'unauthenticated WebSocket handshake was not rejected', { status: unauthenticatedWs });

  return {
    missingTokenStatus: missingToken.status,
    wrongTokenStatus: wrongToken.status,
    hostileOriginStatus: hostileOrigin.status,
    sameOriginStatus: acceptedOrigin.status,
    cookieFlagsVerified: true,
    cookieLifetimeDays: 30,
    cookieAuthStatus: cookieAuth.status,
    cookieRefreshStatus: refreshedAuth.status,
    unauthenticatedCookieRefreshStatus: missingRefreshAuth.status,
    hostileWebSocketStatus: hostileWs,
    unauthenticatedWebSocketStatus: unauthenticatedWs,
  };
}

function verifyNonLoopbackBindRefusal() {
  const probeRoot = path.join(smokeRoot, 'remote-bind-probe');
  fs.mkdirSync(probeRoot, { recursive: true });
  const result = spawnSync(process.execPath, ['server.js'], {
    cwd: projectRoot,
    env: isolatedTmuxEnvironment({
      HOST: '0.0.0.0',
      PORT: '0',
      WARPISH_ALLOW_REMOTE: '0',
      WARPISH_DATA_DIR: path.join(probeRoot, 'data'),
      WARPISH_TOKEN_FILE: path.join(probeRoot, 'token'),
      WARPISH_SESSION_PREFIX: `${smokePrefix}remote-`,
    }),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 5000,
  });
  assert(!result.error, 'non-loopback refusal probe did not exit cleanly', {
    error: result.error?.message,
    stdout: result.stdout,
    stderr: result.stderr,
  });
  assert(result.status !== 0, 'server accepted a non-loopback bind without explicit opt-in', {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  });
  assert(result.stderr.includes('Refusing to bind Warpish Terminal to non-loopback host'), 'non-loopback refusal diagnostic is missing', result.stderr);
  return { status: result.status, diagnosticVerified: true };
}

async function verifyExclusiveDataDirOwnership(token) {
  const contenderPort = await freePort();
  const contender = spawn(process.execPath, ['server.js'], {
    cwd: projectRoot,
    env: isolatedTmuxEnvironment({
      PORT: String(contenderPort),
      HOST: '127.0.0.1',
      WARPISH_DATA_DIR: smokeDataDir,
      WARPISH_TOKEN_FILE: smokeTokenFile,
      WARPISH_SESSION_PREFIX: smokePrefix,
      WARPISH_SKIP_USER_ZSHRC: '1',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let contenderStdout = '';
  let contenderStderr = '';
  contender.stdout.on('data', (chunk) => { contenderStdout += chunk.toString(); });
  contender.stderr.on('data', (chunk) => { contenderStderr += chunk.toString(); });
  const startedAt = Date.now();

  try {
    const exit = await Promise.race([
      new Promise((resolve) => contender.once('close', (code, signal) => resolve({ code, signal }))),
      delay(5000).then(() => null),
    ]);
    assert(exit, 'second server sharing WARPISH_DATA_DIR did not fail fast', {
      contenderPort,
      stdout: contenderStdout,
      stderr: contenderStderr,
    });
    assert(Number.isInteger(exit.code) && exit.code !== 0, 'second server sharing WARPISH_DATA_DIR did not exit with a nonzero status', {
      contenderPort,
      exit,
      stdout: contenderStdout,
      stderr: contenderStderr,
    });
    const diagnostic = `${contenderStdout}\n${contenderStderr}`;
    assert(/already owned/i.test(diagnostic), 'shared WARPISH_DATA_DIR refusal diagnostic is missing "already owned"', {
      contenderPort,
      exit,
      stdout: contenderStdout,
      stderr: contenderStderr,
    });

    const primaryReadiness = await httpJson('/readyz', { token });
    assert(primaryReadiness.ok === true, 'primary server became unhealthy after rejecting a shared DATA_DIR contender', primaryReadiness);
    return {
      contenderPort,
      contenderStatus: exit.code,
      rejectedWithinMs: Date.now() - startedAt,
      diagnosticVerified: true,
      primaryStayedReady: true,
    };
  } finally {
    await terminateChild(contender);
  }
}

function cleanupTmuxSessions(prefix) {
  const tmuxEnv = isolatedTmuxEnvironment();
  let output = '';
  try {
    output = execFileSync(tmuxBin, ['list-sessions', '-F', '#S'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: tmuxEnv,
    });
  } catch {
    return [];
  }
  const cleaned = [];
  for (const name of output.split('\n').filter((value) => value.startsWith(prefix))) {
    try {
      execFileSync(tmuxBin, ['kill-session', '-t', name], { stdio: 'ignore', env: tmuxEnv });
      cleaned.push(name);
    } catch {}
  }
  return cleaned;
}

async function terminateChild(childProcess, timeoutMs = 3000) {
  if (!childProcess || childProcess.exitCode !== null || childProcess.signalCode !== null) return;
  const exited = new Promise((resolve) => childProcess.once('close', resolve));
  childProcess.kill('SIGTERM');
  const graceful = await Promise.race([
    exited.then(() => true),
    delay(timeoutMs).then(() => false),
  ]);
  if (graceful || childProcess.exitCode !== null || childProcess.signalCode !== null) return;
  childProcess.kill('SIGKILL');
  await Promise.race([exited, delay(1000)]);
}

async function wsUntilMarker({
  token,
  sessionId,
  sendCommand,
  markerRegex,
  directTmux = false,
  preludeMessages = [],
  preludeRawMessages = [],
}) {
  const wsUrl = new URL('/ws', tokenUrl);
  wsUrl.protocol = 'ws:';
  wsUrl.searchParams.set('token', token);
  wsUrl.searchParams.set('sessionId', sessionId);
  wsUrl.searchParams.set('cols', '100');
  wsUrl.searchParams.set('rows', '30');

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let output = '';
    let inputSent = false;
    let controller = false;
    let preludeSent = false;
    let readyFallbackTimer = null;
    let settled = false;
    const answeredTerminalQueries = new Set();
    const timer = setTimeout(() => finish(new Error(`timeout waiting for PTY marker. output=${JSON.stringify(output.slice(-800))}`)), 10000);

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (readyFallbackTimer) clearTimeout(readyFallbackTimer);
      if (error) {
        try { ws.terminate(); } catch {}
        reject(error);
      } else {
        if (ws.readyState === WebSocket.CLOSED) {
          resolve(value);
          return;
        }
        const closeFallback = setTimeout(() => {
          try { ws.terminate(); } catch {}
          resolve(value);
        }, 1000);
        ws.once('close', () => {
          clearTimeout(closeFallback);
          resolve(value);
        });
        try { ws.close(1000, 'marker received'); } catch {
          clearTimeout(closeFallback);
          resolve(value);
        }
      }
    };

    const answerTerminalQueries = () => {
      const probes = [
        ['primary-da', '\x1b[c', '\x1b[?65;1;9c'],
        ['secondary-da', '\x1b[>c', '\x1b[>0;276;0c'],
        ['xterm-version', '\x1b[>q', '\x1bP>|Warpish Terminal\x1b\\'],
        ['fg-color', '\x1b]10;?\x1b\\', '\x1b]10;rgb:eeee/eeee/eeee\x1b\\'],
        ['bg-color', '\x1b]11;?\x1b\\', '\x1b]11;rgb:0707/0707/1111\x1b\\'],
        ['text-area-size', '\x1b[18t', '\x1b[8;30;100t'],
        ['window-pixel-size', '\x1b[14t', '\x1b[4;900;1280t'],
      ];
      for (const [name, query, response] of probes) {
        if (answeredTerminalQueries.has(name) || !controller || !output.includes(query) || ws.readyState !== WebSocket.OPEN) continue;
        answeredTerminalQueries.add(name);
        ws.send(JSON.stringify({ type: 'input', data: response, directTmux: false }));
      }
    };

    const maybeSendCommand = (force = false) => {
      if (!sendCommand || inputSent || !controller || ws.readyState !== WebSocket.OPEN) return;
      const promptReady = /(?:^|\r|\n)[^\r\n]{0,180}(?:[%$#❯›➜>]\s*)$/u.test(output.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''));
      if (!force && !promptReady) return;
      inputSent = true;
      ws.send(JSON.stringify({ type: 'input', data: sendCommand, directTmux }));
    };

    const sendControllerPrelude = () => {
      if (preludeSent || !controller || ws.readyState !== WebSocket.OPEN) return;
      preludeSent = true;
      for (const message of preludeMessages) ws.send(JSON.stringify(message));
      for (const message of preludeRawMessages) ws.send(message);
      answerTerminalQueries();
      maybeSendCommand(false);
      if (sendCommand && !inputSent) readyFallbackTimer = setTimeout(() => maybeSendCommand(true), 3000);
    };

    ws.on('open', () => {
      // Input is deliberately held until the server grants this socket the
      // controller lease. This keeps consecutive smoke connections deterministic.
    });

    ws.on('message', (raw, isBinary) => {
      if (isBinary) {
        output += Buffer.from(raw).toString('utf8');
        answerTerminalQueries();
        maybeSendCommand(false);
        if (markerRegex.test(output)) {
          finish(null, output);
        }
        return;
      }

      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg.type === 'role') {
        controller = msg.role === 'controller';
        if (controller) sendControllerPrelude();
        else if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'take-control', cols: 100, rows: 30 }));
        }
        return;
      }
      if (msg.type === 'server-error') finish(new Error(msg.message));
    });
    ws.on('error', (error) => finish(error));
    ws.on('close', () => {
      if (!settled) finish(new Error(`WebSocket closed before PTY marker. output=${JSON.stringify(output.slice(-800))}`));
    });
  });
}

async function wsUntilServerError({ token, sessionId }) {
  const wsUrl = new URL('/ws', tokenUrl);
  wsUrl.protocol = 'ws:';
  wsUrl.searchParams.set('token', token);
  wsUrl.searchParams.set('sessionId', sessionId);
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      try { ws.terminate(); } catch {}
      reject(new Error('timeout waiting for WebSocket server-error'));
    }, 5000);
    ws.on('message', (raw) => {
      try {
        const message = JSON.parse(String(raw));
        if (message.type !== 'server-error') return;
        clearTimeout(timer);
        try { ws.close(); } catch {}
        resolve(message);
      } catch {}
    });
    ws.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function wsUntilInputError({ token, sessionId, payload, expectedCode }) {
  const wsUrl = new URL('/ws', tokenUrl);
  wsUrl.protocol = 'ws:';
  wsUrl.searchParams.set('token', token);
  wsUrl.searchParams.set('sessionId', sessionId);

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let settled = false;
    let sent = false;
    const timer = setTimeout(() => finish(new Error(`timeout waiting for WebSocket ${expectedCode}`)), 7000);

    function finish(error, message) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.terminate(); } catch {}
      if (error) reject(error);
      else resolve(message);
    }

    ws.on('message', (raw, isBinary) => {
      if (isBinary) return;
      let message;
      try { message = JSON.parse(String(raw)); } catch { return; }
      if (message.type === 'role') {
        if (message.role === 'controller' && !sent) {
          sent = true;
          ws.send(payload);
        } else if (message.role !== 'controller' && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'take-control', cols: 100, rows: 30 }));
        }
        return;
      }
      if (message.type !== 'server-error') return;
      if (message.code !== expectedCode) {
        finish(new Error(`expected WebSocket ${expectedCode}, received ${JSON.stringify(message)}`));
        return;
      }
      finish(null, message);
    });
    ws.on('error', (error) => finish(error));
    ws.on('close', () => {
      if (!settled) finish(new Error(`WebSocket closed before ${expectedCode}`));
    });
  });
}

try {
  const inheritedTmuxProbe = isolatedTmuxEnvironment({ TMUX: '/tmp/parent,1,0', TMUX_PANE: '%99' });
  assert(!('TMUX' in inheritedTmuxProbe) && !('TMUX_PANE' in inheritedTmuxProbe) && inheritedTmuxProbe.TMUX_TMPDIR === smokeTmuxDir, 'smoke test did not isolate an inherited tmux client environment', inheritedTmuxProbe);
  await waitForServer();
  const parsed = new URL(tokenUrl);
  const token = parsed.searchParams.get('token');
  const nonLoopbackBindRefusal = verifyNonLoopbackBindRefusal();
  const exclusiveDataDirOwnership = await verifyExclusiveDataDirOwnership(token);
  const security = await verifyHttpAndWebSocketSecurity(token);
  quarantinedSessionId = `${smokePrefix}quarantine-${Date.now().toString(36)}`;
  const quarantineSecret = `__WARPISH_QUARANTINE_SECRET_${Date.now().toString(36)}__`;
  const quarantineScript = `import sys,time; print(${JSON.stringify(quarantineSecret)}); [print('legacy-private-history-%04d' % index) for index in range(100)]; sys.stdout.flush(); time.sleep(60)`;
  execFileSync(tmuxBin, ['new-session', '-d', '-s', quarantinedSessionId, `python3 -c ${shellQuote(quarantineScript)}`], {
    env: isolatedTmuxEnvironment(),
    stdio: 'pipe',
  });
  execFileSync(tmuxBin, ['set-environment', '-t', quarantinedSessionId, 'WARPISH_PRIVATE_SESSION', '1'], { env: isolatedTmuxEnvironment() });
  execFileSync(tmuxBin, ['set-environment', '-t', quarantinedSessionId, 'WARPISH_SESSION_PROFILE', 'legacy-private'], { env: isolatedTmuxEnvironment() });
  await delay(250);
  const quarantineSessions = await httpJson('/api/sessions', { token });
  const quarantinedSession = quarantineSessions.sessions.find((session) => session.id === quarantinedSessionId);
  const quarantineWsError = await wsUntilServerError({ token, sessionId: quarantinedSessionId });
  const quarantineHistoryState = paneHistoryState(quarantinedSessionId);
  assert(
    quarantinedSession?.private === true
      && quarantinedSession.privacyQuarantined === true
      && quarantinedSession.preview === ''
      && quarantineWsError.code === 'private-history-quarantined'
      && quarantineHistoryState.every((pane) => pane.limit > 0 && pane.size === 0),
    'legacy private pane with nonzero history capacity was not fail-closed and quarantined',
    { quarantinedSession, quarantineWsError, quarantineHistoryState },
  );
  const privateQuarantineVerified = true;
  const health = await httpJson('/healthz');
  const readiness = await httpJson('/readyz', { token });
  const indexHtml = await httpText('/', { token });
  const appJs = await httpText('/app.js', { token });
  const pasteSafetyJs = await httpText('/paste-safety.js', { token });
  const terminalInputJs = await httpText('/terminal-input.js', { token });
  const serverJs = fs.readFileSync(path.join(projectRoot, 'server.js'), 'utf8');
  const storageJs = fs.readFileSync(path.join(projectRoot, 'storage.js'), 'utf8');
  const removedUiIdentifiers = [
    'terminal-toolbar',
    'toolbar-actions',
    'newSessionOptions',
    'newSessionDialog',
    'settingsDialog',
    'settingsToggle',
    'terminalSearchToggle',
    'terminalSearchPanel',
    'blocksToggle',
    'blocksPanel',
    'renameSession',
    'exportSession',
    'splitVertical',
    'splitHorizontal',
    'nextPane',
  ];
  const removedRoutePatterns = [
    /app\.get\(\s*['"]\/api\/sessions\/:id\/blocks['"]/,
    /app\.get\(\s*['"]\/api\/sessions\/:id\/export['"]/,
    /app\.get\(\s*['"]\/api\/sessions\/:id\/capture['"]/,
    /app\.post\(\s*['"]\/api\/sessions\/:id\/panes['"]/,
    /app\.post\(\s*['"]\/api\/sessions\/:id\/panes\/next['"]/,
    /app\.patch\(\s*['"]\/api\/sessions\/:id['"]/,
  ];
  const sourceChecks = [
    ['minimal one-click terminal UI exists', indexHtml.includes('id="newSession"') && indexHtml.includes('id="terminal"') && indexHtml.includes('data-terminal-key="Escape"') && indexHtml.includes('data-terminal-key="Tab"')],
    ['removed toolbar and Options UI stays absent', removedUiIdentifiers.every((identifier) => !`${indexHtml}\n${appJs}`.includes(identifier))],
    ['removed search and preferences assets are not loaded', !indexHtml.includes('/vendor/search.js') && !indexHtml.includes('/terminal-preferences.js')],
    ['core local xterm assets are loaded', ['/vendor/xterm.js', '/vendor/fit.js', '/vendor/web-links.js', '/paste-safety.js', '/terminal-key-data.js', '/terminal-input.js', '/app.js'].every((asset) => indexHtml.includes(asset))],
    ['terminal input, WebSocket send, and API response handlers exist', /function\s+handleTerminalInput\s*\(/.test(appJs) && /function\s+sendRaw\s*\(\s*data\b/.test(appJs) && /function\s+parseApiResponse\s*\(/.test(appJs)],
    ['browser terminal input is byte-bounded', terminalInputJs.includes('WarpishTerminalInput') && terminalInputJs.includes('MAX_MESSAGE_BYTES = 64 * 1024') && terminalInputJs.includes('MAX_PENDING_BYTES = 1024 * 1024')],
    ['terminal output reaches generation-guarded xterm writes in text and binary modes', appJs.includes("socket.binaryType = 'arraybuffer'") && /function\s+writeTerminalOutput\s*\(/.test(appJs) && appJs.includes('writeTerminalOutput(new Uint8Array(event.data))') && appJs.includes('writeTerminalOutput(event.data)')],
    ['wheel scroll uses tmux history and cannot fall back to shell history arrows', appJs.includes('term.attachCustomWheelEventHandler(') && appJs.includes("term.modes?.mouseTrackingMode !== 'none'") && serverJs.includes("runTmux(['set-option', '-t', session.id, 'mouse', 'on'])")],
    ['interactive shell removes inherited NO_COLOR before user startup', serverJs.includes("'/usr/bin/env'") && serverJs.includes("'NO_COLOR'") && serverJs.includes("'COLORTERM=truecolor'")],
    ['direct tmux input and escape-key support exist', /function\s+writeTmuxInput\s*\(/.test(serverJs) && serverJs.includes("['\\x1b[A', 'Up']")],
    ['runtime reconnect snapshot keeps internal tmux capture and cursor restoration', /function\s+sendRuntimeSnapshot\s*\([^)]*\)[\s\S]*?capturePaneText\(sessionId,\s*\{\s*escape:\s*true,\s*history:\s*false\s*\}\)[\s\S]*?paneCursorState\(sessionId\)[\s\S]*?\\x1b\[\?1049h[\s\S]*?cursorState/.test(serverJs)],
    ['shell stays configurable and launches login-interactive', serverJs.includes("const SHELL = process.env.WARPISH_SHELL || '/bin/zsh'") && /shellQuote\(SHELL\),\s*['"]-l['"],\s*['"]-i['"]/.test(serverJs)],
    ['runtime session persistence uses SQLite', serverJs.includes('openStorage(DATABASE_FILE)') && storageJs.includes('CREATE TABLE IF NOT EXISTS sessions')],
    ['core session routes remain available', /app\.get\(\s*['"]\/api\/sessions['"]/.test(serverJs) && /app\.post\(\s*['"]\/api\/sessions['"]/.test(serverJs) && /app\.delete\(\s*['"]\/api\/sessions['"]/.test(serverJs)],
    ['removed blocks, export, capture, panes, and rename routes stay absent', removedRoutePatterns.every((pattern) => !pattern.test(serverJs))],
    ['WebSocket focus reports require the explicit JSON protocol flag and stay stripped in legacy raw mode', /function\s+stripTerminalFocusReports\s*\(/.test(serverJs) && serverJs.includes('stripTerminalFocusReports(String(raw))') && serverJs.includes('msg.allowFocusReports ? msg.data : stripTerminalFocusReports(msg.data)')],
    ['WebSocket resize values remain bounded', /cols:\s*clampNumber\(msg\.cols,\s*120,\s*20,\s*300\)/.test(serverJs) && /rows:\s*clampNumber\(msg\.rows,\s*36,\s*5,\s*120\)/.test(serverJs)],
    ['WebSocket input limits, strict binary decoding, heartbeat, and bounded worker queue remain', /const\s+MAX_TERMINAL_INPUT_BYTES\s*=\s*64\s*\*\s*1024/.test(serverJs) && serverJs.includes('maxPayload: MAX_WS_PAYLOAD_BYTES') && serverJs.includes('decodeBase64Strict(msg.data, MAX_TERMINAL_INPUT_BYTES)') && serverJs.includes("ws.on('pong'") && serverJs.includes('ws.ping()') && serverJs.includes('MAX_WORKER_STDIN_BUFFER_BYTES')],
    ['terminal paste removes implicit submits and control injection', indexHtml.includes('/paste-safety.js') && /function\s+prepareTerminalPasteText\s*\(/.test(appJs) && /function\s+handleTerminalPaste\s*\(/.test(appJs) && pasteSafetyJs.includes('withoutImplicitSubmit') && pasteSafetyJs.includes('withoutTerminalControls') && appJs.includes('event.stopImmediatePropagation()')],
  ];
  const failedSourceChecks = sourceChecks.filter(([, ok]) => !ok).map(([label]) => label);
  const coreSourceVerified = failedSourceChecks.length === 0;
  if (!coreSourceVerified) {
    throw new Error(`minimal terminal source checks failed:\n- ${failedSourceChecks.join('\n- ')}`);
  }
  const created = await httpJson('/api/sessions', {
    method: 'POST',
    token,
    body: {},
  });
  smokeSessionId = created.session.id;
  const tmuxCreatedCwd = execFileSync(tmuxBin, [
    'display-message', '-p', '-t', smokeSessionId, '#{pane_current_path}',
  ], { encoding: 'utf8', env: isolatedTmuxEnvironment() }).trim();
  assert(
    /^Terminal \d+$/u.test(created.session.title)
      && path.resolve(created.session.cwd) === path.resolve(os.homedir())
      && path.resolve(tmuxCreatedCwd) === path.resolve(os.homedir())
      && created.session.profile === 'default'
      && created.session.private === false,
    'empty POST did not create a one-click Home/default/public terminal with an automatic title',
    { session: created.session, tmuxCreatedCwd, home: os.homedir() },
  );
  const oneClickHomeCreateVerified = true;
  const normalHistoryState = paneHistoryState(smokeSessionId);
  assert(
    normalHistoryState.length === 1 && normalHistoryState.every((pane) => pane.limit === 50000),
    'normal pane did not inherit configured 50000-line history limit at creation',
    normalHistoryState,
  );
  const tmuxMouseOption = execFileSync(tmuxBin, [
    'show-options', '-t', smokeSessionId, '-v', 'mouse',
  ], { encoding: 'utf8', env: isolatedTmuxEnvironment() }).trim();
  assert(tmuxMouseOption === 'on', 'normal Warpish session did not enable tmux mouse scrollback', {
    tmuxMouseOption,
  });

  const removedRouteResponses = await Promise.all([
    ['blocks', `/api/sessions/${smokeSessionId}/blocks`, { token }],
    ['export', `/api/sessions/${smokeSessionId}/export`, { token }],
    ['capture', `/api/sessions/${smokeSessionId}/capture`, { token }],
    ['panes', `/api/sessions/${smokeSessionId}/panes`, { method: 'POST', token, body: {} }],
    ['next pane', `/api/sessions/${smokeSessionId}/panes/next`, { method: 'POST', token, body: {} }],
    ['rename', `/api/sessions/${smokeSessionId}`, { method: 'PATCH', token, body: {} }],
    ['search asset', '/vendor/search.js', { token }],
    ['preferences asset', '/terminal-preferences.js', { token }],
  ].map(async ([name, pathname, options]) => [name, await httpResponse(pathname, options)]));
  assert(
    removedRouteResponses.every(([, response]) => response.status === 404),
    'a removed toolbar/settings API or asset route is still reachable',
    Object.fromEntries(removedRouteResponses.map(([name, response]) => [name, {
      status: response.status,
      body: response.text.slice(0, 180),
    }])),
  );
  const removedRoutesVerified = true;

  const oversizedTextError = await wsUntilInputError({
    token,
    sessionId: smokeSessionId,
    payload: JSON.stringify({ type: 'input', data: 'x'.repeat((64 * 1024) + 1) }),
    expectedCode: 'input-too-large',
  });
  const invalidBinaryError = await wsUntilInputError({
    token,
    sessionId: smokeSessionId,
    payload: JSON.stringify({ type: 'input-binary', data: 'not canonical base64!' }),
    expectedCode: 'invalid-base64',
  });
  const oversizedBinaryError = await wsUntilInputError({
    token,
    sessionId: smokeSessionId,
    payload: JSON.stringify({ type: 'input-binary', data: Buffer.alloc((64 * 1024) + 1).toString('base64') }),
    expectedCode: 'input-too-large',
  });
  const inputLimitsVerified = oversizedTextError.code === 'input-too-large'
    && invalidBinaryError.code === 'invalid-base64'
    && oversizedBinaryError.code === 'input-too-large';

  const markerRegex = new RegExp(`__WARPISH_SMOKE__:[^$:\\r\\n]+:${escapeForRegex(os.homedir())}`);
  await wsUntilMarker({
    token,
    sessionId: smokeSessionId,
    sendCommand: 'echo __WARPISH_SMOKE__:$USER:$PWD\r',
    markerRegex,
    directTmux: true,
  });
  const colorEnvironmentMarker = '__WARPISH_COLOR_ENV_OK__';
  const colorEnvironmentPrefix = `\x1b[38;2;205;127;50m${colorEnvironmentMarker}`;
  const colorEnvironmentOutput = await wsUntilMarker({
    token,
    sessionId: smokeSessionId,
    sendCommand: `if [[ -z "\${NO_COLOR+x}" && "\${COLORTERM:-}" == truecolor && "\${TERM:-}" != dumb ]]; then printf '\\033[38;2;205;127;50m${colorEnvironmentMarker}\\033[0m\\n'; else printf '__WARPISH_COLOR_ENV_BAD__:%s:%s:%s\\n' "\${NO_COLOR-unset}" "\${COLORTERM-unset}" "\${TERM-unset}"; fi\r`,
    markerRegex: new RegExp(escapeForRegex(colorEnvironmentPrefix)),
    directTmux: true,
  });
  assert(colorEnvironmentOutput.includes(colorEnvironmentPrefix), 'inherited NO_COLOR suppressed truecolor terminal output', colorEnvironmentOutput.slice(-1200));
  const colorEnvironmentVerified = colorEnvironmentOutput.includes(colorEnvironmentPrefix);
  const focusFilteredText = '__WARPISH_FOCUS_FILTERED_INPUT__';
  const focusFilteredOutput = await wsUntilMarker({
    token,
    sessionId: smokeSessionId,
    sendCommand: `\x1b[Iecho ${focusFilteredText}\x1b[O\r`,
    markerRegex: new RegExp(focusFilteredText),
    directTmux: true,
    preludeMessages: [
      { type: 'resize', cols: 9999, rows: -100 },
      { type: 'resize', cols: 'not-a-number', rows: null },
    ],
    preludeRawMessages: ['\x1b[I', '\x1b[O'],
  });
  const focusFilteredInputVerified = focusFilteredOutput.includes(focusFilteredText);
  assert(focusFilteredInputVerified, 'WebSocket input focus filtering regression failed', focusFilteredOutput.slice(-1200));

  const exactIdFirst = `__WARPISH_EXACT_ID_FIRST_${Date.now().toString(36)}__`;
  const exactIdGap = `__WARPISH_EXACT_ID_GAP_${Date.now().toString(36)}__`;
  const exactIdDuplicate = `__WARPISH_EXACT_ID_DUPLICATE_${Date.now().toString(36)}__`;
  const exactIdOutput = await wsUntilMarker({
    token,
    sessionId: smokeSessionId,
    sendCommand: '',
    markerRegex: new RegExp(`${escapeForRegex(exactIdFirst)}[\\s\\S]*${escapeForRegex(exactIdGap)}`),
    preludeMessages: [
      { type: 'input', data: `echo ${exactIdFirst}\r`, directTmux: true, inputId: 'smoke-exact:2' },
      { type: 'input', data: `echo ${exactIdGap}\r`, directTmux: true, inputId: 'smoke-exact:1' },
      { type: 'input', data: `echo ${exactIdDuplicate}\r`, directTmux: true, inputId: 'smoke-exact:2' },
    ],
  });
  await delay(250);
  const exactIdPane = execFileSync(tmuxBin, ['capture-pane', '-p', '-t', smokeSessionId, '-S', '-100'], {
    encoding: 'utf8',
    env: isolatedTmuxEnvironment(),
  });
  const exactInputDedupVerified = exactIdOutput.includes(exactIdFirst)
    && exactIdOutput.includes(exactIdGap)
    && !exactIdPane.includes(exactIdDuplicate);
  assert(exactInputDedupVerified, 'exact input-id dedup dropped a sequence gap or executed a duplicate id', {
    exactIdOutput: exactIdOutput.slice(-1200),
    exactIdPane: exactIdPane.slice(-1200),
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
  const directTmuxOutput = await wsUntilMarker({
    token,
    sessionId: smokeSessionId,
    sendCommand: `echo ${directTmuxText}\r`,
    markerRegex: new RegExp(directTmuxText),
    directTmux: true,
  });
  assert(directTmuxOutput.includes(directTmuxText), 'direct tmux input did not reach the shell', directTmuxOutput.slice(-1200));

  const bidiText = 'سلام Mostafa، command: git status و path: /Users/test خواناست';
  const bidiCommand = `echo ${JSON.stringify(bidiText)}`;
  const bidiRegex = new RegExp(escapeForRegex(bidiText));
  const bidiOutput = await wsUntilMarker({
    token,
    sessionId: smokeSessionId,
    sendCommand: `${bidiCommand}\r`,
    markerRegex: bidiRegex,
    directTmux: true,
  });
  assert(bidiOutput.includes(bidiText), 'UTF-8 terminal output was not preserved', bidiOutput.slice(-1200));

  // Restart the actual web server while leaving this isolated tmux server and
  // SQLite data directory intact. This verifies the production lifecycle, not
  // merely a second WebSocket connection to the same Node process.
  const restartResumeMarker = `__WARPISH_RESTART_RESUME_${Date.now().toString(36)}__`;
  await wsUntilMarker({
    token,
    sessionId: smokeSessionId,
    sendCommand: `echo ${restartResumeMarker}\r`,
    markerRegex: new RegExp(restartResumeMarker),
    directTmux: true,
  });
  const firstServerPid = child.pid;
  await terminateChild(child, 5000);
  assert(child.exitCode !== null || child.signalCode !== null, 'first web server did not exit before restart', {
    pid: firstServerPid,
    stdout,
    stderr,
  });
  const tmuxSurvivedRestart = spawnSync(tmuxBin, ['has-session', '-t', smokeSessionId], {
    env: isolatedTmuxEnvironment(),
    stdio: 'ignore',
    timeout: 3000,
  });
  assert(tmuxSurvivedRestart.status === 0, 'tmux session did not survive the web-server shutdown', {
    sessionId: smokeSessionId,
    status: tmuxSurvivedRestart.status,
    error: tmuxSurvivedRestart.error?.message,
  });

  startServerProcess();
  await waitForServer();
  const restartedServerPid = child.pid;
  const restartedToken = new URL(tokenUrl).searchParams.get('token');
  assert(restartedServerPid !== firstServerPid, 'restart reused the original web-server process', {
    firstServerPid,
    restartedServerPid,
  });
  assert(restartedToken === token, 'server restart did not preserve the isolated runtime token', {
    before: token,
    after: restartedToken,
  });
  const restartReadiness = await httpJson('/readyz', { token: restartedToken });
  assert(restartReadiness.ok === true, 'restarted server did not become ready', restartReadiness);

  const restartedSessions = await httpJson('/api/sessions', { token: restartedToken });
  const restartedSession = restartedSessions.sessions?.find((session) => session.id === smokeSessionId);
  assert(restartedSession?.alive === true, 'persisted tmux session was not discoverable after web-server restart', {
    sessionId: smokeSessionId,
    sessions: restartedSessions.sessions,
  });
  const restartSnapshot = await wsUntilMarker({
    token: restartedToken,
    sessionId: smokeSessionId,
    sendCommand: '',
    markerRegex: new RegExp(restartResumeMarker),
  });
  assert(restartSnapshot.includes(restartResumeMarker), 'reconnected PTY snapshot did not restore the pre-restart terminal screen', restartSnapshot.slice(-1600));
  const postRestartMarker = `__WARPISH_POST_RESTART_${Date.now().toString(36)}__`;
  const postRestartOutput = await wsUntilMarker({
    token: restartedToken,
    sessionId: smokeSessionId,
    sendCommand: `echo ${postRestartMarker}\r`,
    markerRegex: new RegExp(postRestartMarker),
    directTmux: true,
  });
  assert(postRestartOutput.includes(postRestartMarker), 'resumed terminal could not complete a command after restart', postRestartOutput.slice(-1600));
  const serverRestartResumeVerified = true;

  const stoppedCreated = await httpJson('/api/sessions', {
    method: 'POST',
    token: restartedToken,
    body: {},
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

  const sidebarPreviewMarker = `__WARPISH_SIDEBAR_PREVIEW_${Date.now().toString(36)}__`;
  await wsUntilMarker({
    token,
    sessionId: smokeSessionId,
    sendCommand: `echo ${sidebarPreviewMarker}\r`,
    markerRegex: new RegExp(sidebarPreviewMarker),
    directTmux: true,
  });
  const listedSession = await waitForSessionPreview({
    token,
    sessionId: smokeSessionId,
    needle: sidebarPreviewMarker,
  });
  const sidebarPreviewHasMarker = listedSession.preview.includes(sidebarPreviewMarker);
  assert(sidebarPreviewHasMarker, 'sidebar preview marker was only reported, not verified', listedSession);

  console.log(JSON.stringify({
    ok: true,
    health,
    readinessOk: readiness.ok,
    security,
    privateQuarantineVerified,
    nonLoopbackBindRefusal,
    exclusiveDataDirOwnership,
    createdSession: smokeSessionId,
    oneClickHomeCreateVerified,
    removedRoutesVerified,
    inputLimitsVerified,
    resumeVerified: Boolean(listedSession?.alive),
    serverRestartResumeVerified,
    restart: {
      firstServerPid,
      restartedServerPid,
      tmuxSessionSurvived: true,
      sessionDiscovered: restartedSession.alive,
      terminalSnapshotRestored: true,
      postRestartCommandWorked: postRestartOutput.includes(postRestartMarker),
    },
    sidebarPreviewHasMarker,
    coreSourceVerified,
    colorEnvironmentVerified,
    directTmuxInputVerified: true,
    utf8OutputVerified: bidiOutput.includes(bidiText),
    focusFilteredInputVerified,
    rawWireFocusMessagesAccepted: true,
    exactInputDedupVerified,
    resizeProtocolVerified: true,
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
      if (quarantinedSessionId) await httpJson(`/api/sessions/${quarantinedSessionId}?purge=1`, { method: 'DELETE', token });
    }
  } catch {}
  await terminateChild(child);
  cleanupTmuxSessions(smokePrefix);
  try { fs.rmSync(smokeRoot, { recursive: true, force: true }); } catch {}
}
