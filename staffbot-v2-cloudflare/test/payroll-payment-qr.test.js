import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import {
  paymentQrObjectKey,
  readPayrollPaymentQr,
  saveTelegramPaymentQr
} from '../src/payroll-payment-qr.js';
import { createD1 } from './helpers/d1.js';

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

function paymentQrFixture(hooks = {}) {
  const database = canonicalDatabase();
  database.exec(`
    INSERT INTO stores (
      store_id, name, created_at, updated_at
    ) VALUES (
      'STORE-1', 'Store',
      '2026-07-01T00:00:00.000Z',
      '2026-07-01T00:00:00.000Z'
    );
    INSERT INTO store_members (
      store_id, telegram_id, display_name, role, status,
      cycle_start, joined_at, updated_at
    ) VALUES
      (
        'STORE-1', 'EMP-1', 'Employee', 'employee', 'active',
        '2026-07-01T00:00:00.000Z',
        '2026-07-01T00:00:00.000Z',
        '2026-07-01T00:00:00.000Z'
      ),
      (
        'STORE-1', 'ADMIN-1', 'Admin', 'admin', 'active',
        '2026-07-01T00:00:00.000Z',
        '2026-07-01T00:00:00.000Z',
        '2026-07-01T00:00:00.000Z'
      );
    INSERT INTO payroll_disbursements (
      payroll_id, store_id, telegram_id, payroll_start_date,
      scheduled_date, cycle_day, period_start, cutoff_at,
      amount_snapshot_micros, currency, status,
      accepts_bank, accepts_usdt, accepts_cash,
      bank_micros, usdt_micros, cash_micros,
      created_at, updated_at
    ) VALUES (
      'PAYROLL-1', 'STORE-1', 'EMP-1', '2026-07-01',
      '2026-07-16', 16,
      '2026-07-01T00:00:00.000Z',
      '2026-07-16T03:00:00.000Z',
      8000000000000, '₫', 'awaiting_admin_payment',
      1, 1, 0, 0, 0, 0,
      '2026-07-16T03:00:00.000Z',
      '2026-07-16T03:00:00.000Z'
    );
  `);
  const objects = new Map();
  const puts = [];
  const deletes = [];
  const bucket = {
    async head(key) {
      return objects.has(key) ? { key } : null;
    },
    async put(key, value, options) {
      puts.push(key);
      objects.set(key, { body: value, options });
      return { key, size: value.byteLength };
    },
    async get(key) {
      const saved = objects.get(key);
      if (!saved) return null;
      return {
        body: saved.body,
        httpEtag: '"qr-etag"',
        writeHttpMetadata(headers) {
          headers.set(
            'content-type',
            saved.options.httpMetadata.contentType
          );
        }
      };
    },
    async delete(key) {
      deletes.push(key);
      objects.delete(key);
    }
  };
  return {
    database,
    puts,
    deletes,
    objects,
    env: {
      DB: createD1(database, hooks),
      PAYROLL_PROOFS: bucket,
      BOT_TOKEN: 'test-token',
      ENVIRONMENT: 'production'
    }
  };
}

async function withTelegramJpeg(run) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('/getFile')) {
      return {
        async json() {
          return {
            ok: true,
            result: { file_path: 'photos/usdt-qr.jpg' }
          };
        }
      };
    }
    return new Response(new Uint8Array([1, 2, 3, 4]), {
      headers: { 'content-type': 'image/jpeg' }
    });
  };
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
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

test('builds a private QR object key from its owner', () => {
  assert.equal(
    paymentQrObjectKey(
      { store_id: 'STORE 1', telegram_id: 'EMP/1' },
      'QR-1',
      'jpg'
    ),
    'payroll-payment-qr/STORE%201/EMP%2F1/QR-1.jpg'
  );
});

