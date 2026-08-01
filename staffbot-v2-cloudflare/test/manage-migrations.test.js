import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const schema = readFileSync(
  new URL('../db/schema.sql', import.meta.url),
  'utf8'
);
const migration021 = readFileSync(
  new URL('../db/migrations/021_personal_payroll_cycle.sql', import.meta.url),
  'utf8'
);
const migration022 = readFileSync(
  new URL('../db/migrations/022_usdt_payment_qr.sql', import.meta.url),
  'utf8'
);
const migration024 = readFileSync(
  new URL('../db/migrations/024_payroll_payment_attempts.sql', import.meta.url),
  'utf8'
);

function legacyPayrollDatabase() {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE store_members (
      store_id TEXT NOT NULL,
      telegram_id TEXT NOT NULL,
      display_name TEXT,
      role TEXT NOT NULL DEFAULT 'employee',
      status TEXT NOT NULL DEFAULT 'active',
      commission_rate REAL NOT NULL DEFAULT 0.6,
      cycle_start TEXT NOT NULL,
      joined_at TEXT NOT NULL,
      absence_check_enabled INTEGER NOT NULL DEFAULT 1,
      absence_check_enabled_at TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (store_id, telegram_id)
    );
  `);
  database.exec(migration021);
  database.exec(migration022);
  return database;
}

test('canonical schema enforces manage CSRF and leased claims', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(schema);
  const sessionColumns = db.prepare(`
    PRAGMA table_info(admin_sessions)
  `).all().map((column) => column.name);
  assert.ok(sessionColumns.includes('csrf_token'));
  db.prepare(`
    INSERT INTO admin_task_claims (
      task_type, task_id, store_id, claimed_by,
      claimed_at, lease_expires_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    'payroll', 'PAYROLL-1', 'STORE-1', 'ADMIN-1',
    '2026-08-01T00:00:00.000Z',
    '2026-08-01T00:15:00.000Z',
    '2026-08-01T00:00:00.000Z'
  );
  assert.throws(() => db.prepare(`
    INSERT INTO admin_task_claims (
      task_type, task_id, store_id, claimed_by,
      claimed_at, lease_expires_at, updated_at
    ) VALUES ('unknown', 'TASK-2', 'STORE-1', 'ADMIN-1', ?, ?, ?)
  `).run(
    '2026-08-01T00:00:00.000Z',
    '2026-08-01T00:15:00.000Z',
    '2026-08-01T00:00:00.000Z'
  ));
});

test('canonical schema enforces payment attempt states and unique identities', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(schema);
  const insertAttempt = db.prepare(`
    INSERT INTO payroll_payment_attempts (
      attempt_id, payroll_id, version, status,
      bank_micros, usdt_micros, cash_micros,
      idempotency_key_hash, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, ?)
  `);
  const timestamp = '2026-08-01T00:00:00.000Z';
  insertAttempt.run(
    'ATTEMPT-1', 'PAYROLL-1', 1, 'draft', 100,
    'HASH-1', timestamp, timestamp
  );
  assert.throws(() => insertAttempt.run(
    'ATTEMPT-2', 'PAYROLL-1', 1, 'submitted', 100,
    'HASH-2', timestamp, timestamp
  ), /UNIQUE constraint failed/);
  assert.throws(() => insertAttempt.run(
    'ATTEMPT-3', 'PAYROLL-1', 2, 'unknown', 100,
    'HASH-3', timestamp, timestamp
  ), /CHECK constraint failed/);
  assert.throws(() => insertAttempt.run(
    'ATTEMPT-4', 'PAYROLL-1', 2, 'draft', 100,
    'HASH-1', timestamp, timestamp
  ), /UNIQUE constraint failed/);
  assert.throws(() => insertAttempt.run(
    'ATTEMPT-5', 'PAYROLL-2', 1, 'draft', 0.5,
    null, timestamp, timestamp
  ), /CHECK constraint failed/);
  assert.throws(() => insertAttempt.run(
    'ATTEMPT-DRAFT-2', 'PAYROLL-1', 3, 'draft', 100,
    null, timestamp, timestamp
  ), /UNIQUE constraint failed/);
});

