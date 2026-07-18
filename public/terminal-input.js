(function registerWarpishTerminalInput(root) {
  const MAX_MESSAGE_BYTES = 64 * 1024;
  const MAX_PENDING_BYTES = 1024 * 1024;
  const encoder = new TextEncoder();

  function normalizeKind(kind) {
    return kind === 'binary' ? 'binary' : 'text';
  }

  function byteLength(kind, data) {
    const value = String(data || '');
    return normalizeKind(kind) === 'binary' ? value.length : encoder.encode(value).byteLength;
  }

  function splitText(value, maxBytes) {
    const chunks = [];
    let parts = [];
    let bytes = 0;
    for (const symbol of value) {
      const symbolBytes = encoder.encode(symbol).byteLength;
      if (parts.length && bytes + symbolBytes > maxBytes) {
        chunks.push(parts.join(''));
        parts = [];
        bytes = 0;
      }
      parts.push(symbol);
      bytes += symbolBytes;
    }
    if (parts.length) chunks.push(parts.join(''));
    return chunks;
  }

  function splitInput(item = {}, maxBytes = MAX_MESSAGE_BYTES) {
    const kind = normalizeKind(item.kind);
    const data = String(item.data || '');
    if (!data) return [];
    const limit = Math.max(4, Math.min(Number(maxBytes) || MAX_MESSAGE_BYTES, MAX_MESSAGE_BYTES));
    const chunks = kind === 'binary'
      ? Array.from({ length: Math.ceil(data.length / limit) }, (_, index) => data.slice(index * limit, (index + 1) * limit))
      : splitText(data, limit);
    return chunks.map((chunk) => ({ ...item, kind, data: chunk }));
  }

  root.WarpishTerminalInput = Object.freeze({
    MAX_MESSAGE_BYTES,
    MAX_PENDING_BYTES,
    byteLength,
    splitInput,
  });
}(globalThis));
