import '../public/rtl-terminal-renderer.js';

const rtl = globalThis.WarpishRtlTerminal;

function assert(condition, message, details = undefined) {
  if (condition) return;
  const suffix = details === undefined ? '' : `\n${JSON.stringify(details, null, 2)}`;
  throw new Error(`${message}${suffix}`);
}

function cells(text) {
  return [...text].map((chars) => ({ chars, width: 1 }));
}

assert(rtl, 'RTL terminal renderer API was not registered');
assert(JSON.stringify(rtl.rtlCharacterJoinRanges('prompt سلام دنیا')) === JSON.stringify([[7, 16]]),
  'character joiner did not isolate the RTL suffix');
assert(rtl.rtlCharacterJoinRanges('plain ASCII').length === 0,
  'character joiner marked a plain LTR line as RTL');

const draft = '⚕ ❯ سلام دنیا';
const endRun = rtl.activeRtlRun(cells(draft), draft.length);
assert(endRun?.start === 4
  && endRun.end === draft.length
  && endRun.cursor === draft.length
  && endRun.visualCursorColumn === 0
  && endRun.text === 'سلام دنیا', 'end-of-line Persian cursor mapping is incorrect', endRun);

const middleRun = rtl.activeRtlRun(cells(draft), draft.length - 2);
assert(middleRun?.visualCursorColumn === 2
  && middleRun.text === 'سلام دنیا', 'middle-of-line Persian cursor was not mirrored visually', middleRun);

const mixed = '❯ سلام rtl ۱۲۳.';
const mixedRun = rtl.activeRtlRun(cells(mixed), mixed.length - 4);
assert(mixedRun?.text === 'سلام rtl ۱۲۳.'
  && mixedRun.visualCursorColumn === 4, 'mixed Persian/LTR/numeric draft lost its logical text or cursor mapping', mixedRun);

const trailingMixed = '❯ سلام دنیا khari تو به ';
const trailingMixedCells = cells(trailingMixed);
trailingMixedCells[trailingMixedCells.length - 1] = { chars: '', width: 1 };
const trailingMixedRun = rtl.activeRtlRun(trailingMixedCells, trailingMixed.length);
assert(trailingMixedRun?.text === 'سلام دنیا khari تو به'
  && trailingMixedRun.end === trailingMixed.length
  && trailingMixedRun.visualCursorColumn === 0,
  'trailing whitespace disabled end-of-line mixed RTL cursor mapping', trailingMixedRun);

const joinedSpan = { textContent: 'سلام دنیا khari تو به', previousElementSibling: null };
const trailingBlankSpan = { textContent: ' ', previousElementSibling: joinedSpan };
const cursorAfterBlank = { previousElementSibling: trailingBlankSpan };
assert(rtl.joinedRtlSpanBeforeCursor(cursorAfterBlank, trailingMixedRun.text) === joinedSpan,
  'a trailing blank span hid the joined RTL text from cursor reconciliation');
const interveningLtrSpan = { textContent: 'x', previousElementSibling: joinedSpan };
assert(rtl.joinedRtlSpanBeforeCursor({ previousElementSibling: interveningLtrSpan }, trailingMixedRun.text) === null,
  'cursor reconciliation crossed a nonblank LTR span');

const widePromptCells = [
  { chars: '🙂', width: 2 },
  { chars: '', width: 0 },
  { chars: ' ', width: 1 },
  ...cells('سلام'),
];
const widePromptRun = rtl.activeRtlRun(widePromptCells, widePromptCells.length);
assert(widePromptRun?.start === 3
  && widePromptRun.text === 'سلام', 'wide prompt cells shifted the RTL run boundary', widePromptRun);

assert(rtl.activeRtlRun(cells(draft), 2) === null,
  'RTL overlay activated while the cursor was still in the LTR prompt');
assert(rtl.activeRtlRun(cells('⚕ ❯ plain text'), 14) === null,
  'RTL overlay activated for a plain LTR input line');

console.log('rtl-terminal-renderer: join ranges, mixed text, wide prompts, and middle-cursor mapping passed');