test('submitted payment evidence cannot be reopened or mutated', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(schema);
  const timestamp = '2026-08-01T00:00:00.000Z';
  db.prepare(`
    INSERT INTO payroll_payment_attempts (
      attempt_id, payroll_id, version, status,
      bank_micros, usdt_micros, cash_micros,
      submitted_by, submitted_at, idempotency_key_hash,
      created_at, updated_at
    ) VALUES (
      'ATTEMPT-LOCKED', 'PAYROLL-LOCKED', 1, 'draft',
      70, 20, 10, NULL, NULL, 'HASH-LOCKED', ?, ?
    )
  `).run(timestamp, timestamp);
  db.prepare(`
    UPDATE payroll_payment_attempts
    SET status = 'submitted',
        submitted_by = 'ADMIN-1',
        submitted_at = '2026-08-01T00:01:00.000Z',
        updated_at = '2026-08-01T00:01:00.000Z'
    WHERE attempt_id = 'ATTEMPT-LOCKED'
  `).run();

  for (const mutation of [
    `attempt_id = 'ATTEMPT-REWRITTEN'`,
    `payroll_id = 'PAYROLL-REWRITTEN'`,
    `version = 2`,
    `bank_micros = 69`,
    `usdt_micros = 21`,
    `cash_micros = 11`,
    `submitted_by = 'ADMIN-2'`,
    `submitted_at = '2026-08-01T00:02:00.000Z'`,
    `idempotency_key_hash = 'HASH-REWRITTEN'`
  ]) {
    assert.throws(() => db.exec(`
      UPDATE payroll_payment_attempts
      SET ${mutation}
      WHERE attempt_id = 'ATTEMPT-LOCKED';
    `), /payment attempt evidence is immutable/);
  }
  for (const status of ['draft', 'abandoned']) {
    assert.throws(() => db.prepare(`
      UPDATE payroll_payment_attempts
      SET status = ?, updated_at = ?
      WHERE attempt_id = 'ATTEMPT-LOCKED'
    `).run(status, '2026-08-01T00:03:00.000Z'),
    /invalid payment attempt status transition/);
  }

  db.prepare(`
    UPDATE payroll_payment_attempts
    SET status = 'employee_confirmed',
        employee_response = 'confirmed',
        employee_responded_at = '2026-08-01T00:04:00.000Z',
        updated_at = '2026-08-01T00:04:00.000Z'
    WHERE attempt_id = 'ATTEMPT-LOCKED'
  `).run();
  assert.throws(() => db.prepare(`
    UPDATE payroll_payment_attempts
    SET employee_responded_at = '2026-08-01T00:05:00.000Z'
    WHERE attempt_id = 'ATTEMPT-LOCKED'
  `).run(), /payment attempt response is immutable/);
});

