import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const schema = readFileSync(
  new URL('../db/schema.sql', import.meta.url),
  'utf8'
);
const qrMigration = readFileSync(
  new URL(
    '../db/migrations/022_usdt_payment_qr.sql',
    import.meta.url
  ),
  'utf8'
);

function canonicalDatabase() {
  const database = new DatabaseSync(':memory:');
  database.exec(schema);
  return database;
}

function columnNames(database, table) {
  return database.prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((column) => column.name);
}

test('canonical schema stores versioned private USDT QR references', () => {
  const database = canonicalDatabase();

  assert.deepEqual(
    columnNames(database, 'payroll_payment_qr_codes'),
    [
      'qr_id',
      'store_id',
      'telegram_id',
      'object_key',
      'telegram_file_id',
      'mime_type',
      'size_bytes',
      'uploaded_at',
      'superseded_at'
    ]
  );
  assert.ok(
    columnNames(database, 'payroll_payment_profiles')
      .includes('usdt_qr_id')
  );
  assert.ok(
    columnNames(database, 'payroll_disbursements')
      .includes('usdt_qr_id_snapshot')
  );

  database.close();
});

test('migration preserves existing payment profiles and payrolls', () => {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE payroll_payment_profiles (
      store_id TEXT NOT NULL,
      telegram_id TEXT NOT NULL,
      accepts_bank INTEGER NOT NULL DEFAULT 0,
      accepts_usdt INTEGER NOT NULL DEFAULT 0,
      accepts_cash INTEGER NOT NULL DEFAULT 0,
      bank_details TEXT,
      usdt_details TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (store_id, telegram_id)
    );
    CREATE TABLE payroll_disbursements (
      payroll_id TEXT PRIMARY KEY,
      usdt_details_snapshot TEXT
    );
    INSERT INTO payroll_payment_profiles (
      store_id, telegram_id, usdt_details,
      created_at, updated_at
    ) VALUES (
      'STORE-1', 'EMP-1', 'TABC123',
      '2026-07-01T00:00:00.000Z',
      '2026-07-01T00:00:00.000Z'
    );
    INSERT INTO payroll_disbursements (
      payroll_id, usdt_details_snapshot
    ) VALUES ('PAYROLL-1', 'TABC123');
  `);

  database.exec(qrMigration);

  assert.equal(
    database.prepare(`
      SELECT usdt_qr_id
      FROM payroll_payment_profiles
      WHERE store_id = 'STORE-1'
        AND telegram_id = 'EMP-1'
    `).get().usdt_qr_id,
    null
  );
  assert.equal(
    database.prepare(`
      SELECT usdt_qr_id_snapshot
      FROM payroll_disbursements
      WHERE payroll_id = 'PAYROLL-1'
    `).get().usdt_qr_id_snapshot,
    null
  );

  database.close();
});

test('allows only one active QR version per employee', () => {
  const database = canonicalDatabase();
  const insertQr = database.prepare(`
    INSERT INTO payroll_payment_qr_codes (
      qr_id, store_id, telegram_id, object_key,
      telegram_file_id, mime_type, size_bytes, uploaded_at
    ) VALUES (?, 'STORE-1', 'EMP-1', ?, ?, 'image/jpeg', 4, ?)
  `);

  insertQr.run(
    'QR-1',
    'payroll-qr/STORE-1/EMP-1/QR-1.jpg',
    'TELEGRAM-1',
    '2026-07-01T00:00:00.000Z'
  );
  assert.throws(
    () => insertQr.run(
      'QR-2',
      'payroll-qr/STORE-1/EMP-1/QR-2.jpg',
      'TELEGRAM-2',
      '2026-07-02T00:00:00.000Z'
    ),
    /UNIQUE constraint failed/
  );

  database.prepare(`
    UPDATE payroll_payment_qr_codes
    SET superseded_at = '2026-07-02T00:00:00.000Z'
    WHERE qr_id = 'QR-1'
  `).run();
  assert.doesNotThrow(() => insertQr.run(
    'QR-2',
    'payroll-qr/STORE-1/EMP-1/QR-2.jpg',
    'TELEGRAM-2',
    '2026-07-02T00:00:00.000Z'
  ));

  database.close();
});
