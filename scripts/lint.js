import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const failures = [];

function read(relPath) {
  return fs.readFileSync(path.join(projectRoot, relPath), 'utf8');
}

function fail(message) {
  failures.push(message);
}

const appJs = read('public/app.js');
const indexHtml = read('public/index.html');
const pasteSafetyJs = read('public/paste-safety.js');
const terminalKeyDataJs = read('public/terminal-key-data.js');
const terminalInputJs = read('public/terminal-input.js');
const serverJs = read('server.js');
const storageJs = read('storage.js');
const stylesCss = read('public/styles.css');
const smokeJs = read('scripts/smoke.js');
const browserRegressionJs = read('scripts/browser-regressions.js');
const uiAgentJs = read('scripts/ui-stability-agent.js');
const packageJson = JSON.parse(read('package.json'));

if (/\.innerHTML\b|insertAdjacentHTML\s*\(/.test(appJs)) {
  fail('public/app.js must not render runtime data with innerHTML/insertAdjacentHTML. Use DOM nodes + textContent.');
}

if (/url\.searchParams\.set\(['"]token['"]/.test(appJs)) {
  fail('public/app.js must not put auth tokens into WebSocket/API query strings. Use same-origin cookie/header bootstrap.');
}

if (/httpOnly:\s*false/.test(serverJs)) {
  fail('server.js must not create frontend-readable auth cookies for shell-equivalent access.');
}

if (!serverJs.includes('WARPISH_ALLOW_REMOTE') || !serverJs.includes('isAllowedOrigin')) {
  fail('server.js must preserve non-loopback bind guard and Origin checks.');
}

if (!packageJson.dependencies?.['better-sqlite3']
  || !serverJs.includes('openStorage(DATABASE_FILE)')
  || !storageJs.includes('CREATE TABLE IF NOT EXISTS sessions')
  || !serverJs.includes('migrateLegacyStorage')) {
  fail('Runtime session persistence must use the standalone SQLite database without a JSON source of truth.');
}

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
const removedUiSources = `${indexHtml}\n${appJs}\n${stylesCss}`;
const survivingUiIdentifiers = removedUiIdentifiers.filter((identifier) => removedUiSources.includes(identifier));
if (survivingUiIdentifiers.length) {
  fail(`Removed toolbar, Options, settings, search, blocks, rename, export, or pane UI identifiers remain: ${survivingUiIdentifiers.join(', ')}`);
}

if (!indexHtml.includes('id="newSession"')
  || !indexHtml.includes('id="terminal"')
  || !indexHtml.includes('data-terminal-key="Escape"')
  || !indexHtml.includes('data-terminal-key="Tab"')
  || !appJs.includes('new TerminalCtor(')
  || !appJs.includes('new FitAddonCtor(')
  || !/function\s+handleTerminalInput\s*\(/.test(appJs)
  || !/function\s+sendRaw\s*\(\s*data\b/.test(appJs)
  || !appJs.includes("socket.binaryType = 'arraybuffer'")
  || !appJs.includes('writeTerminalOutput(new Uint8Array(event.data))')
  || !appJs.includes('writeTerminalOutput(event.data)')) {
  fail('The minimal one-click xterm UI and its core terminal input path must remain present.');
}

if (!smokeJs.includes('freePort()')) {
  fail('scripts/smoke.js must use a dynamic free port by default to avoid CI/local port collisions.');
}

if (!smokeJs.includes('cleanupTmuxSessions(smokePrefix)')) {
  fail('scripts/smoke.js must have a tmux-prefix cleanup fallback when API cleanup is unavailable.');
}

if (!smokeJs.includes('verifyHttpAndWebSocketSecurity') || !smokeJs.includes('verifyNonLoopbackBindRefusal')) {
  fail('scripts/smoke.js must preserve behavioral auth/origin/cookie and local-bind coverage.');
}

if (!browserRegressionJs.includes("chrome.stdout.on('data'") || !browserRegressionJs.includes("chrome.stderr.on('data'")) {
  fail('scripts/browser-regressions.js must drain Chrome stdout/stderr so CDP startup cannot block on full pipes.');
}

if (/execFileSync\(chromePath,\s*\[['"]--version['"]\]/.test(browserRegressionJs)) {
  fail('scripts/browser-regressions.js must not run Chrome --version synchronously without a timeout.');
}

if (/\bspawnSync\b/.test(uiAgentJs)) {
  fail('scripts/ui-stability-agent.js must use an async child process so timeout cleanup can kill the full process group.');
}

if (packageJson.scripts?.regression !== 'node scripts/ui-stability-agent.js') {
  fail('package.json regression must run the browser suite once through the UI stability validator.');
}

const appScriptIndex = indexHtml.indexOf('<script src="/app.js"></script>');
for (const clientScript of ['/paste-safety.js', '/terminal-key-data.js', '/terminal-input.js']) {
  const scriptIndex = indexHtml.indexOf(`<script src="${clientScript}"></script>`);
  if (scriptIndex < 0 || appScriptIndex < 0 || scriptIndex > appScriptIndex) {
    fail(`${clientScript} must be loaded before /app.js.`);
  }
}

if (!terminalKeyDataJs.includes('WarpishTerminalKeys')
  || !terminalKeyDataJs.includes('terminalKeyData')
  || !terminalInputJs.includes('WarpishTerminalInput')
  || !terminalInputJs.includes('MAX_MESSAGE_BYTES')) {
  fail('Terminal key mapping and byte-bounded input modules must expose their stable browser APIs.');
}

if (packageJson.dependencies?.['@xterm/addon-search']
  || indexHtml.includes('/vendor/search.js')
  || serverJs.includes('/vendor/search.js')
  || serverJs.includes('@xterm/addon-search')
  || indexHtml.includes('/terminal-preferences.js')
  || packageJson.scripts?.check?.includes('terminal-preferences')) {
  fail('Removed search and terminal-preferences code must not remain installed, served, loaded, or tested.');
}

if (!/function\s+prepareTerminalPasteText\s*\(/.test(appJs)
  || !/function\s+handleTerminalPaste\s*\(/.test(appJs)
  || !indexHtml.includes('<script src="/paste-safety.js"></script>')
  || !pasteSafetyJs.includes('withoutImplicitSubmit')
  || !pasteSafetyJs.includes('withoutTerminalControls')
  || !appJs.includes('event.stopImmediatePropagation()')
  || /function\s+handleTerminalPaste\s*\([^)]*\)\s*\{\s*if\s*\(\s*!bidiReaderEnabled/.test(appJs)) {
  fail('public/app.js must keep safe multiline paste interception and explicit-submit protection.');
}

const removedRoutePatterns = [
  /app\.get\(\s*['"]\/api\/sessions\/:id\/blocks['"]/,
  /app\.get\(\s*['"]\/api\/sessions\/:id\/export['"]/,
  /app\.get\(\s*['"]\/api\/sessions\/:id\/capture['"]/,
  /app\.post\(\s*['"]\/api\/sessions\/:id\/panes['"]/,
  /app\.post\(\s*['"]\/api\/sessions\/:id\/panes\/next['"]/,
  /app\.patch\(\s*['"]\/api\/sessions\/:id['"]/,
];
if (removedRoutePatterns.some((pattern) => pattern.test(serverJs))) {
  fail('Removed blocks, export, capture, pane, or rename API routes must stay absent.');
}

if (!/app\.get\(\s*['"]\/api\/sessions['"]/.test(serverJs)
  || !/app\.post\(\s*['"]\/api\/sessions['"]/.test(serverJs)
  || !/app\.delete\(\s*['"]\/api\/sessions['"]/.test(serverJs)
  || !/app\.delete\(\s*['"]\/api\/sessions\/:id['"]/.test(serverJs)) {
  fail('Core list, one-click create, stop, and stopped-session cleanup routes must remain present.');
}

if (!/const\s+MAX_TERMINAL_INPUT_BYTES\s*=\s*64\s*\*\s*1024/.test(serverJs)
  || !serverJs.includes('maxPayload: MAX_WS_PAYLOAD_BYTES')
  || !serverJs.includes("decodeBase64Strict(msg.data, MAX_TERMINAL_INPUT_BYTES)")
  || !serverJs.includes("ws.on('pong'")
  || !serverJs.includes('ws.ping()')
  || !serverJs.includes('MAX_WORKER_STDIN_BUFFER_BYTES')) {
  fail('WebSocket payload, heartbeat, strict binary decoding, and bounded terminal input safeguards must remain present.');
}

if (!appJs.includes("msg.type === 'input-ack'")
  || !appJs.includes('releaseUnacknowledgedInputs')
  || !appJs.includes('inputId: item.inputId')
  || !appJs.includes('allowFocusReports: true')
  || !appJs.includes('terminalSurfaceGeneration')
  || !appJs.includes('terminalSurfaceTransitioning')
  || !appJs.includes('reconcilePendingInputsForRuntime')
  || !appJs.includes('resyncControllerFocus')
  || !appJs.includes('&& !last.sentRuntimeEpoch')
  || !serverJs.includes("type: 'input-ack'")
  || !serverJs.includes('acceptedInputIds: new Map()')
  || !serverJs.includes('runtimeEpoch: runtime.epoch')
  || !serverJs.includes('inputWasAccepted(runtime, ws, msg.inputId)')) {
  fail('Controller-safe acknowledged input, native focus reports, and generation-safe terminal writes must remain enabled.');
}

if (!indexHtml.includes('interactive-widget=resizes-content')
  || !appJs.includes("setProperty('--app-viewport-height'")
  || !appJs.includes("setProperty('--app-viewport-top'")
  || !appJs.includes("setProperty('--app-viewport-left'")
  || !stylesCss.includes('height: var(--app-viewport-height)')
  || !stylesCss.includes('width: var(--app-viewport-width)')
  || !stylesCss.includes('top: var(--app-viewport-top)')
  || !stylesCss.includes('left: var(--app-viewport-left)')) {
  fail('Mobile terminal layout must follow the visual viewport when the software keyboard opens.');
}

if (failures.length) {
  console.error(failures.map((item) => `- ${item}`).join('\n'));
  process.exit(1);
}

console.log('lint: minimal terminal/security guardrails passed');