test('payment attempt responses match status and abandoned drafts can recover', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(schema);
  const timestamp = '2026-08-01T00:00:00.000Z';
  assert.throws(() => db.prepare(`
    INSERT INTO payroll_payment_attempts (
      attempt_id, payroll_id, version, status,
      employee_response, created_at, updated_at
    ) VALUES (
      'BAD-RESPONSE', 'PAYROLL-BAD', 1, 'employee_confirmed',
      NULL, ?, ?
    )
  `).run(timestamp, timestamp), /CHECK constraint failed/);

  db.prepare(`
    INSERT INTO payroll_payment_attempts (
      attempt_id, payroll_id, version, status,
      bank_micros, created_at, updated_at
    ) VALUES (
      'RECOVERABLE', 'PAYROLL-RECOVERABLE', 1, 'draft',
      10, ?, ?
    )
  `).run(timestamp, timestamp);
  db.prepare(`
    UPDATE payroll_payment_attempts
    SET status = 'abandoned', updated_at = ?
    WHERE attempt_id = 'RECOVERABLE'
  `).run('2026-08-01T00:01:00.000Z');
  assert.throws(() => db.prepare(`
    UPDATE payroll_payment_attempts
    SET bank_micros = 20
    WHERE attempt_id = 'RECOVERABLE'
  `).run(), /payment attempt evidence is immutable/);
  db.prepare(`
    UPDATE payroll_payment_attempts
    SET status = 'draft', updated_at = ?
    WHERE attempt_id = 'RECOVERABLE'
  `).run('2026-08-01T00:02:00.000Z');
  db.prepare(`
    UPDATE payroll_payment_attempts
    SET bank_micros = 20, updated_at = ?
    WHERE attempt_id = 'RECOVERABLE'
  `).run('2026-08-01T00:03:00.000Z');
  assert.deepEqual(
    { ...db.prepare(`
      SELECT status, bank_micros
      FROM payroll_payment_attempts
      WHERE attempt_id = 'RECOVERABLE'
    `).get() },
    { status: 'draft', bank_micros: 20 }
  );

  db.prepare(`
    INSERT INTO payroll_payment_attempts (
      attempt_id, payroll_id, version, status,
      created_at, updated_at
    ) VALUES (
      'DISPUTABLE', 'PAYROLL-DISPUTABLE', 1, 'submitted', ?, ?
    )
  `).run(timestamp, timestamp);
  db.prepare(`
    UPDATE payroll_payment_attempts
    SET status = 'employee_disputed',
        employee_response = 'disputed',
        employee_responded_at = '2026-08-01T00:04:00.000Z',
        updated_at = '2026-08-01T00:04:00.000Z'
    WHERE attempt_id = 'DISPUTABLE'
  `).run();
  assert.equal(
    db.prepare(`
      SELECT status
      FROM payroll_payment_attempts
      WHERE attempt_id = 'DISPUTABLE'
    `).get().status,
    'employee_disputed'
  );
});

