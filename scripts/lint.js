import fs from 'node:fs';
import path from 'node:path';

const projectRoot = new URL('..', import.meta.url).pathname;
const failures = [];

function read(relPath) {
  return fs.readFileSync(path.join(projectRoot, relPath), 'utf8');
}

function fail(message) {
  failures.push(message);
}

const appJs = read('public/app.js');
const serverJs = read('server.js');
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

if (/\.toolbar-actions\s*\{[^}]*display:\s*none/s.test(stylesCss)) {
  fail('styles.css must not hide critical toolbar actions on narrow/mobile layouts. Use an overflow/compact layout.');
}

if (!stylesCss.includes('body.reader-mouse-raw .bidi-reader')) {
  fail('styles.css must preserve raw mouse passthrough mode for readable overlay/TUI interaction.');
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

if (failures.length) {
  console.error(failures.map((item) => `- ${item}`).join('\n'));
  process.exit(1);
}

console.log('lint: security/UX guardrails passed');
