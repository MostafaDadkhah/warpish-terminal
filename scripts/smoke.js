import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
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
let privateSessionId;
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

function countOccurrences(text, needle) {
  if (!needle) return 0;
  return String(text || '').split(needle).length - 1;
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
  assert(bootstrap.headers['referrer-policy'] === 'no-referrer', 'bootstrap response must suppress token referrers', bootstrap.headers);
  const cookie = setCookie.split(';', 1)[0];
  const cookieAuth = await httpResponse('/readyz', { headers: { Cookie: cookie } });
  assert(cookieAuth.status === 200, 'HttpOnly cookie did not authenticate a follow-up request', cookieAuth);

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
    cookieAuthStatus: cookieAuth.status,
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
  const capture = await httpJson(`/api/sessions/${sessionId}/capture?lines=5000&ansi=1`, { token });
  throw new Error(`block not found/complete. blocks=${JSON.stringify(payload.blocks || [])} capture=${JSON.stringify({
    alternateActive: capture.alternateActive,
    captureReason: capture.captureReason,
    usingAlternate: capture.usingAlternate,
    text: String(capture.text || '').slice(-4000),
    active: String(capture.active || '').slice(-4000),
    history: String(capture.history || '').slice(-4000),
  })}`);
}

async function waitForRunningBlock({ token, sessionId, commandNeedle, outputNeedle }) {
  for (let i = 0; i < 80; i += 1) {
    const payload = await httpJson(`/api/sessions/${sessionId}/blocks`, { token });
    const block = (payload.blocks || []).find((candidate) => candidate.command?.includes(commandNeedle));
    if (block?.status === 'running' && (!outputNeedle || block.output?.includes(outputNeedle))) return block;
    await delay(100);
  }
  const payload = await httpJson(`/api/sessions/${sessionId}/blocks`, { token });
  const capture = await httpJson(`/api/sessions/${sessionId}/capture?lines=5000&ansi=1`, { token });
  throw new Error(`running block not found. blocks=${JSON.stringify(payload.blocks || [])} capture=${JSON.stringify({
    alternateActive: capture.alternateActive,
    captureReason: capture.captureReason,
    usingAlternate: capture.usingAlternate,
    text: String(capture.text || '').slice(-4000),
    active: String(capture.active || '').slice(-4000),
    savedPrimary: String(capture.savedPrimary || '').slice(-4000),
  })}`);
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
  const quarantineCapture = await httpJson(`/api/sessions/${quarantinedSessionId}/capture?lines=5000&ansi=1`, { token });
  const quarantineWsError = await wsUntilServerError({ token, sessionId: quarantinedSessionId });
  const quarantineHistoryState = paneHistoryState(quarantinedSessionId);
  assert(
    quarantinedSession?.private === true
      && quarantinedSession.privacyQuarantined === true
      && quarantinedSession.preview === ''
      && !String(quarantineCapture.text || '').includes(quarantineSecret)
      && quarantineWsError.code === 'private-history-quarantined'
      && quarantineHistoryState.every((pane) => pane.limit > 0 && pane.size === 0),
    'legacy private pane with nonzero history capacity was not fail-closed and quarantined',
    { quarantinedSession, quarantineCapture, quarantineWsError, quarantineHistoryState },
  );
  const privateQuarantineVerified = true;
  const health = await httpJson('/healthz');
  const readiness = await httpJson('/readyz', { token });
  const indexHtml = await httpText('/', { token });
  const appJs = await httpText('/app.js', { token });
  const pasteSafetyJs = await httpText('/paste-safety.js', { token });
  const stylesCss = await httpText('/styles.css', { token });
  const serverJs = fs.readFileSync(path.join(projectRoot, 'server.js'), 'utf8');
  const storageJs = fs.readFileSync(path.join(projectRoot, 'storage.js'), 'utf8');
  const shellIntegration = fs.readFileSync(path.join(projectRoot, 'scripts/warpish-shell-integration.zsh'), 'utf8');
  const sourceChecks = [
    ['legacy terminal input mask is absent', !indexHtml.includes('terminal-input-mask')],
    ['legacy RTL composer toggle is absent', !indexHtml.includes('composerToggle')],
    ['session cleanup, blocks, readable, and mouse controls exist', ['clearStoppedSessions', 'blocksToggle', 'Readable: on', 'mouseModeToggle'].every((needle) => indexHtml.includes(needle))],
    ['terminal-native persisted preferences exist', ['terminal-native-mode', 'warpish_readable_terminal_v1', 'warpish_reader_mouse_mode_v1', 'warpish_blocks_open'].every((needle) => appJs.includes(needle))],
    ['terminal input handler exists', /function\s+handleTerminalInput\s*\(/.test(appJs)],
    ['sendRaw accepts data without depending on an exact parameter list', /function\s+sendRaw\s*\(\s*data\b/.test(appJs)],
    ['API response parser exists', /function\s+parseApiResponse\s*\(/.test(appJs)],
    ['readable selection and mouse-mode helpers exist', /function\s+selectedReadableText\s*\(/.test(appJs) && /function\s+applyReaderMouseMode\s*\(/.test(appJs)],
    ['readable links are sanitized and open safely', appJs.includes('TERMINAL_LINK_RE') && appJs.includes('\\x00-\\x1f\\x7f') && appJs.includes("link.target = '_blank'") && appJs.includes("link.rel = 'noopener noreferrer'")],
    ['reader history capture remains deep and ANSI-aware', appJs.includes('const BIDI_READER_MAX_LINES = 2000') && appJs.includes('capture?lines=5000&ansi=1') && serverJs.includes("args.push('-e')")],
    ['terminal output waits for xterm write completion', /function\s+writeTerminalOutput\s*\([^)]*\)[\s\S]*?term\.write\(data,[\s\S]*?handleTerminalWriteComplete\(\)/.test(appJs) && appJs.includes('writeTerminalOutput(new Uint8Array(event.data))')],
    ['wheel handling can request tmux history in both directions', appJs.includes('const needsTmuxHistory = event.deltaY !== 0') && !appJs.includes('event.deltaY < 0 && (term.buffer?.active?.baseY ?? 0) === 0')],
    ['ANSI palette and 256-color modes remain supported', appJs.includes('XTERM_COLOR_MODE_PALETTE') && appJs.includes('XTERM_COLOR_MODE_P256') && !appJs.includes('mode === XTERM_COLOR_MODE_RGB || mode === 0x2000000')],
    ['captured ANSI parsing, styling, and conceal helpers exist', /function\s+parseAnsiCaptureEntries\s*\(/.test(appJs) && /function\s+applyAnsiSgr\s*\(/.test(appJs) && /function\s+applyTextStyle\s*\(/.test(appJs) && appJs.includes('cell.isInvisible?.()') && appJs.includes('maskInvisibleStyledText')],
    ['interactive shell removes inherited NO_COLOR before user startup', serverJs.includes("'/usr/bin/env'") && serverJs.includes("'NO_COLOR'") && serverJs.includes("'COLORTERM=truecolor'")],
    ['direct tmux input and escape-key support exist', /function\s+writeTmuxInput\s*\(/.test(serverJs) && serverJs.includes("['\\x1b[A', 'Up']")],
    ['legacy automatic composer code is absent', ['warpish_composer_open', 'shouldAutoOpenRtlComposer', 'openComposerCapture', 'commandInputDirection'].every((needle) => !appJs.includes(needle))],
    ['terminal focus and readable wheel helpers exist', /function\s+focusTerminalReliably\s*\(/.test(appJs) && /function\s+handleBidiReaderWheel\s*\(/.test(appJs)],
    ['reader render and capture throttles exist', appJs.includes('BIDI_READER_RENDER_INTERVAL_MS') && appJs.includes('BIDI_CAPTURE_REFRESH_INTERVAL_MS')],
    ['canonical reader history prevents xterm/capture ping-pong', appJs.includes("bidiReaderCaptureMode === 'history' && capturedReaderHistoryState.known") && appJs.includes('reduceCapturedReaderHistory') && appJs.includes('currentBidiReaderRenderState') && !appJs.includes('lastCapturedReaderEntries')],
    ['reader history live-tail and confirmed-reset guards are present', appJs.includes('terminalOutputRevision > capturedReaderHistoryRevision') && appJs.includes('getReadableTerminalScreenEntries') && appJs.includes('capturedReaderHistoryState.pendingReset')],
    ['alternate-screen mode captures the active tmux buffer and reconnect restores outer-buffer/cursor state', serverJs.includes("reason: 'alternate-empty'") && serverJs.includes("return { text: active, usingAlternate: true, reason: 'alternate-active' }") && /function\s+sendRuntimeSnapshot\s*\([^)]*\)[\s\S]*?capturePaneText\(sessionId,\s*\{\s*escape:\s*true,\s*history:\s*false\s*\}\)[\s\S]*?paneCursorState\(sessionId\)[\s\S]*?\\x1b\[\?1049h[\s\S]*?cursorState/.test(serverJs)],
    ['mixed-direction prompt helpers preserve logical text', /function\s+splitPromptRtlSuffix\s*\(/.test(appJs) && /function\s+appendBidiRunWithBoundarySpace\s*\(/.test(appJs) && appJs.includes('row.dataset.logicalText')],
    ['readable overlay styles and raw mouse passthrough exist', ['.bidi-segment.rtl', '.bidi-ghost', '.bidi-inline-cursor', '.bidi-style-run', 'body.reader-mouse-raw .bidi-reader'].every((needle) => stylesCss.includes(needle))],
    ['readable links have visible interaction styles', stylesCss.includes('.bidi-link') && stylesCss.includes('cursor: pointer') && stylesCss.includes('text-decoration: underline')],
    ['empty reader cannot hide xterm', stylesCss.includes('body.bidi-mode:not(.bidi-reader-has-content) .bidi-reader') && stylesCss.includes('body.bidi-mode.bidi-reader-has-content #terminal .xterm-screen')],
    ['RTL reader lines retain explicit direction and plaintext bidi', stylesCss.includes('.bidi-line.rtl') && stylesCss.includes('direction: rtl') && stylesCss.includes('unicode-bidi: plaintext')],
    ['shell stays configurable and launches login-interactive', serverJs.includes("const SHELL = process.env.WARPISH_SHELL || '/bin/zsh'") && /shellQuote\(SHELL\),\s*['"]-l['"],\s*['"]-i['"]/.test(serverJs)],
    ['runtime persistence uses SQLite instead of JSON or event sidecar files', serverJs.includes('openStorage(DATABASE_FILE)') && storageJs.includes('CREATE TABLE IF NOT EXISTS sessions') && storageJs.includes('CREATE TABLE IF NOT EXISTS blocks') && storageJs.includes('CREATE TABLE IF NOT EXISTS shell_events') && shellIntegration.includes('__warpish_database_event') && !shellIntegration.includes('WARPISH_EVENT_FILE')],
    ['WebSocket input strips focus reports in JSON and raw modes', /function\s+stripTerminalFocusReports\s*\(/.test(serverJs) && serverJs.includes('stripTerminalFocusReports(String(raw))') && serverJs.includes('stripTerminalFocusReports(msg.data)')],
    ['WebSocket resize values remain bounded', /cols:\s*clampNumber\(msg\.cols,\s*120,\s*20,\s*300\)/.test(serverJs) && /rows:\s*clampNumber\(msg\.rows,\s*36,\s*5,\s*120\)/.test(serverJs)],
    ['terminal paste removes implicit submits and control injection on every input surface', indexHtml.includes('/paste-safety.js') && /function\s+prepareTerminalPasteText\s*\(/.test(appJs) && /function\s+handleTerminalPaste\s*\(/.test(appJs) && pasteSafetyJs.includes('withoutImplicitSubmit') && pasteSafetyJs.includes('withoutTerminalControls') && appJs.includes('event.stopImmediatePropagation()') && !/function\s+handleTerminalPaste\s*\([^)]*\)[\s\S]{0,180}(?:!bidiReaderEnabled|isXtermHelperTarget\(event\.target\)\) return)/.test(appJs)],
    ['block output is replaced from canonical tmux state and wrapped commands remain matchable', /function\s+replaceBlockOutputFromPane\s*\(/.test(serverJs) && /function\s+wrappedCommandEndLine\s*\(/.test(serverJs) && /block\.output\s*=\s*snapshot\.output/.test(serverJs) && !/pending\.text\s*=/.test(serverJs)],
    ['removed alternate-buffer heuristic stays absent', !appJs.includes('isAlternateBufferActive')],
  ];
  const failedSourceChecks = sourceChecks.filter(([, ok]) => !ok).map(([label]) => label);
  const terminalNativeUiVerified = failedSourceChecks.length === 0;
  if (!terminalNativeUiVerified) {
    throw new Error(`terminal-native raw/default-readable source checks failed:\n- ${failedSourceChecks.join('\n- ')}`);
  }
  const created = await httpJson('/api/sessions', {
    method: 'POST',
    token,
    body: { title: 'Smoke resume session' },
  });
  smokeSessionId = created.session.id;
  const normalHistoryState = paneHistoryState(smokeSessionId);
  assert(
    normalHistoryState.length === 1 && normalHistoryState.every((pane) => pane.limit === 50000),
    'normal pane did not inherit configured 50000-line history limit at creation',
    normalHistoryState,
  );
  const invalidRenameType = await httpResponse(`/api/sessions/${smokeSessionId}`, {
    method: 'PATCH', token, body: { title: { unsafe: true } },
  });
  const invalidRenameControl = await httpResponse(`/api/sessions/${smokeSessionId}`, {
    method: 'PATCH', token, body: { title: 'unsafe\nheader' },
  });
  assert(
    invalidRenameType.status === 400 && invalidRenameControl.status === 400,
    'rename API accepted a non-string or control-character title',
    { invalidRenameType, invalidRenameControl },
  );
  const renameValidationVerified = true;

  const markerRegex = /__WARPISH_SMOKE__:[^$:\r\n]+:\/Users\/[^\r\n]+/;
  await wsUntilMarker({
    token,
    sessionId: smokeSessionId,
    sendCommand: 'echo __WARPISH_SMOKE__:$USER:$PWD\r',
    markerRegex,
    directTmux: true,
  });
  const forgedBlockId = `${smokeSessionId}-forged-marker`;
  const forgedMarkerAfter = `__WARPISH_FORGED_MARKER_SURVIVED_${Date.now().toString(36)}__`;
  const forgedMarkerOutput = `\x1b]697;Start;id=${forgedBlockId};started=1e300;command=${Buffer.from('echo forged').toString('base64')}\x07\n${forgedMarkerAfter}\n`;
  const forgedMarkerScript = `import sys; sys.stdout.write(${JSON.stringify(forgedMarkerOutput)}); sys.stdout.flush()`;
  await wsUntilMarker({
    token,
    sessionId: smokeSessionId,
    sendCommand: `python3 -c ${shellQuote(forgedMarkerScript)}\r`,
    markerRegex: new RegExp(forgedMarkerAfter),
    directTmux: true,
  });
  const malformedMarkerAfter = `__WARPISH_MALFORMED_MARKER_SURVIVED_${Date.now().toString(36)}__`;
  const malformedMarkerScript = `import sys; sys.stdout.write('\\x1b]697;' + ('x' * 70000) + '\\n${malformedMarkerAfter}\\n'); sys.stdout.flush()`;
  await wsUntilMarker({
    token,
    sessionId: smokeSessionId,
    sendCommand: `python3 -c ${shellQuote(malformedMarkerScript)}\r`,
    markerRegex: new RegExp(malformedMarkerAfter),
    directTmux: true,
  });
  const forgedMarkerBlocks = await httpJson(`/api/sessions/${smokeSessionId}/blocks`, { token });
  assert(!forgedMarkerBlocks.blocks.some((blockItem) => blockItem.id === forgedBlockId), 'invalid forged OSC marker was persisted as a command block', forgedMarkerBlocks);
  const markerHardeningVerified = true;
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
  let colorCapture = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    colorCapture = await httpJson(`/api/sessions/${smokeSessionId}/capture?lines=80&ansi=1`, { token });
    if (String(colorCapture.text || '').includes(colorEnvironmentPrefix)) break;
    await delay(100);
  }
  const colorEnvironmentVerified = String(colorCapture?.text || '').includes(colorEnvironmentPrefix);
  assert(colorEnvironmentVerified, 'ANSI truecolor was lost between the shell, tmux capture, and readable transport', {
    captureReason: colorCapture?.captureReason,
    tail: String(colorCapture?.text || '').slice(-1200),
  });
  const focusFilteredText = '__WARPISH_FOCUS_FILTERED_INPUT__';
  await wsUntilMarker({
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
  const focusFilteredBlock = await waitForBlock({
    token,
    sessionId: smokeSessionId,
    commandNeedle: focusFilteredText,
    outputNeedle: focusFilteredText,
  });
  const focusFilteredInputVerified = focusFilteredBlock.status === 'success'
    && focusFilteredBlock.output.includes(focusFilteredText)
    && !focusFilteredBlock.command.includes('\x1b');
  assert(focusFilteredInputVerified, 'WebSocket input focus filtering regression failed', focusFilteredBlock);

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

  const bidiText = 'سلام Mostafa، command: git status و path: /Users/test خواناست';
  const bidiCommand = `echo ${JSON.stringify(bidiText)}`;
  const bidiRegex = new RegExp(escapeForRegex(bidiText));
  await wsUntilMarker({
    token,
    sessionId: smokeSessionId,
    sendCommand: `${bidiCommand}\r`,
    markerRegex: bidiRegex,
    directTmux: true,
  });
  const bidiBlock = await waitForBlock({
    token,
    sessionId: smokeSessionId,
    commandNeedle: 'echo',
    outputNeedle: bidiText,
  });

  const redrawFixtureFile = path.join(smokeRoot, 'redraw-block-fixture.py');
  const redrawReleaseFile = path.join(smokeRoot, 'redraw-block-release');
  const redrawStartFile = path.join(smokeRoot, 'redraw-block-start');
  const redrawReadyMarker = '__WARPISH_REDRAW_READY__';
  const redrawRunningMarker = '__WARPISH_RUNNING_CANONICAL__';
  const redrawHeadMarker = '__WARPISH_REDRAW_HEAD__';
  const redrawProgressMarker = '__WARPISH_PRIMARY_PROGRESS_FINAL__ 100%';
  const redrawFinalMarker = '__WARPISH_REDRAW_FINAL__';
  const redrawPersianMarker = 'این پیام نهایی Hermes است';
  const redrawLeakedDigits = '9876543210123456789';
  fs.writeFileSync(redrawFixtureFile, [
    'import os, sys, time',
    'release_file = sys.argv[1]',
    'start_file = sys.argv[2]',
    'fd = sys.stdout.fileno()',
    'def emit(data, pause=0.01):',
    '    os.write(fd, data.encode("utf-8"))',
    '    time.sleep(pause)',
    `emit(${JSON.stringify(`${redrawHeadMarker}\r\n`)})`,
    'emit("\\x1b[?1049h")',
    `emit(${JSON.stringify(`\x1b[2J\x1b[H${redrawReadyMarker}\r\n`)})`,
    'while not os.path.exists(start_file):',
    '    time.sleep(0.02)',
    'for frame in range(12):',
    '    emit("\\x1b[2J\\x1b[H", 0.002)',
    '    emit(f"__WARPISH_TRANSIENT_FRAME_{frame:02d}__\\r\\n", 0.002)',
    '    emit("Hermes redraw transient Persian\\r\\n", 0.002)',
    '    os.write(fd, b"\\x1b[")',
    '    time.sleep(0.03)',
    '    os.write(fd, b"38;5;173m")',
    '    time.sleep(0.03)',
    '    emit(f"{frame:09d}\\x1b[0m", 0.14)',
    'os.write(fd, b"\\r\\x1b[")',
    'time.sleep(0.03)',
    `os.write(fd, ${JSON.stringify(redrawLeakedDigits)}.encode("ascii"))`,
    'time.sleep(0.03)',
    'os.write(fd, b"D")',
    `emit(${JSON.stringify(`\x1b[2J\x1b[H${redrawRunningMarker}\r\n${redrawPersianMarker}\r\n`)})`,
    'while not os.path.exists(release_file):',
    '    time.sleep(0.02)',
    'emit("\\x1b[?1049l")',
    'for step in range(20):',
    '    emit(f"\\r\\x1b[2K__WARPISH_PRIMARY_TRANSIENT_{step:02d}__ {step * 5}%", 0.002)',
    `emit(${JSON.stringify(`\r\x1b[2K${redrawProgressMarker}\r\n${redrawFinalMarker}\r\n`)})`,
  ].join('\n'));
  const redrawCommand = `python3 ${shellQuote(redrawFixtureFile)} ${shellQuote(redrawReleaseFile)} ${shellQuote(redrawStartFile)}`;
  await wsUntilMarker({
    token,
    sessionId: smokeSessionId,
    sendCommand: `${redrawCommand}\r`,
    markerRegex: new RegExp(redrawReadyMarker),
    directTmux: true,
  });
  await waitForRunningBlock({
    token,
    sessionId: smokeSessionId,
    commandNeedle: 'redraw-block-fixture.py',
    outputNeedle: redrawReadyMarker,
  });
  fs.writeFileSync(redrawStartFile, 'start');
  const liveRedrawSamples = [];
  const liveFrameIds = new Set();
  for (let sampleIndex = 0; sampleIndex < 20; sampleIndex += 1) {
    const payload = await httpJson(`/api/sessions/${smokeSessionId}/blocks`, { token });
    const sample = payload.blocks?.find((candidate) => candidate.command?.includes('redraw-block-fixture.py'));
    assert(sample?.status === 'running', 'redraw fixture stopped before live-frame sampling completed', { sampleIndex, sample });
    const frameMatches = [...String(sample.output || '').matchAll(/__WARPISH_TRANSIENT_FRAME_(\d{2})__/gu)];
    const digitMatches = [...String(sample.output || '').matchAll(/\b\d{9}\b/gu)];
    assert(frameMatches.length <= 1 && digitMatches.length <= 1, 'live redraw snapshot accumulated multiple terminal frames', {
      sampleIndex,
      output: sample.output,
    });
    assert(!sample.output.includes('[38;5;173m') && !sample.output.includes(redrawLeakedDigits), 'live redraw snapshot exposed a partial ANSI/cursor fragment', {
      sampleIndex,
      output: sample.output,
    });
    assert(sample.output.length < 4000, 'live redraw snapshot grew like an append-only frame log', {
      sampleIndex,
      length: sample.output.length,
      output: sample.output,
    });
    if (frameMatches[0]) liveFrameIds.add(frameMatches[0][1]);
    liveRedrawSamples.push({
      sampleIndex,
      frameId: frameMatches[0]?.[1] || null,
      digitFrame: digitMatches[0]?.[0] || null,
      length: sample.output.length,
    });
    await delay(90);
  }
  assert(liveFrameIds.size >= 3, 'redraw regression did not sample enough advancing live frames', {
    frameIds: [...liveFrameIds],
    samples: liveRedrawSamples,
  });
  const runningRedrawBlock = await waitForRunningBlock({
    token,
    sessionId: smokeSessionId,
    commandNeedle: 'redraw-block-fixture.py',
    outputNeedle: redrawRunningMarker,
  });
  assert(countOccurrences(runningRedrawBlock.output, redrawRunningMarker) === 1, 'running redraw snapshot duplicated its canonical frame', runningRedrawBlock);
  assert(countOccurrences(runningRedrawBlock.output, redrawPersianMarker) === 1, 'running redraw snapshot duplicated Persian content', runningRedrawBlock);
  assert(!runningRedrawBlock.output.includes('__WARPISH_TRANSIENT_FRAME_'), 'running redraw snapshot retained an obsolete alternate-screen frame', runningRedrawBlock);
  assert(!runningRedrawBlock.output.includes('[38;5;173m'), 'running redraw snapshot leaked a split ANSI fragment', runningRedrawBlock);
  assert(!runningRedrawBlock.output.includes(redrawLeakedDigits), 'running redraw snapshot leaked a split numeric cursor parameter', runningRedrawBlock);
  for (let frame = 0; frame < 12; frame += 1) {
    assert(!runningRedrawBlock.output.includes(String(frame).padStart(9, '0')), 'running redraw snapshot retained a transient numeric frame', {
      frame,
      output: runningRedrawBlock.output,
    });
  }
  assert(runningRedrawBlock.output.length < 4000, 'running redraw snapshot grew like an append-only frame log', {
    length: runningRedrawBlock.output.length,
    output: runningRedrawBlock.output,
  });

  fs.writeFileSync(redrawReleaseFile, 'release');
  const finishedRedrawBlock = await waitForBlock({
    token,
    sessionId: smokeSessionId,
    commandNeedle: 'redraw-block-fixture.py',
    outputNeedle: redrawFinalMarker,
  });
  for (const markerText of [redrawHeadMarker, redrawProgressMarker, redrawFinalMarker]) {
    assert(countOccurrences(finishedRedrawBlock.output, markerText) === 1, 'finished redraw snapshot lost or duplicated canonical output', {
      marker: markerText,
      block: finishedRedrawBlock,
    });
  }
  assert(!finishedRedrawBlock.output.includes('__WARPISH_TRANSIENT_FRAME_'), 'finished redraw output retained alternate-screen history', finishedRedrawBlock);
  assert(!finishedRedrawBlock.output.includes('__WARPISH_PRIMARY_TRANSIENT_'), 'finished redraw output retained carriage-return progress frames', finishedRedrawBlock);
  assert(!finishedRedrawBlock.output.includes('[38;5;173m'), 'finished redraw output leaked a split ANSI fragment', finishedRedrawBlock);
  assert(!finishedRedrawBlock.output.includes(redrawLeakedDigits), 'finished redraw output leaked a split numeric cursor parameter', finishedRedrawBlock);
  for (let frame = 0; frame < 12; frame += 1) {
    assert(!finishedRedrawBlock.output.includes(String(frame).padStart(9, '0')), 'finished redraw output retained a transient numeric frame', {
      frame,
      output: finishedRedrawBlock.output,
    });
  }
  for (const priorOutput of ['__WARPISH_SMOKE__', colorEnvironmentMarker, focusFilteredText, directTmuxText, bidiText]) {
    assert(!finishedRedrawBlock.output.includes(priorOutput), 'finished redraw block was contaminated by earlier session history', {
      priorOutput,
      output: finishedRedrawBlock.output,
    });
  }
  assert(finishedRedrawBlock.output.length < 5000, 'finished redraw output exceeded the canonical transcript bound', {
    length: finishedRedrawBlock.output.length,
    output: finishedRedrawBlock.output,
  });
  const redrawBlockPersistenceVerified = true;

  const postRedrawMarker = '__WARPISH_AFTER_REDRAW__';
  await wsUntilMarker({
    token,
    sessionId: smokeSessionId,
    sendCommand: `echo ${postRedrawMarker}\r`,
    markerRegex: new RegExp(postRedrawMarker),
    directTmux: true,
  });
  const postRedrawBlock = await waitForBlock({
    token,
    sessionId: smokeSessionId,
    commandNeedle: postRedrawMarker,
    outputNeedle: postRedrawMarker,
  });
  const smokeDatabaseFile = path.join(smokeDataDir, 'warpish.sqlite3');
  const smokeDatabase = new Database(smokeDatabaseFile);
  smokeDatabase.prepare('INSERT INTO shell_events (session_id, payload) VALUES (?, ?)').run(
    smokeSessionId,
    `End;id=${finishedRedrawBlock.id};ended=${Date.now() / 1000};status=0`,
  );
  smokeDatabase.close();
  const replayedBlocks = await httpJson(`/api/sessions/${smokeSessionId}/blocks`, { token });
  const redrawAfterDuplicateEnd = replayedBlocks.blocks?.find((candidate) => candidate.id === finishedRedrawBlock.id);
  assert(JSON.stringify(redrawAfterDuplicateEnd) === JSON.stringify(finishedRedrawBlock), 'duplicate/replayed End mutated historical block output or metadata', {
    before: finishedRedrawBlock,
    after: redrawAfterDuplicateEnd,
  });
  const duplicateEndReplayVerified = true;

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
  const restartMarkerBlock = await waitForBlock({
    token,
    sessionId: smokeSessionId,
    commandNeedle: restartResumeMarker,
    outputNeedle: restartResumeMarker,
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
  const blocksAfterRestart = await httpJson(`/api/sessions/${smokeSessionId}/blocks`, { token: restartedToken });
  const expectedPersistentBlocks = [block, finishedRedrawBlock, postRedrawBlock, restartMarkerBlock];
  for (const expectedBlock of expectedPersistentBlocks) {
    const persisted = blocksAfterRestart.blocks?.find((candidate) => candidate.id === expectedBlock.id);
    assert(persisted, 'command block was missing after web-server restart', {
      expectedBlock,
      blockIds: blocksAfterRestart.blocks?.map((candidate) => candidate.id),
    });
    assert(persisted.status === expectedBlock.status && persisted.output === expectedBlock.output, 'command block changed across web-server restart', {
      before: expectedBlock,
      after: persisted,
    });
  }
  const restartSnapshot = await wsUntilMarker({
    token: restartedToken,
    sessionId: smokeSessionId,
    sendCommand: '',
    markerRegex: new RegExp(restartResumeMarker),
  });
  assert(restartSnapshot.includes(restartResumeMarker), 'reconnected PTY snapshot did not restore the pre-restart terminal screen', restartSnapshot.slice(-1600));
  const postRestartMarker = `__WARPISH_POST_RESTART_${Date.now().toString(36)}__`;
  await wsUntilMarker({
    token: restartedToken,
    sessionId: smokeSessionId,
    sendCommand: `echo ${postRestartMarker}\r`,
    markerRegex: new RegExp(postRestartMarker),
    directTmux: true,
  });
  const postRestartBlock = await waitForBlock({
    token: restartedToken,
    sessionId: smokeSessionId,
    commandNeedle: postRestartMarker,
    outputNeedle: postRestartMarker,
  });
  assert(postRestartBlock.status === 'success', 'resumed terminal could not complete a command after restart', postRestartBlock);
  const serverRestartResumeVerified = true;

  const privateCreated = await httpJson('/api/sessions', {
    method: 'POST',
    token: restartedToken,
    body: { title: 'Private smoke session', profile: 'private-smoke', private: true },
  });
  privateSessionId = privateCreated.session.id;
  let privateHistoryState = paneHistoryState(privateSessionId);
  assert(
    privateHistoryState.length === 1 && privateHistoryState.every((pane) => pane.limit === 0 && pane.size === 0),
    'private pane retained tmux scrollback or inherited a nonzero history limit',
    privateHistoryState,
  );
  const privateSecret = `__WARPISH_PRIVATE_SECRET_${Date.now().toString(36)}__`;
  await wsUntilMarker({
    token: restartedToken,
    sessionId: privateSessionId,
    sendCommand: `echo ${privateSecret}\r`,
    markerRegex: new RegExp(privateSecret),
    directTmux: true,
  });
  await httpJson(`/api/sessions/${privateSessionId}/panes`, {
    method: 'POST',
    token: restartedToken,
    body: { direction: 'vertical' },
  });
  privateHistoryState = paneHistoryState(privateSessionId);
  assert(
    privateHistoryState.length === 2 && privateHistoryState.every((pane) => pane.limit === 0 && pane.size === 0),
    'private split pane did not inherit zero scrollback',
    privateHistoryState,
  );
  const privateSessions = await httpJson('/api/sessions', { token: restartedToken });
  const privateSummary = privateSessions.sessions.find((session) => session.id === privateSessionId);
  const privateCapture = await httpJson(`/api/sessions/${privateSessionId}/capture?lines=5000&ansi=1`, { token: restartedToken });
  const privateExport = await httpJson(`/api/sessions/${privateSessionId}/export`, { token: restartedToken });
  const privateBlocks = await httpJson(`/api/sessions/${privateSessionId}/blocks`, { token: restartedToken });
  assert(privateSummary?.private === true && privateSummary.preview === '', 'private session leaked content into its sidebar summary', privateSummary);
  assert(!String(privateCapture.text || '').includes(privateSecret) && privateCapture.private === true, 'private capture endpoint leaked terminal content', privateCapture);
  assert(!String(privateExport.text || '').includes(privateSecret), 'private export leaked terminal content', privateExport);
  assert(privateBlocks.blocks.length === 0, 'private command markers were retained as blocks', privateBlocks);
  const privateDatabase = new Database(path.join(smokeDataDir, 'warpish.sqlite3'), { readonly: true });
  const privateStoredBlocks = privateDatabase.prepare('SELECT COUNT(*) AS count FROM blocks WHERE session_id = ?').get(privateSessionId).count;
  const privateStoredEvents = privateDatabase.prepare('SELECT COUNT(*) AS count FROM shell_events WHERE session_id = ?').get(privateSessionId).count;
  privateDatabase.close();
  assert(
    privateStoredBlocks === 0 && privateStoredEvents === 0,
    'private terminal content reached durable SQLite rows',
    { privateStoredBlocks, privateStoredEvents },
  );
  const recoveryDatabase = new Database(path.join(smokeDataDir, 'warpish.sqlite3'));
  recoveryDatabase.prepare('DELETE FROM sessions WHERE id = ?').run(privateSessionId);
  recoveryDatabase.close();
  const recoveredPrivateSessions = await httpJson('/api/sessions', { token: restartedToken });
  const recoveredPrivate = recoveredPrivateSessions.sessions.find((session) => session.id === privateSessionId);
  assert(
    recoveredPrivate?.private === true
      && recoveredPrivate.profile === 'private-smoke'
      && recoveredPrivate.preview === '',
    'private tmux session was adopted as non-private after SQLite metadata loss',
    recoveredPrivate,
  );
  const privateModeVerified = true;
  const privateRecoveryVerified = true;

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

  const sidebarPreviewMarker = `__WARPISH_SIDEBAR_PREVIEW_${Date.now().toString(36)}__`;
  await wsUntilMarker({
    token,
    sessionId: smokeSessionId,
    sendCommand: `echo ${sidebarPreviewMarker}\r`,
    markerRegex: new RegExp(sidebarPreviewMarker),
    directTmux: true,
  });
  await waitForBlock({
    token,
    sessionId: smokeSessionId,
    commandNeedle: sidebarPreviewMarker,
    outputNeedle: sidebarPreviewMarker,
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
    resumeVerified: Boolean(listedSession?.alive),
    serverRestartResumeVerified,
    privateModeVerified,
    privateRecoveryVerified,
    renameValidationVerified,
    markerHardeningVerified,
    privateHistoryState,
    restart: {
      firstServerPid,
      restartedServerPid,
      tmuxSessionSurvived: true,
      sessionDiscovered: restartedSession.alive,
      terminalSnapshotRestored: true,
      persistedBlockCount: expectedPersistentBlocks.length,
      postRestartCommandBlockId: postRestartBlock.id,
    },
    sidebarPreviewHasMarker,
    terminalNativeUiVerified,
    colorEnvironmentVerified,
    directTmuxInputVerified: true,
    focusFilteredInputVerified,
    rawWireFocusMessagesAccepted: true,
    resizeProtocolVerified: true,
    blockVerified: block.status === 'success' && block.output.includes('__WARPISH_SMOKE__'),
    blockCommand: block.command,
    blockStatus: block.status,
    bidiBlockVerified: bidiBlock.status === 'success' && bidiBlock.output.includes(bidiText),
    bidiBlockOutput: bidiBlock.output,
    redrawBlockPersistenceVerified,
    duplicateEndReplayVerified,
    redrawBlockDiagnostics: {
      runningLength: runningRedrawBlock.output.length,
      finishedLength: finishedRedrawBlock.output.length,
      liveSampleCount: liveRedrawSamples.length,
      distinctLiveFrames: liveFrameIds.size,
      canonicalRunningFrames: countOccurrences(runningRedrawBlock.output, redrawRunningMarker),
      canonicalFinalFrames: countOccurrences(finishedRedrawBlock.output, redrawFinalMarker),
    },
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
      if (privateSessionId) await httpJson(`/api/sessions/${privateSessionId}?purge=1`, { method: 'DELETE', token });
      if (quarantinedSessionId) await httpJson(`/api/sessions/${quarantinedSessionId}?purge=1`, { method: 'DELETE', token });
    }
  } catch {}
  await terminateChild(child);
  cleanupTmuxSessions(smokePrefix);
  try { fs.rmSync(smokeRoot, { recursive: true, force: true }); } catch {}
}