test('migration preserves existing admin sessions', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE admin_sessions (
      token TEXT PRIMARY KEY,
      telegram_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    INSERT INTO admin_sessions VALUES (
      'SESSION-1', 'ADMIN-1',
      '2099-01-01T00:00:00.000Z',
      '2026-07-01T00:00:00.000Z'
    );
  `);
  const migration023 = readFileSync(
    new URL(
      '../db/migrations/023_admin_manage_sessions_and_claims.sql',
      import.meta.url
    ),
    'utf8'
  );
  db.exec(migration023);
  assert.equal(
    db.prepare(`SELECT telegram_id FROM admin_sessions`).get().telegram_id,
    'ADMIN-1'
  );
  assert.equal(
    db.prepare(`SELECT csrf_token FROM admin_sessions`).get().csrf_token,
    null
  );
});

test('migration 024 backfills one immutable version and preserves proof metadata', () => {
  const database = legacyPayrollDatabase();
  database.exec(`
    INSERT INTO payroll_disbursements (
      payroll_id, store_id, telegram_id, payroll_start_date,
      scheduled_date, cycle_day, period_start, cutoff_at,
      amount_snapshot_micros, currency, status,
      accepts_bank, accepts_usdt, accepts_cash,
      bank_details_snapshot, usdt_details_snapshot, usdt_qr_id_snapshot,
      bank_micros, usdt_micros, cash_micros, current_admin_id,
      payment_sent_at, created_at, updated_at
    ) VALUES (
      'PAYROLL-1', 'STORE-1', 'EMP-1', '2026-07-01',
      '2026-07-16', 16, '2026-07-01T03:00:00.000Z',
      '2026-07-16T03:00:00.000Z', 100000000, '₫',
      'awaiting_employee_confirmation', 1, 1, 0,
      'BANK-DETAILS', 'USDT-DETAILS', 'QR-1',
      70000000, 30000000, 0, 'ADMIN-1',
      '2026-07-16T05:00:00.000Z',
      '2026-07-16T03:00:00.000Z',
      '2026-07-16T05:00:00.000Z'
    );
    INSERT INTO payroll_payment_proofs (
      proof_id, payroll_id, method, object_key, telegram_file_id,
      file_name, mime_type, size_bytes, sort_order, uploaded_by,
      superseded_at, uploaded_at
    ) VALUES (
      'PROOF-1', 'PAYROLL-1', 'bank',
      'payroll/STORE-1/PAYROLL-1/bank/PROOF-1.jpg', 'TG-FILE-1',
      'receipt.jpg', 'image/jpeg', 321, 1, 'ADMIN-1',
      '2026-07-16T05:30:00.000Z', '2026-07-16T04:00:00.000Z'
    );
  `);

  database.exec(migration024);
  database.exec(`
    DROP INDEX IF EXISTS idx_payroll_payment_attempts_one_draft;
  `);
  database.exec(migration024);

  assert.equal(database.prepare(`
    SELECT COUNT(*) AS total FROM sqlite_master
    WHERE type = 'index'
      AND name = 'idx_payroll_payment_attempts_one_draft'
  `).get().total, 1);

  assert.deepEqual(
    { ...database.prepare(`
      SELECT
        attempt_id, payroll_id, version, status,
        bank_micros, usdt_micros, cash_micros,
        submitted_by, submitted_at
      FROM payroll_payment_attempts
      WHERE payroll_id = 'PAYROLL-1'
    `).get() },
    {
      attempt_id: 'ATTEMPT:LEGACY:PAYROLL-1',
      payroll_id: 'PAYROLL-1',
      version: 1,
      status: 'submitted',
      bank_micros: 70_000_000,
      usdt_micros: 30_000_000,
      cash_micros: 0,
      submitted_by: 'ADMIN-1',
      submitted_at: '2026-07-16T05:00:00.000Z'
    }
  );
  assert.equal(
    database.prepare(`
      SELECT current_payment_attempt_id
      FROM payroll_disbursements
      WHERE payroll_id = 'PAYROLL-1'
    `).get().current_payment_attempt_id,
    'ATTEMPT:LEGACY:PAYROLL-1'
  );
  assert.deepEqual(
    { ...database.prepare(`
      SELECT
        attempt_id, payroll_id, method, object_key, telegram_file_id,
        file_name, mime_type, size_bytes, sort_order, uploaded_by,
        superseded_at, uploaded_at, telegram_delivered_at
      FROM payroll_payment_proofs
      WHERE proof_id = 'PROOF-1'
    `).get() },
    {
      attempt_id: 'ATTEMPT:LEGACY:PAYROLL-1',
      payroll_id: 'PAYROLL-1',
      method: 'bank',
      object_key: 'payroll/STORE-1/PAYROLL-1/bank/PROOF-1.jpg',
      telegram_file_id: 'TG-FILE-1',
      file_name: 'receipt.jpg',
      mime_type: 'image/jpeg',
      size_bytes: 321,
      sort_order: 1,
      uploaded_by: 'ADMIN-1',
      superseded_at: '2026-07-16T05:30:00.000Z',
      uploaded_at: '2026-07-16T04:00:00.000Z',
      telegram_delivered_at: '2026-07-16T05:00:00.000Z'
    }
  );
  assert.throws(() => database.prepare(`
    UPDATE payroll_payment_attempts
    SET bank_micros = 1
    WHERE attempt_id = 'ATTEMPT:LEGACY:PAYROLL-1'
  `).run(), /payment attempt evidence is immutable/);
});

test('migration 024 maps legacy statuses and backfills only evidenced payrolls', () => {
  const database = legacyPayrollDatabase();
  const insertPayroll = database.prepare(`
    INSERT INTO payroll_disbursements (
      payroll_id, store_id, telegram_id, payroll_start_date,
      scheduled_date, cycle_day, period_start, cutoff_at,
      amount_snapshot_micros, currency, status,
      bank_micros, usdt_micros, cash_micros,
      payment_sent_at, disputed_at, confirmed_at,
      created_at, updated_at
    ) VALUES (
      :payroll_id, 'STORE-1', :telegram_id, '2026-07-01',
      :scheduled_date, :cycle_day, '2026-07-01T03:00:00.000Z',
      :cutoff_at, 100000000, '₫', :status,
      :bank_micros, 0, 0, :payment_sent_at, :disputed_at, :confirmed_at,
      '2026-07-16T03:00:00.000Z', :updated_at
    )
  `);
  const rows = [
    {
      payroll_id: 'CONFIRMED', telegram_id: 'EMP-1',
      scheduled_date: '2026-07-16', cycle_day: 16,
      cutoff_at: '2026-07-16T03:00:00.000Z', status: 'confirmed',
      bank_micros: 100_000_000,
      payment_sent_at: '2026-07-16T05:00:00.000Z',
      disputed_at: null, confirmed_at: '2026-07-16T06:00:00.000Z',
      updated_at: '2026-07-16T06:00:00.000Z'
    },
    {
      payroll_id: 'DISPUTED', telegram_id: 'EMP-2',
      scheduled_date: '2026-07-16', cycle_day: 16,
      cutoff_at: '2026-07-16T03:00:00.000Z', status: 'disputed',
      bank_micros: 0, payment_sent_at: null,
      disputed_at: '2026-07-16T06:30:00.000Z', confirmed_at: null,
      updated_at: '2026-07-16T06:30:00.000Z'
    },
    {
      payroll_id: 'AWAITING-CONFIRMATION', telegram_id: 'EMP-3',
      scheduled_date: '2026-07-16', cycle_day: 16,
      cutoff_at: '2026-07-16T03:00:00.000Z',
      status: 'awaiting_employee_confirmation', bank_micros: 0,
      payment_sent_at: null, disputed_at: null, confirmed_at: null,
      updated_at: '2026-07-16T05:00:00.000Z'
    },
    {
      payroll_id: 'UNSTARTED', telegram_id: 'EMP-4',
      scheduled_date: '2026-07-16', cycle_day: 16,
      cutoff_at: '2026-07-16T03:00:00.000Z',
      status: 'awaiting_admin_payment', bank_micros: 0,
      payment_sent_at: null, disputed_at: null, confirmed_at: null,
      updated_at: '2026-07-16T03:00:00.000Z'
    },
    {
      payroll_id: 'PROOF-ONLY', telegram_id: 'EMP-5',
      scheduled_date: '2026-07-16', cycle_day: 16,
      cutoff_at: '2026-07-16T03:00:00.000Z',
      status: 'awaiting_admin_payment', bank_micros: 0,
      payment_sent_at: null, disputed_at: null, confirmed_at: null,
      updated_at: '2026-07-16T04:00:00.000Z'
    }
  ];
  for (const row of rows) insertPayroll.run(row);
  database.exec(`
    INSERT INTO payroll_payment_proofs (
      proof_id, payroll_id, method, object_key, telegram_file_id,
      mime_type, size_bytes, sort_order, uploaded_by, uploaded_at
    ) VALUES (
      'PROOF-ONLY-1', 'PROOF-ONLY', 'cash', 'proof-only', 'TG-PROOF',
      'image/png', 10, 1, 'ADMIN-1', '2026-07-16T04:00:00.000Z'
    );
  `);

  database.exec(migration024);

  assert.deepEqual(
    database.prepare(`
      SELECT payroll_id, status, employee_response, employee_responded_at
      FROM payroll_payment_attempts
      ORDER BY payroll_id
    `).all().map((row) => ({ ...row })),
    [
      {
        payroll_id: 'AWAITING-CONFIRMATION', status: 'submitted',
        employee_response: null, employee_responded_at: null
      },
      {
        payroll_id: 'CONFIRMED', status: 'employee_confirmed',
        employee_response: 'confirmed',
        employee_responded_at: '2026-07-16T06:00:00.000Z'
      },
      {
        payroll_id: 'DISPUTED', status: 'employee_disputed',
        employee_response: 'disputed',
        employee_responded_at: '2026-07-16T06:30:00.000Z'
      },
      {
        payroll_id: 'PROOF-ONLY', status: 'submitted',
        employee_response: null, employee_responded_at: null
      }
    ]
  );
  assert.equal(
    database.prepare(`
      SELECT current_payment_attempt_id
      FROM payroll_disbursements
      WHERE payroll_id = 'UNSTARTED'
    `).get().current_payment_attempt_id,
    null
  );
  assert.deepEqual(
    { ...database.prepare(`
      SELECT attempt_id, telegram_delivered_at
      FROM payroll_payment_proofs
      WHERE proof_id = 'PROOF-ONLY-1'
    `).get() },
    {
      attempt_id: 'ATTEMPT:LEGACY:PROOF-ONLY',
      telegram_delivered_at: null
    }
  );
});

test('migration 024 is repeatable without duplicating attempts or proofs', () => {
  const database = legacyPayrollDatabase();
  database.exec(`
    INSERT INTO payroll_disbursements (
      payroll_id, store_id, telegram_id, payroll_start_date,
      scheduled_date, cycle_day, period_start, cutoff_at,
      amount_snapshot_micros, currency, status,
      bank_micros, usdt_micros, cash_micros,
      created_at, updated_at
    ) VALUES (
      'PAYROLL-1', 'STORE-1', 'EMP-1', '2026-07-01',
      '2026-07-16', 16, '2026-07-01T03:00:00.000Z',
      '2026-07-16T03:00:00.000Z', 100000000, '₫',
      'awaiting_admin_payment', 100000000, 0, 0,
      '2026-07-16T03:00:00.000Z', '2026-07-16T03:00:00.000Z'
    );
  `);

  database.exec(migration024);
  database.exec(migration024);

  assert.equal(
    database.prepare(`SELECT COUNT(*) AS total FROM payroll_payment_attempts`)
      .get().total,
    1
  );
  assert.equal(
    database.prepare(`SELECT COUNT(*) AS total FROM payroll_disbursements`)
      .get().total,
    1
  );
  assert.equal(
    database.prepare(`SELECT COUNT(*) AS total FROM payroll_payment_proofs`)
      .get().total,
    0
  );
});

test('migration 024 raw replay preserves post-feature attempt references', () => {
  const database = legacyPayrollDatabase();
  database.exec(`
    INSERT INTO payroll_disbursements (
      payroll_id, store_id, telegram_id, payroll_start_date,
      scheduled_date, cycle_day, period_start, cutoff_at,
      amount_snapshot_micros, currency, status,
      bank_micros, usdt_micros, cash_micros,
      payment_sent_at, created_at, updated_at
    ) VALUES (
      'PAYROLL-1', 'STORE-1', 'EMP-1', '2026-07-01',
      '2026-07-16', 16, '2026-07-01T03:00:00.000Z',
      '2026-07-16T03:00:00.000Z', 100000000, '₫',
      'awaiting_employee_confirmation', 70000000, 30000000, 0,
      '2026-07-16T05:00:00.000Z',
      '2026-07-16T03:00:00.000Z', '2026-07-16T05:00:00.000Z'
    );
    INSERT INTO payroll_payment_proofs (
      proof_id, payroll_id, method, object_key, telegram_file_id,
      mime_type, size_bytes, sort_order, uploaded_by, uploaded_at
    ) VALUES (
      'LEGACY-PROOF', 'PAYROLL-1', 'bank', 'legacy-proof', 'TG-LEGACY',
      'image/jpeg', 10, 1, 'ADMIN-1', '2026-07-16T04:00:00.000Z'
    );
  `);
  database.exec(migration024);
  database.exec(`
    UPDATE payroll_payment_proofs
    SET telegram_file_id = 'TG-LEGACY-UPDATED',
        telegram_delivered_at = '2026-07-16T07:00:00.000Z'
    WHERE proof_id = 'LEGACY-PROOF';
    INSERT INTO payroll_payment_attempts (
      attempt_id, payroll_id, version, status,
      bank_micros, usdt_micros, cash_micros,
      idempotency_key_hash, created_at, updated_at
    ) VALUES (
      'ATTEMPT-V2', 'PAYROLL-1', 2, 'draft',
      50000000, 50000000, 0, 'HASH-V2',
      '2026-07-16T06:00:00.000Z', '2026-07-16T06:00:00.000Z'
    );
    UPDATE payroll_disbursements
    SET current_payment_attempt_id = 'ATTEMPT-V2'
    WHERE payroll_id = 'PAYROLL-1';
    INSERT INTO payroll_payment_proofs (
      proof_id, payroll_id, attempt_id, method, object_key,
      telegram_file_id, telegram_delivered_at, file_name, mime_type,
      size_bytes, sort_order, uploaded_by, uploaded_at
    ) VALUES (
      'V2-PROOF', 'PAYROLL-1', 'ATTEMPT-V2', 'bank', 'v2-proof',
      NULL, NULL, 'v2-receipt.png', 'image/png', 20, 1, 'ADMIN-2',
      '2026-07-16T06:30:00.000Z'
    );
  `);

  database.exec(migration024);

  assert.deepEqual(
    database.prepare(`
      SELECT
        attempt_id, payroll_id, version, status,
        bank_micros, usdt_micros, cash_micros,
        idempotency_key_hash, created_at, updated_at
      FROM payroll_payment_attempts
      WHERE payroll_id = 'PAYROLL-1'
      ORDER BY version
    `).all().map((row) => ({ ...row })),
    [
      {
        attempt_id: 'ATTEMPT:LEGACY:PAYROLL-1',
        payroll_id: 'PAYROLL-1',
        version: 1,
        status: 'submitted',
        bank_micros: 70_000_000,
        usdt_micros: 30_000_000,
        cash_micros: 0,
        idempotency_key_hash: null,
        created_at: '2026-07-16T05:00:00.000Z',
        updated_at: '2026-07-16T05:00:00.000Z'
      },
      {
        attempt_id: 'ATTEMPT-V2',
        payroll_id: 'PAYROLL-1',
        version: 2,
        status: 'draft',
        bank_micros: 50_000_000,
        usdt_micros: 50_000_000,
        cash_micros: 0,
        idempotency_key_hash: 'HASH-V2',
        created_at: '2026-07-16T06:00:00.000Z',
        updated_at: '2026-07-16T06:00:00.000Z'
      }
    ]
  );
  assert.equal(
    database.prepare(`
      SELECT current_payment_attempt_id
      FROM payroll_disbursements
      WHERE payroll_id = 'PAYROLL-1'
    `).get().current_payment_attempt_id,
    'ATTEMPT-V2'
  );
  assert.deepEqual(
    database.prepare(`
      SELECT
        proof_id, payroll_id, attempt_id, method, object_key,
        telegram_file_id, telegram_delivered_at, file_name, mime_type,
        size_bytes, sort_order, uploaded_by, superseded_at, uploaded_at
      FROM payroll_payment_proofs
      ORDER BY proof_id
    `).all().map((row) => ({ ...row })),
    [
      {
        proof_id: 'LEGACY-PROOF',
        payroll_id: 'PAYROLL-1',
        attempt_id: 'ATTEMPT:LEGACY:PAYROLL-1',
        method: 'bank',
        object_key: 'legacy-proof',
        telegram_file_id: 'TG-LEGACY-UPDATED',
        telegram_delivered_at: '2026-07-16T07:00:00.000Z',
        file_name: null,
        mime_type: 'image/jpeg',
        size_bytes: 10,
        sort_order: 1,
        uploaded_by: 'ADMIN-1',
        superseded_at: null,
        uploaded_at: '2026-07-16T04:00:00.000Z'
      },
      {
        proof_id: 'V2-PROOF',
        payroll_id: 'PAYROLL-1',
        attempt_id: 'ATTEMPT-V2',
        method: 'bank',
        object_key: 'v2-proof',
        telegram_file_id: null,
        telegram_delivered_at: null,
        file_name: 'v2-receipt.png',
        mime_type: 'image/png',
        size_bytes: 20,
        sort_order: 1,
        uploaded_by: 'ADMIN-2',
        superseded_at: null,
        uploaded_at: '2026-07-16T06:30:00.000Z'
      }
    ]
  );
});
