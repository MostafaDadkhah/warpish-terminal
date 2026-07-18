import '../public/terminal-input.js';

const input = globalThis.WarpishTerminalInput;

function assert(condition, message, detail = undefined) {
  if (condition) return;
  throw new Error(`${message}${detail === undefined ? '' : `\n${JSON.stringify(detail, null, 2)}`}`);
}

const persian = 'سلام🙂'.repeat(20_000);
const textChunks = input.splitInput({ kind: 'text', data: persian, sessionId: 'test' });
assert(textChunks.length > 1, 'large UTF-8 text was not split');
assert(textChunks.map((item) => item.data).join('') === persian, 'UTF-8 chunks did not round trip');
assert(textChunks.every((item) => input.byteLength(item.kind, item.data) <= input.MAX_MESSAGE_BYTES), 'UTF-8 chunk exceeded server byte limit');
assert(textChunks.every((item) => !/[\ud800-\udbff]$/u.test(item.data) && !/^[\udc00-\udfff]/u.test(item.data)), 'UTF-8 chunk split a surrogate pair');

const binary = String.fromCharCode(...Array.from({ length: 256 }, (_, value) => value)).repeat(600);
const binaryChunks = input.splitInput({ kind: 'binary', data: binary });
assert(binaryChunks.length > 1, 'large binary input was not split');
assert(binaryChunks.map((item) => item.data).join('') === binary, 'binary chunks did not round trip');
assert(binaryChunks.every((item) => item.data.length <= input.MAX_MESSAGE_BYTES), 'binary chunk exceeded server byte limit');

console.log('terminal-input: UTF-8 and binary byte-bounded chunking passed');
