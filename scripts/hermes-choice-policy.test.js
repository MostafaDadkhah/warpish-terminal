import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shellIntegration = path.join(projectRoot, 'scripts', 'warpish-shell-integration.zsh');
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'warpish-hermes-policy-'));
const fakeBin = path.join(testRoot, 'bin');
const fakeHermes = path.join(fakeBin, 'hermes');

fs.mkdirSync(fakeBin, { recursive: true });
fs.writeFileSync(fakeHermes, `#!/bin/zsh
command printf '%s' "\${HERMES_EPHEMERAL_SYSTEM_PROMPT:-}" > "\$WARPISH_TEST_PROMPT_FILE"
command printf '%s\\0' "\$@" > "\$WARPISH_TEST_ARGS_FILE"
`, { mode: 0o755 });

function invokeHermes(args = [], existingPrompt) {
  const promptFile = path.join(testRoot, `prompt-${crypto.randomUUID()}`);
  const argsFile = path.join(testRoot, `args-${crypto.randomUUID()}`);
  const env = {
    ...process.env,
    PATH: `${fakeBin}:${process.env.PATH || ''}`,
    WARPISH_TEST_PROMPT_FILE: promptFile,
    WARPISH_TEST_ARGS_FILE: argsFile,
  };
  delete env.HERMES_EPHEMERAL_SYSTEM_PROMPT;
  if (existingPrompt !== undefined) env.HERMES_EPHEMERAL_SYSTEM_PROMPT = existingPrompt;

  const result = spawnSync('/bin/zsh', [
    '-f',
    '-c',
    'source "$1"; shift; hermes "$@"',
    'warpish-hermes-policy-test',
    shellIntegration,
    ...args,
  ], {
    cwd: testRoot,
    encoding: 'utf8',
    env,
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const prompt = fs.readFileSync(promptFile, 'utf8');
  const rawArgs = fs.readFileSync(argsFile);
  const capturedArgs = rawArgs.length
    ? rawArgs.toString('utf8').split('\0').slice(0, -1)
    : [];
  if (capturedArgs.length === 1 && capturedArgs[0] === '') capturedArgs.length = 0;
  return { prompt, args: capturedArgs };
}

try {
  const defaultLaunch = invokeHermes();
  assert.deepEqual(defaultLaunch.args, []);
  assert.match(defaultLaunch.prompt, /\[warpish-terminal:clarify-choices:v2\]/);
  assert.match(defaultLaunch.prompt, /Warpish Terminal interaction contract:/);
  assert.match(defaultLaunch.prompt, /clarify tool/);
  assert.match(defaultLaunch.prompt, /2 to 4/);
  assert.match(defaultLaunch.prompt, /Never omit choices/);
  assert.match(defaultLaunch.prompt, /Other free-text row/);

  const explicitTui = invokeHermes(['--tui', '--resume', 'session-123'], 'Keep my existing host policy.');
  assert.deepEqual(explicitTui.args, ['--tui', '--resume', 'session-123']);
  assert.ok(explicitTui.prompt.startsWith('Keep my existing host policy.\n\n'));
  assert.equal((explicitTui.prompt.match(/\[warpish-terminal:clarify-choices:v2\]/g) || []).length, 1);

  const resumedCli = invokeHermes(['--resume', 'session with spaces']);
  assert.deepEqual(resumedCli.args, ['--resume', 'session with spaces']);

  const explicitCli = invokeHermes(['--cli', 'chat']);
  assert.deepEqual(explicitCli.args, ['--cli', 'chat']);

  const regularSubcommand = invokeHermes(['chat', 'literal * glob', 'line one\nline two']);
  assert.deepEqual(regularSubcommand.args, ['chat', 'literal * glob', 'line one\nline two']);

  const oneshot = invokeHermes(['--oneshot', 'question with spaces']);
  assert.deepEqual(oneshot.args, ['--oneshot', 'question with spaces']);

  const safeMode = invokeHermes(['chat', '--safe-mode']);
  assert.deepEqual(safeMode.args, ['chat', '--safe-mode']);
  assert.doesNotMatch(safeMode.prompt, /warpish-terminal:clarify-choices/);

  const alreadyInjected = invokeHermes(
    ['--version'],
    `${defaultLaunch.prompt}\n\nKeep this suffix too.`,
  );
  assert.deepEqual(alreadyInjected.args, ['--version']);
  assert.equal((alreadyInjected.prompt.match(/\[warpish-terminal:clarify-choices:v2\]/g) || []).length, 1);
  assert.match(alreadyInjected.prompt, /Keep this suffix too\.$/);

  console.log('Hermes choice policy tests passed.');
} finally {
  fs.rmSync(testRoot, { recursive: true, force: true });
}
