import '../public/input-composer.js';

const composer = globalThis.WarpishInputComposer;

function assert(condition, message, details = undefined) {
  if (condition) return;
  const suffix = details === undefined ? '' : `\n${JSON.stringify(details, null, 2)}`;
  throw new Error(`${message}${suffix}`);
}

assert(composer, 'input composer API was not registered');
assert(composer.resolveInputExperience('').enabled === false,
  'raw xterm must remain the default input path');
assert(composer.resolveInputExperience('?input=v2').initialMode === 'composer',
  'input=v2 did not enable the composer path');
assert(composer.resolveInputExperience('?input=v2-raw').initialMode === 'raw',
  'input=v2-raw did not expose the immediate rollback path');
assert(composer.resolveInputExperience('?input=unknown').enabled === false,
  'an unknown feature flag enabled the composer');

const mixedDraft = 'سلام دنیا khari تو به ';
assert(composer.commandPayload(mixedDraft) === `${mixedDraft}\r`,
  'composer changed the logical mixed Persian/Latin command');
assert(composer.commandPayload('') === '\r',
  'empty composer submit must still send Enter');
assert(composer.commandPayload('first\nsecond\tpart\x07') === 'first second    part\r',
  'composer multiline or control characters bypassed single-command paste safety');
assert(composer.shouldSubmitKey({ key: 'Enter' }) === true,
  'plain Enter did not submit');
assert(composer.shouldSubmitKey({ key: 'Enter', shiftKey: true }) === false,
  'Shift+Enter incorrectly submitted');
assert(composer.shouldSubmitKey({ key: 'Enter', isComposing: true }) === false,
  'IME composition Enter incorrectly submitted');
assert(composer.shouldSubmitKey({ key: 'ArrowLeft' }) === false,
  'cursor editing key incorrectly submitted');

console.log('input-composer: feature flag, logical payload, multiline, and IME guards passed');
