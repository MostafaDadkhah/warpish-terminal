import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import WebSocket from 'ws';

const port = process.env.PORT ? Number(process.env.PORT) : await freePort();
const projectRoot = new URL('..', import.meta.url).pathname;
const smokeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'warpish-smoke-'));
const smokeDataDir = path.join(smokeRoot, 'data');
const smokeTokenFile = path.join(smokeRoot, 'token');
const smokePrefix = `warpishsmoke-${process.pid.toString(36)}-`;
const tmuxBin = process.env.TMUX_BIN
  || ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux'].find((candidate) => fs.existsSync(candidate))
  || 'tmux';
const child = spawn(process.execPath, ['server.js'], {
  cwd: projectRoot,
  env: {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    WARPISH_DATA_DIR: smokeDataDir,
    WARPISH_TOKEN_FILE: smokeTokenFile,
    WARPISH_SESSION_PREFIX: smokePrefix,
    WARPISH_SKIP_USER_ZSHRC: '1',
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
    env: {
      ...process.env,
      HOST: '0.0.0.0',
      PORT: '0',
      WARPISH_ALLOW_REMOTE: '0',
      WARPISH_DATA_DIR: path.join(probeRoot, 'data'),
      WARPISH_TOKEN_FILE: path.join(probeRoot, 'token'),
      WARPISH_SESSION_PREFIX: `${smokePrefix}remote-`,
    },
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

function cleanupTmuxSessions(prefix) {
  let output = '';
  try {
    output = execFileSync(tmuxBin, ['list-sessions', '-F', '#S'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return [];
  }
  const cleaned = [];
  for (const name of output.split('\n').filter((value) => value.startsWith(prefix))) {
    try {
      execFileSync(tmuxBin, ['kill-session', '-t', name], { stdio: 'ignore' });
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
        try { ws.close(); } catch {}
        resolve(value);
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
        if (answeredTerminalQueries.has(name) || !output.includes(query) || ws.readyState !== WebSocket.OPEN) continue;
        answeredTerminalQueries.add(name);
        ws.send(JSON.stringify({ type: 'input', data: response, directTmux: false }));
      }
    };

    const maybeSendCommand = (force = false) => {
      if (!sendCommand || inputSent || ws.readyState !== WebSocket.OPEN) return;
      const promptReady = /(?:^|\r|\n)[^\r\n]{0,180}(?:[%$#❯›➜>]\s*)$/u.test(output.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''));
      if (!force && !promptReady) return;
      inputSent = true;
      ws.send(JSON.stringify({ type: 'input', data: sendCommand, directTmux }));
    };

    ws.on('open', () => {
      for (const message of preludeMessages) ws.send(JSON.stringify(message));
      for (const message of preludeRawMessages) ws.send(message);
      if (sendCommand) {
        readyFallbackTimer = setTimeout(() => maybeSendCommand(true), 3000);
      }
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
      if (msg.type === 'server-error') finish(new Error(msg.message));
    });
    ws.on('error', (error) => finish(error));
    ws.on('close', () => {
      if (!settled) finish(new Error(`WebSocket closed before PTY marker. output=${JSON.stringify(output.slice(-800))}`));
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
  throw new Error(`block not found/complete. blocks=${JSON.stringify(payload.blocks || [])}`);
}

try {
  await waitForServer();
  const parsed = new URL(tokenUrl);
  const token = parsed.searchParams.get('token');
  const nonLoopbackBindRefusal = verifyNonLoopbackBindRefusal();
  const security = await verifyHttpAndWebSocketSecurity(token);
  const health = await httpJson('/healthz');
  const readiness = await httpJson('/readyz', { token });
  const indexHtml = await httpText('/', { token });
  const appJs = await httpText('/app.js', { token });
  const stylesCss = await httpText('/styles.css', { token });
  const serverJs = fs.readFileSync(path.join(projectRoot, 'server.js'), 'utf8');
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
    ['terminal output waits for xterm write completion', appJs.includes('term.write(new Uint8Array(event.data), handleTerminalWriteComplete)')],
    ['wheel handling can request tmux history in both directions', appJs.includes('const needsTmuxHistory = event.deltaY !== 0') && !appJs.includes('event.deltaY < 0 && (term.buffer?.active?.baseY ?? 0) === 0')],
    ['ANSI palette and 256-color modes remain supported', appJs.includes('XTERM_COLOR_MODE_PALETTE') && appJs.includes('XTERM_COLOR_MODE_P256') && !appJs.includes('mode === XTERM_COLOR_MODE_RGB || mode === 0x2000000')],
    ['captured ANSI parsing and styling helpers exist', /function\s+parseAnsiCaptureEntries\s*\(/.test(appJs) && /function\s+applyAnsiSgr\s*\(/.test(appJs) && /function\s+applyTextStyle\s*\(/.test(appJs)],
    ['direct tmux input and escape-key support exist', /function\s+writeTmuxInput\s*\(/.test(serverJs) && serverJs.includes("['\\x1b[A', 'Up']")],
    ['legacy automatic composer code is absent', ['warpish_composer_open', 'shouldAutoOpenRtlComposer', 'openComposerCapture', 'commandInputDirection'].every((needle) => !appJs.includes(needle))],
    ['terminal focus and readable wheel helpers exist', /function\s+focusTerminalReliably\s*\(/.test(appJs) && /function\s+handleBidiReaderWheel\s*\(/.test(appJs)],
    ['reader render and capture throttles exist', appJs.includes('BIDI_READER_RENDER_INTERVAL_MS') && appJs.includes('BIDI_CAPTURE_REFRESH_INTERVAL_MS')],
    ['alternate-buffer reader selection is xterm-first', appJs.includes('const shouldUseCapture = (isTerminalAlternateBuffer() && (!xtermHasText || xtermIsSparse))') && !appJs.includes('isSparseReadableEntries(entries) || lastCapturedReaderEntries.length > 0')],
    ['reader history capture guard is present', appJs.includes('isBidiReaderHistoryMode() && lastCapturedReaderEntries.length > entries.length') && !appJs.includes('renderBidiReader(entries.length ? entries : fallbackEntries')],
    ['mixed-direction prompt helpers preserve logical text', /function\s+splitPromptRtlSuffix\s*\(/.test(appJs) && /function\s+appendBidiRunWithBoundarySpace\s*\(/.test(appJs) && appJs.includes('row.dataset.logicalText')],
    ['readable overlay styles and raw mouse passthrough exist', ['.bidi-segment.rtl', '.bidi-ghost', '.bidi-inline-cursor', '.bidi-style-run', 'body.reader-mouse-raw .bidi-reader'].every((needle) => stylesCss.includes(needle))],
    ['readable links have visible interaction styles', stylesCss.includes('.bidi-link') && stylesCss.includes('cursor: pointer') && stylesCss.includes('text-decoration: underline')],
    ['empty reader cannot hide xterm', stylesCss.includes('body.bidi-mode:not(.bidi-reader-has-content) .bidi-reader') && stylesCss.includes('body.bidi-mode.bidi-reader-has-content #terminal .xterm-screen')],
    ['RTL reader lines retain explicit direction and plaintext bidi', stylesCss.includes('.bidi-line.rtl') && stylesCss.includes('direction: rtl') && stylesCss.includes('unicode-bidi: plaintext')],
    ['shell stays configurable and launches login-interactive', serverJs.includes("const SHELL = process.env.WARPISH_SHELL || '/bin/zsh'") && /shellQuote\(SHELL\),\s*['"]-l['"],\s*['"]-i['"]/.test(serverJs)],
    ['WebSocket input strips focus reports in JSON and raw modes', /function\s+stripTerminalFocusReports\s*\(/.test(serverJs) && serverJs.includes('stripTerminalFocusReports(String(raw))') && serverJs.includes('stripTerminalFocusReports(msg.data)')],
    ['WebSocket resize values remain bounded', /cols:\s*clampNumber\(msg\.cols,\s*120,\s*20,\s*300\)/.test(serverJs) && /rows:\s*clampNumber\(msg\.rows,\s*36,\s*5,\s*120\)/.test(serverJs)],
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

  const markerRegex = /__WARPISH_SMOKE__:[^$:\r\n]+:\/Users\/[^\r\n]+/;
  await wsUntilMarker({
    token,
    sessionId: smokeSessionId,
    sendCommand: 'echo __WARPISH_SMOKE__:$USER:$PWD\r',
    markerRegex,
    directTmux: true,
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

  const escapeForRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
    readinessOk: readiness.ok,
    security,
    nonLoopbackBindRefusal,
    createdSession: smokeSessionId,
    resumeVerified: Boolean(listedSession?.alive),
    sidebarPreviewHasMarker: Boolean(listedSession?.preview?.includes('__WARPISH_SMOKE__')),
    terminalNativeUiVerified,
    directTmuxInputVerified: true,
    focusFilteredInputVerified,
    rawWireFocusMessagesAccepted: true,
    resizeProtocolVerified: true,
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
  await terminateChild(child);
  cleanupTmuxSessions(smokePrefix);
  try { fs.rmSync(smokeRoot, { recursive: true, force: true }); } catch {}
}
