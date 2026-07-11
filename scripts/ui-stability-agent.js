import { spawnSync } from 'node:child_process';
import process from 'node:process';

const startedAt = Date.now();
const child = spawnSync(process.execPath, ['scripts/browser-regressions.js'], {
  cwd: new URL('..', import.meta.url).pathname,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
  timeout: 600_000,
});

if (child.error) {
  throw child.error;
}

if (child.status !== 0) {
  process.stdout.write(child.stdout || '');
  process.stderr.write(child.stderr || '');
  process.exit(child.status ?? 1);
}

let payload;
try {
  payload = JSON.parse(child.stdout);
} catch (error) {
  process.stdout.write(child.stdout || '');
  process.stderr.write(child.stderr || '');
  throw new Error(`UI stability agent could not parse browser regression JSON: ${error.message}`);
}

function assert(condition, message, details = undefined) {
  if (!condition) {
    const suffix = details === undefined ? '' : `\n${JSON.stringify(details, null, 2)}`;
    throw new Error(`${message}${suffix}`);
  }
}

const regressions = payload.regressions || {};
const requiredChecks = [
  'longHermesScrollback',
  'richHistoryTypingStability',
  'terminal56ScrollTyping',
  'typingNoFlicker',
  'mouseModeAndMobileLayout',
];
for (const check of requiredChecks) {
  assert(regressions[check], `UI stability agent required check is missing: ${check}`, Object.keys(regressions));
}

const rich = regressions.richHistoryTypingStability;
assert(rich.minLineCount >= rich.before.lineCount - 20, 'rich history collapsed during typing', rich);
assert(rich.minMaxScrollTop >= rich.before.maxScrollTop - 600, 'rich history scroll range collapsed during typing', rich);
assert(regressions.terminal56ScrollTyping.afterType.nearBottom === false, 'terminal56 history typing snapped reader to bottom', regressions.terminal56ScrollTyping);
assert(regressions.typingNoFlicker.firstWithMarker >= 0, 'typed marker never appeared in readable terminal samples', regressions.typingNoFlicker);
assert(
  regressions.typingNoFlicker.markerSampleCount >= regressions.typingNoFlicker.sampleCount - regressions.typingNoFlicker.firstWithMarker,
  'typing marker flickered out after it appeared in readable terminal samples',
  regressions.typingNoFlicker,
);

console.log(JSON.stringify({
  ok: true,
  agent: 'warpish-ui-stability-agent',
  durationMs: Date.now() - startedAt,
  browser: payload.browser,
  checks: {
    richHistoryTypingStability: rich,
    terminal56ScrollTyping: regressions.terminal56ScrollTyping,
    typingNoFlicker: regressions.typingNoFlicker,
    longHermesScrollback: regressions.longHermesScrollback,
    mouseModeAndMobileLayout: regressions.mouseModeAndMobileLayout,
  },
}, null, 2));
