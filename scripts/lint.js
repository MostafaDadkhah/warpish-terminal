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

if (failures.length) {
  console.error(failures.map((item) => `- ${item}`).join('\n'));
  process.exit(1);
}

console.log('lint: security/UX guardrails passed');
