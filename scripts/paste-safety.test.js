import '../public/paste-safety.js';

const prepare = globalThis.WarpishPasteSafety?.prepareTerminalPasteText;
const formatPreview = globalThis.WarpishPasteSafety?.formatMultilinePastePreview;

function assert(condition, message, details = undefined) {
  if (condition) return;
  const suffix = details === undefined ? '' : `\n${JSON.stringify(details, null, 2)}`;
  throw new Error(`${message}${suffix}`);
}

assert(typeof prepare === 'function', 'paste safety policy was not registered');
assert(typeof formatPreview === 'function', 'paste preview formatter was not registered');

const persian = 'این  متن می‌خواهد فاصله‌های  دقیق را حفظ کند\r\nخط دوم شامل ۱۲۳ است\r\n';
const plain = prepare(persian, { bracketedPasteMode: false });
assert(
  plain.text === 'این  متن می‌خواهد فاصله‌های  دقیق را حفظ کند خط دوم شامل ۱۲۳ است',
  'plain terminal paste changed Persian Unicode/spacing or retained an implicit submit',
  plain,
);
assert(!/[\r\n]/u.test(plain.text), 'plain terminal paste retained a submit byte', plain);
assert(plain.internalLineBreaks === 1 && plain.removedTrailingLineBreak, 'plain paste diagnostics are incorrect', plain);
assert(plain.requiresChoice && plain.multilineMode === 'single-line', 'plain multiline paste did not request an explicit choice', plain);

const explicitlyPreserved = prepare(persian, { bracketedPasteMode: false, multilineMode: 'preserve' });
assert(
  explicitlyPreserved.text === 'این  متن می‌خواهد فاصله‌های  دقیق را حفظ کند\nخط دوم شامل ۱۲۳ است',
  'explicit preserve-lines paste changed multiline content',
  explicitlyPreserved,
);
assert(explicitlyPreserved.multilineMode === 'preserve', 'preserve-lines mode was not reported', explicitlyPreserved);

const cancelled = prepare(persian, { bracketedPasteMode: false, multilineMode: 'cancel' });
assert(cancelled.text === '' && cancelled.multilineMode === 'cancel', 'cancelled paste still returned terminal input', cancelled);

const bracketed = prepare(persian, { bracketedPasteMode: true });
assert(
  bracketed.text === 'این  متن می‌خواهد فاصله‌های  دقیق را حفظ کند\nخط دوم شامل ۱۲۳ است',
  'bracketed paste did not preserve its internal line break',
  bracketed,
);
assert(!bracketed.text.endsWith('\n'), 'bracketed paste retained a trailing implicit submit', bracketed);

const trailingWhitespace = prepare('printf test\n  \n\t', { bracketedPasteMode: false });
assert(trailingWhitespace.text === 'printf test', 'trailing blank clipboard lines were not removed safely', trailingWhitespace);

const emptySubmit = prepare('\r\n', { bracketedPasteMode: false });
assert(emptySubmit.text === '' && emptySubmit.removedTrailingLineBreak, 'newline-only clipboard content was not neutralized', emptySubmit);

const bracketEscape = prepare('safe\x1b[201~\nrm -rf should-not-run\n', { bracketedPasteMode: true });
assert(!bracketEscape.text.includes('\x1b'), 'clipboard content can terminate bracketed paste early', bracketEscape);
assert(
  bracketEscape.text === 'safe[201~\nrm -rf should-not-run',
  'bracketed paste control stripping changed visible content unexpectedly',
  bracketEscape,
);
assert(bracketEscape.removedControlCharacters, 'removed terminal controls were not reported', bracketEscape);

const c1Escape = prepare('safe\u009b201~\nsecond line\n', { bracketedPasteMode: true });
assert(c1Escape.text === 'safe201~\nsecond line', 'C1 CSI can still inject terminal control behavior', c1Escape);

const unbracketedTab = prepare('printf\tvalue\n', { bracketedPasteMode: false });
assert(unbracketedTab.text === 'printf    value', 'unbracketed Tab can still trigger terminal completion', unbracketedTab);

const longPreviewSource = `FIRST_DANGEROUS_COMMAND\n${'middle\n'.repeat(1000)}LAST_DANGEROUS_COMMAND`;
const longPreview = formatPreview(longPreviewSource, 400);
assert(longPreview.includes('FIRST_DANGEROUS_COMMAND'), 'truncated preview hid the beginning of the paste', longPreview);
assert(longPreview.includes('LAST_DANGEROUS_COMMAND'), 'truncated preview hid the end of the paste', longPreview);
assert(longPreview.includes('PREVIEW TRUNCATED') && longPreview.includes('lines'), 'truncated preview omitted its risk warning/counts', longPreview);

console.log('paste-safety: multiline, Unicode, spacing, and explicit-submit guards passed');
