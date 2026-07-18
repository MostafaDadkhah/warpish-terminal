import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

const SCHEMA_VERSION = 1;

function defaultMetadata() {
  return { sessions: {}, nextIndex: 1 };
}

function normalizeMetadata(meta) {
  if (!meta || typeof meta !== 'object') return defaultMetadata();
  if (!meta.sessions || typeof meta.sessions !== 'object' || Array.isArray(meta.sessions)) meta.sessions = {};
  const nextIndex = Number(meta.nextIndex);
  meta.nextIndex = Number.isFinite(nextIndex) && nextIndex > 0
    ? Math.floor(nextIndex)
    : Object.keys(meta.sessions).length + 1;
  for (const [id, record] of Object.entries(meta.sessions)) {
    if (!record || typeof record !== 'object') {
      delete meta.sessions[id];
      continue;
    }
    record.id = record.id || id;
    if (!Array.isArray(record.blocks)) record.blocks = [];
  }
  return meta;
}

function databaseRecord(row) {
  return {
    id: row.id,
    title: row.title,
    cwd: row.cwd,
    createdAt: row.created_at,
    lastOpenedAt: row.last_opened_at || undefined,
    stoppedAt: row.stopped_at || undefined,
    lastPreview: row.last_preview || undefined,
    lastPreviewAt: row.last_preview_at || undefined,
    activeBlockId: row.active_block_id || undefined,
    blocks: [],
  };
}

function databaseBlock(row) {
  return {
    id: row.id,
    command: row.command || '',
    output: row.output || '',
    status: row.status || 'unknown',
    exitCode: row.exit_code ?? null,
    startedAt: row.started_at || null,
    endedAt: row.ended_at || null,
    durationMs: row.duration_ms ?? null,
  };
}