test('stores immutable QR versions and updates only the editable payroll', async () => {
  const fixture = paymentQrFixture();
  try {
    const first = await withTelegramJpeg(() =>
      saveTelegramPaymentQr(
        fixture.env,
        'EMP-1',
        'PAYROLL-1',
        {
          accepts_bank: true,
          accepts_usdt: true,
          accepts_cash: false,
          bank_details: 'BANK-1234',
          usdt_details: ''
        },
        [{ file_id: 'TELEGRAM-QR-1', file_size: 4 }],
        new Date('2026-07-16T04:00:00.000Z')
      )
    );
    const second = await withTelegramJpeg(() =>
      saveTelegramPaymentQr(
        fixture.env,
        'EMP-1',
        'PAYROLL-1',
        {
          accepts_bank: true,
          accepts_usdt: true,
          accepts_cash: false,
          bank_details: 'BANK-1234',
          usdt_details: 'TADDRESS'
        },
        [{ file_id: 'TELEGRAM-QR-2', file_size: 4 }],
        new Date('2026-07-16T04:05:00.000Z')
      )
    );

    assert.equal(first.amount_snapshot_micros, 8_000_000_000_000);
    assert.equal(second.amount_snapshot_micros, 8_000_000_000_000);
    assert.notEqual(first.usdt_qr_id_snapshot, second.usdt_qr_id_snapshot);
    assert.equal(fixture.puts.length, 2);
    assert.equal(fixture.objects.size, 2);
    assert.deepEqual(
      fixture.database.prepare(`
        SELECT qr_id, superseded_at
        FROM payroll_payment_qr_codes
        ORDER BY uploaded_at
      `).all().map((row) => ({
        qr_id: row.qr_id,
        active: row.superseded_at === null
      })),
      [
        { qr_id: first.usdt_qr_id_snapshot, active: false },
        { qr_id: second.usdt_qr_id_snapshot, active: true }
      ]
    );
    assert.equal(
      fixture.database.prepare(`
        SELECT usdt_qr_id
        FROM payroll_payment_profiles
        WHERE store_id = 'STORE-1'
          AND telegram_id = 'EMP-1'
      `).get().usdt_qr_id,
      second.usdt_qr_id_snapshot
    );
  } finally {
    fixture.database.close();
  }
});

test('deletes a new QR object when its database batch fails', async () => {
  const fixture = paymentQrFixture({
    beforeBatchStatement(sql) {
      if (/INSERT INTO payroll_payment_profiles/.test(sql)) {
        throw new Error('profile write failed');
      }
    }
  });
  try {
    await assert.rejects(
      withTelegramJpeg(() =>
        saveTelegramPaymentQr(
          fixture.env,
          'EMP-1',
          'PAYROLL-1',
          {
            accepts_bank: false,
            accepts_usdt: true,
            accepts_cash: false,
            usdt_details: ''
          },
          [{ file_id: 'TELEGRAM-QR', file_size: 4 }]
        )
      ),
      /profile write failed/
    );
    assert.equal(fixture.puts.length, 1);
    assert.equal(fixture.deletes[0], fixture.puts[0]);
    assert.equal(fixture.objects.size, 0);
    assert.equal(
      fixture.database.prepare(`
        SELECT COUNT(*) AS count
        FROM payroll_payment_qr_codes
      `).get().count,
      0
    );
  } finally {
    fixture.database.close();
  }
});

test('locks QR changes and serves the snapshot only to authorized users', async () => {
  const fixture = paymentQrFixture();
  try {
    const saved = await withTelegramJpeg(() =>
      saveTelegramPaymentQr(
        fixture.env,
        'EMP-1',
        'PAYROLL-1',
        {
          accepts_bank: false,
          accepts_usdt: true,
          accepts_cash: false,
          usdt_details: ''
        },
        [{ file_id: 'TELEGRAM-QR', file_size: 4 }]
      )
    );

    assert.equal(
      (await readPayrollPaymentQr(
        fixture.env,
        { telegram_id: 'EMP-1' },
        saved.payroll_id
      )).status,
      200
    );
    assert.equal(
      (await readPayrollPaymentQr(
        fixture.env,
        { telegram_id: 'ADMIN-1', store_id: 'STORE-1' },
        saved.payroll_id
      )).status,
      200
    );
    assert.equal(
      (await readPayrollPaymentQr(
        fixture.env,
        { telegram_id: 'OTHER' },
        saved.payroll_id
      )).status,
      403
    );

    fixture.database.exec(`
      UPDATE payroll_disbursements
      SET current_admin_id = 'ADMIN-1'
      WHERE payroll_id = 'PAYROLL-1'
    `);
    await assert.rejects(
      withTelegramJpeg(() =>
        saveTelegramPaymentQr(
          fixture.env,
          'EMP-1',
          'PAYROLL-1',
          {
            accepts_bank: false,
            accepts_usdt: true,
            accepts_cash: false,
            usdt_details: ''
          },
          [{ file_id: 'NEW-QR', file_size: 4 }]
        )
      ),
      /payroll payment details are locked/
    );
    assert.equal(fixture.puts.length, 1);
  } finally {
    fixture.database.close();
  }
});
