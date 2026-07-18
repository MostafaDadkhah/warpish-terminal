import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { migrateLegacyStorage, openStorage } from '../storage.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'warpish-storage-test-'));
const dataDir = path.join(root, 'data');
const eventsDir = path.join(dataDir, 'events');
const metadataFile = path.join(dataDir, 'sessions.json');
const databaseFile = path.join(dataDir, 'warpish.sqlite3');
const sessionId = 'warpish-test-session';
fs.mkdirSync(eventsDir, { recursive: true });
fs.writeFileSync(metadataFile, JSON.stringify({
  nextIndex: 8,
  sessions: {
    [sessionId]: {
      id: sessionId,
      title: 'Migrated session',
      cwd: '/tmp',
      shell: '/bin/zsh',
      profile: 'development',
      createdAt: '2026-01-01T00:00:00.000Z',
      activeBlockId: `${sessionId}-running`,
      eventFile: path.join(eventsDir, `${sessionId}.events`),
      blocks: [{
        id: `${sessionId}-finished`,
        command: 'printf migrated',
        output: 'migrated',
        status: 'success',
        exitCode: 0,
        startedAt: '2026-01-01T00:00:01.000Z',
        endedAt: '2026-01-01T00:00:02.000Z',
        durationMs: 1000,
      }, {
        id: `${sessionId}-running`,
        command: 'sleep 1',
        output: '',
        status: 'running',
        exitCode: null,
        startedAt: '2026-01-01T00:00:03.000Z',
        endedAt: null,
        durationMs: null,
      }],
    },
  },
}, null, 2));
fs.writeFileSync(
  path.join(eventsDir, `${sessionId}.events`),
  `End;id=${sessionId}-running;ended=1767225604;status=0\n`,
);

let storage;
try {
  storage = openStorage(databaseFile);
  const migration = migrateLegacyStorage(storage, { metadataFile, eventsDir });
  assert(migration?.importedSessions === 1, 'legacy session was not imported');
  assert(migration?.importedBlocks === 2, 'legacy blocks were not imported');
  assert(migration?.importedEvents === 1, 'legacy shell event was not imported');
  assert(!fs.existsSync(metadataFile), 'active legacy JSON metadata remained after migration');
  assert(!fs.existsSync(eventsDir), 'active legacy event directory remained after migration');
  assert(fs.existsSync(path.join(migration.archiveDir, 'sessions.json')), 'legacy recovery copy was not archived');

  const migrated = storage.readMetadata();
  const migratedSession = migrated.sessions[sessionId];
  assert(migrated.nextIndex === 8, 'next session index was not migrated');
  assert(migratedSession?.blocks.length === 2, 'session block rows were not reconstructed');
  assert(migratedSession.shell === '/bin/zsh', 'session shell did not survive migration');
  assert(migratedSession.profile === 'development', 'session profile did not survive migration');
  assert(migratedSession.private === false, 'legacy session unexpectedly became private');
  assert(migratedSession.blocks[1].exitCode === null, 'nullable exit code changed during SQLite round trip');
  assert(migratedSession.blocks[1].durationMs === null, 'nullable duration changed during SQLite round trip');
  assert(storage.pendingEvents(sessionId).length === 1, 'legacy shell event is not pending in SQLite');

  const recordedPayload = `Start;id=${sessionId}-python;started=1767225605;command=cHJpbnRmIHB5dGhvbg==`;
  execFileSync('/usr/bin/python3', [
    path.join(fileURLToPath(new URL('..', import.meta.url)), 'scripts/record-shell-event.py'),
    '--database', databaseFile,
    '--session-id', sessionId,
    '--payload', recordedPayload,
  ]);
  assert(storage.pendingEvents(sessionId).some((row) => row.payload === recordedPayload), 'Python shell-event recorder did not write to SQLite');

  storage.writeMetadata(migrated);
  migratedSession.private = true;
  migratedSession.blocks.push({
    id: `${sessionId}-private`,
    command: 'printf secret',
    output: 'secret',
    status: 'success',
  });
  storage.writeMetadata(migrated);
  const privateRoundTrip = storage.readMetadata().sessions[sessionId];
  assert(privateRoundTrip.private === true, 'private session flag did not round trip');
  assert(privateRoundTrip.blocks.length === 0, 'private session persisted command blocks');
  assert(storage.check(), 'SQLite quick_check failed');
  console.log('storage: SQLite round trip, legacy migration, and shell-event recorder passed');
} finally {
  try { storage?.close(); } catch {}
  fs.rmSync(root, { recursive: true, force: true });
}