export function openStorage(databaseFile) {
  fs.mkdirSync(path.dirname(databaseFile), { recursive: true, mode: 0o700 });
  const database = new Database(databaseFile);
  try { fs.chmodSync(databaseFile, 0o600); } catch {}
  database.pragma('foreign_keys = ON');
  database.pragma('busy_timeout = 5000');
  database.pragma('journal_mode = WAL');
  database.pragma('synchronous = FULL');
  database.exec(`
    CREATE TABLE IF NOT EXISTS app_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      cwd TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_opened_at TEXT,
      stopped_at TEXT,
      last_preview TEXT,
      last_preview_at TEXT,
      active_block_id TEXT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS blocks (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL,
      command TEXT NOT NULL DEFAULT '',
      output TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'unknown',
      exit_code INTEGER,
      started_at TEXT,
      ended_at TEXT,
      duration_ms INTEGER
    ) STRICT;

    CREATE INDEX IF NOT EXISTS blocks_session_ordinal
      ON blocks(session_id, ordinal);

    CREATE TABLE IF NOT EXISTS shell_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      processed_at TEXT
    ) STRICT;

    CREATE INDEX IF NOT EXISTS shell_events_pending
      ON shell_events(session_id, id) WHERE processed_at IS NULL;
  `);
  database.pragma(`user_version = ${SCHEMA_VERSION}`);

  const selectState = database.prepare('SELECT value FROM app_state WHERE key = ?');
  const upsertState = database.prepare(`
    INSERT INTO app_state (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
  const selectSessions = database.prepare('SELECT * FROM sessions ORDER BY created_at, id');
  const selectBlocks = database.prepare('SELECT * FROM blocks ORDER BY session_id, ordinal');
  const selectSessionIds = database.prepare('SELECT id FROM sessions');
  const deleteSession = database.prepare('DELETE FROM sessions WHERE id = ?');
  const upsertSession = database.prepare(`
    INSERT INTO sessions (
      id, title, cwd, created_at, last_opened_at, stopped_at,
      last_preview, last_preview_at, active_block_id
    ) VALUES (
      @id, @title, @cwd, @createdAt, @lastOpenedAt, @stoppedAt,
      @lastPreview, @lastPreviewAt, @activeBlockId
    )
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      cwd = excluded.cwd,
      created_at = excluded.created_at,
      last_opened_at = excluded.last_opened_at,
      stopped_at = excluded.stopped_at,
      last_preview = excluded.last_preview,
      last_preview_at = excluded.last_preview_at,
      active_block_id = excluded.active_block_id
  `);
  const deleteBlocks = database.prepare('DELETE FROM blocks WHERE session_id = ?');
  const insertBlock = database.prepare(`
    INSERT INTO blocks (
      id, session_id, ordinal, command, output, status,
      exit_code, started_at, ended_at, duration_ms
    ) VALUES (
      @id, @sessionId, @ordinal, @command, @output, @status,
      @exitCode, @startedAt, @endedAt, @durationMs
    )
  `);
  const selectPendingEvents = database.prepare(`
    SELECT id, payload
    FROM shell_events
    WHERE session_id = ? AND processed_at IS NULL
    ORDER BY id
    LIMIT ?
  `);
  const markEventProcessed = database.prepare(`
    UPDATE shell_events
    SET processed_at = CURRENT_TIMESTAMP
    WHERE id = ? AND processed_at IS NULL
  `);
  const insertShellEvent = database.prepare(`
    INSERT INTO shell_events (session_id, payload)
    VALUES (?, ?)
  `);
  const deleteShellEvents = database.prepare('DELETE FROM shell_events WHERE session_id = ?');
  const pruneProcessedEvents = database.prepare(`
    DELETE FROM shell_events
    WHERE processed_at IS NOT NULL
      AND id NOT IN (
        SELECT id FROM shell_events
        WHERE session_id = ?
        ORDER BY id DESC
        LIMIT ?
      )
      AND session_id = ?
  `);

  const persistMetadata = database.transaction((input) => {
    const meta = normalizeMetadata(input);
    const retained = new Set(Object.keys(meta.sessions));
    for (const { id } of selectSessionIds.all()) {
      if (!retained.has(id)) deleteSession.run(id);
    }

    for (const [id, rawRecord] of Object.entries(meta.sessions)) {
      const record = rawRecord || {};
      upsertSession.run({
        id,
        title: String(record.title || id),
        cwd: String(record.cwd || ''),
        createdAt: String(record.createdAt || new Date().toISOString()),
        lastOpenedAt: record.lastOpenedAt || null,
        stoppedAt: record.stoppedAt || null,
        lastPreview: record.lastPreview || null,
        lastPreviewAt: record.lastPreviewAt || null,
        activeBlockId: record.activeBlockId || null,
      });
      deleteBlocks.run(id);
      for (const [ordinal, rawBlock] of record.blocks.entries()) {
        const block = rawBlock || {};
        insertBlock.run({
          id: String(block.id || `${id}-${ordinal}`),
          sessionId: id,
          ordinal,
          command: String(block.command || ''),
          output: String(block.output || ''),
          status: String(block.status || 'unknown'),
          exitCode: block.exitCode !== null && block.exitCode !== undefined && Number.isFinite(Number(block.exitCode))
            ? Number(block.exitCode)
            : null,
          startedAt: block.startedAt || null,
          endedAt: block.endedAt || null,
          durationMs: block.durationMs !== null && block.durationMs !== undefined && Number.isFinite(Number(block.durationMs))
            ? Number(block.durationMs)
            : null,
        });
      }
    }
    upsertState.run('next_index', String(meta.nextIndex));
  });

  const markEventsProcessed = database.transaction((ids) => {
    for (const id of ids) markEventProcessed.run(id);
  });
  const importLegacyStorage = database.transaction((meta, events) => {
    persistMetadata(meta);
    for (const event of events) insertShellEvent.run(event.sessionId, event.payload);
    upsertState.run('legacy_storage_migrated_at', new Date().toISOString());
  });

  return {
    databaseFile,

    readMetadata() {
      const meta = defaultMetadata();
      for (const row of selectSessions.all()) meta.sessions[row.id] = databaseRecord(row);
      for (const row of selectBlocks.all()) {
        const record = meta.sessions[row.session_id];
        if (record) record.blocks.push(databaseBlock(row));
      }
      const nextIndex = Number(selectState.get('next_index')?.value);
      meta.nextIndex = Number.isFinite(nextIndex) && nextIndex > 0
        ? Math.floor(nextIndex)
        : Object.keys(meta.sessions).length + 1;
      return meta;
    },

    writeMetadata(meta) {
      persistMetadata(meta);
    },

    pendingEvents(sessionId, limit = 1000) {
      return selectPendingEvents.all(sessionId, Math.max(1, Math.min(Number(limit) || 1000, 5000)));
    },

    markEventsProcessed(ids) {
      if (ids.length) markEventsProcessed(ids);
    },

    appendShellEvent(sessionId, payload) {
      return Number(insertShellEvent.run(sessionId, payload).lastInsertRowid);
    },

    legacyMigrationCompleted() {
      return Boolean(selectState.get('legacy_storage_migrated_at')?.value);
    },

    importLegacyStorage(meta, events) {
      importLegacyStorage(normalizeMetadata(meta), events);
    },

    deleteShellEvents(sessionId) {
      deleteShellEvents.run(sessionId);
    },

    pruneProcessedEvents(sessionId, keep = 1000) {
      pruneProcessedEvents.run(sessionId, Math.max(0, Number(keep) || 0), sessionId);
    },

    check() {
      return database.prepare('PRAGMA quick_check').pluck().get() === 'ok';
    },

    close() {
      if (database.open) database.close();
    },
  };
}

export function migrateLegacyStorage(storage, { metadataFile, eventsDir }) {
  if (!fs.existsSync(metadataFile)) return null;

  let importedSessions = 0;
  let importedBlocks = 0;
  let importedEvents = 0;
  if (!storage.legacyMigrationCompleted()) {
    const meta = normalizeMetadata(JSON.parse(fs.readFileSync(metadataFile, 'utf8')));
    const events = [];
    for (const [sessionId, record] of Object.entries(meta.sessions)) {
      importedSessions += 1;
      importedBlocks += record.blocks.length;
      const eventFile = path.join(eventsDir, `${sessionId}.events`);
      let contents = '';
      try { contents = fs.readFileSync(eventFile, 'utf8'); } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      for (const line of contents.split('\n')) {
        const payload = line.trim();
        if (payload) events.push({ sessionId, payload });
      }
      delete record.eventFile;
    }
    importedEvents = events.length;
    storage.importLegacyStorage(meta, events);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const archiveDir = path.join(path.dirname(metadataFile), `legacy-storage-${stamp}`);
  fs.mkdirSync(archiveDir, { recursive: true, mode: 0o700 });
  fs.renameSync(metadataFile, path.join(archiveDir, path.basename(metadataFile)));
  if (fs.existsSync(eventsDir)) fs.renameSync(eventsDir, path.join(archiveDir, path.basename(eventsDir)));
  return { archiveDir, importedSessions, importedBlocks, importedEvents };
}
