import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const manifestPath = path.join(projectRoot, 'contracts', 'regression-contracts.json');
const contracts = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const browserRegressionSource = fs.readFileSync(path.join(projectRoot, 'scripts', 'browser-regressions.js'), 'utf8');
const uiAgentSource = fs.readFileSync(path.join(projectRoot, 'scripts', 'ui-stability-agent.js'), 'utf8');
const allowedGates = new Set(['check', 'smoke', 'browser']);
const requiredContracts = new Set([
  'session.restart-resume',
  'session.close-exactly-one',
  'session.reload-resume',
  'input.large-ordered-utf8',
  'input.runtime-epoch-no-replay',
  'input.stale-output-isolation',
  'paste.session-affinity',
  'wheel.scrollback-not-shell-history',
  'ui.mobile-viewport-and-keys',
  'rtl.persian-end-cursor',
  'rtl.persian-middle-cursor',
  'rtl.mixed-trailing-space',
  'composer.v2-flag-and-logical-payload',
  'composer.v2-multiline-safe',
]);

function assert(condition, message, details = undefined) {
  if (condition) return;
  const suffix = details === undefined ? '' : `\n${JSON.stringify(details, null, 2)}`;
  throw new Error(`${message}${suffix}`);
}

assert(Array.isArray(contracts) && contracts.length >= requiredContracts.size,
  'regression contract manifest is missing or unexpectedly small');
const ids = contracts.map((contract) => contract.id);
assert(new Set(ids).size === ids.length, 'regression contract ids must be unique', ids);
for (const id of requiredContracts) {
  assert(ids.includes(id), `required regression contract was removed: ${id}`);
}

for (const contract of contracts) {
  assert(/^[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)+$/u.test(contract.id),
    'invalid regression contract id', contract);
  assert(typeof contract.behavior === 'string' && contract.behavior.length >= 30,
    'regression contract behavior is too vague', contract);
  assert(allowedGates.has(contract.gate), 'regression contract has an unknown gate', contract);
  const evidencePath = path.join(projectRoot, contract.evidenceFile || '');
  assert(evidencePath.startsWith(projectRoot + path.sep) && fs.existsSync(evidencePath),
    'regression contract evidence file does not exist', contract);
  const evidence = fs.readFileSync(evidencePath, 'utf8');
  assert(typeof contract.sentinel === 'string' && evidence.includes(contract.sentinel),
    'regression contract lost its executable evidence sentinel', contract);
  if (contract.gate === 'browser') {
    assert(typeof contract.resultKey === 'string' && contract.resultKey.length > 0,
      'browser regression contract is missing its result key', contract);
    assert(browserRegressionSource.includes(contract.resultKey) && uiAgentSource.includes(contract.resultKey),
      'browser regression contract is not produced and validated by the UI gate', contract);
  }
}

console.log(`regression-contracts: ${contracts.length} protected product behaviors mapped to executable evidence`);
