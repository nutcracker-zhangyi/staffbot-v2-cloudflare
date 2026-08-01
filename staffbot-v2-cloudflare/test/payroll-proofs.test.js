import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import {
  completePayrollProofs,
  proofCompletion,
  proofObjectKey,
  readPayrollProof,
  storeTelegramProof
} from '../src/payroll-proofs.js';
import { downloadTelegramImage } from '../src/telegram-images.js';
import { createD1 } from './helpers/d1.js';

const schema = readFileSync(
  new URL('../db/schema.sql', import.meta.url),
  'utf8'
);

function proofFixture() {
  const database = new DatabaseSync(':memory:');
  database.exec(schema);
  database.exec(`
    INSERT INTO stores (
      store_id, name, created_at, updated_at
    ) VALUES (
      'STORE-1', 'Store', '2026-07-01T00:00:00.000Z',
      '2026-07-01T00:00:00.000Z'
    );
    INSERT INTO store_members (
      store_id, telegram_id, display_name, role, status,
      cycle_start, joined_at, updated_at
    ) VALUES
      (
        'STORE-1', 'ADMIN-1', 'Admin', 'admin', 'active',
        '2026-07-01T00:00:00.000Z',
        '2026-07-01T00:00:00.000Z',
        '2026-07-01T00:00:00.000Z'
      ),
      (
        'STORE-1', 'EMP-1', 'Employee', 'employee', 'active',
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
      100000000, '₫', 'awaiting_admin_payment',
      1, 1, 0,
      70000000, 30000000, 0,
      '2026-07-16T03:00:00.000Z',
      '2026-07-16T03:00:00.000Z'
    );
    INSERT INTO payroll_payment_attempts (
      attempt_id, payroll_id, version, status,
      bank_micros, usdt_micros, cash_micros, created_at, updated_at
    ) VALUES (
      'ATTEMPT-CURRENT', 'PAYROLL-1', 1, 'draft',
      70000000, 30000000, 0,
      '2026-07-16T03:00:00.000Z', '2026-07-16T03:00:00.000Z'
    );
    UPDATE payroll_disbursements
    SET current_payment_attempt_id = 'ATTEMPT-CURRENT',
        current_admin_id = 'ADMIN-1'
    WHERE payroll_id = 'PAYROLL-1';
  `);
  const objects = new Map();
  const deleted = [];
  const bucket = {
    async head(key) {
      return objects.has(key) ? { key } : null;
    },
    async put(key, value, options) {
      if (objects.has(key)) return null;
      objects.set(key, {
        body: value,
        options
      });
      return { key, size: value.byteLength };
    },
    async get(key) {
      const saved = objects.get(key);
      if (!saved) return null;
      return {
        body: saved.body,
        httpEtag: '"etag"',
        writeHttpMetadata(headers) {
          headers.set(
            'content-type',
            saved.options.httpMetadata.contentType
          );
        }
      };
    },
    async delete(key) {
      deleted.push(key);
      objects.delete(key);
    }
  };
  return {
    database,
    objects,
    deleted,
    env: {
      DB: createD1(database),
      PAYROLL_PROOFS: bucket,
      BOT_TOKEN: 'test-token',
      ENVIRONMENT: 'production',
      PAYROLL_PROOF_MAX_BYTES: '1024'
    }
  };
}

test('builds a private normalized proof object key', () => {
  assert.equal(
    proofObjectKey(
      {
        store_id: 'STORE-1',
        payroll_id: 'PAYROLL-1'
      },
      'bank',
      'PROOF-1',
      'jpg'
    ),
    'payroll/STORE-1/PAYROLL-1/bank/PROOF-1.jpg'
  );
});

test('downloads the largest Telegram photo and stores object before metadata', async () => {
  const fixture = proofFixture();
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).includes('/getFile')) {
      return {
        async json() {
          return {
            ok: true,
            result: { file_path: 'photos/proof.jpg' }
          };
        }
      };
    }
    return new Response(new Uint8Array([1, 2, 3, 4]), {
      headers: {
        'content-type': 'image/jpeg',
        'content-length': '4'
      }
    });
  };
  try {
    const proof = await storeTelegramProof(
      fixture.env,
      'ADMIN-1',
      'PAYROLL-1',
      'bank',
      [
        { file_id: 'SMALL', file_size: 2, width: 10, height: 10 },
        { file_id: 'LARGE', file_size: 4, width: 20, height: 20 }
      ],
      new Date('2026-07-16T04:00:00.000Z')
    );

    assert.equal(proof.telegram_file_id, 'LARGE');
    assert.equal(proof.attempt_id, 'ATTEMPT-CURRENT');
    assert.equal(proof.mime_type, 'image/jpeg');
    assert.equal(proof.size_bytes, 4);
    assert.equal(fixture.objects.size, 1);
    assert.equal(
      fixture.objects.get(proof.object_key)
        .options.httpMetadata.contentType,
      'image/jpeg'
    );
    assert.equal(calls.length, 2);
    assert.doesNotMatch(
      JSON.stringify(
        fixture.database.prepare(`
          SELECT * FROM bot_logs
        `).all()
      ),
      /test-token/
    );
  } finally {
    globalThis.fetch = originalFetch;
    fixture.database.close();
  }
});

for (const imageCase of [
  {
    name: 'PNG',
    bytes: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64'
    ),
    extension: 'png',
    mimeType: 'image/png'
  },
  {
    name: 'JPEG',
    bytes: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    extension: 'jpg',
    mimeType: 'image/jpeg'
  },
  {
    name: 'WebP',
    bytes: Buffer.from('RIFF0000WEBP'),
    extension: 'webp',
    mimeType: 'image/webp'
  }
]) {
  test(`detects a ${imageCase.name} when Telegram returns a generic content type`, async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (String(url).includes('/getFile')) {
        return {
          async json() {
            return {
              ok: true,
              result: { file_path: 'photos/qr' }
            };
          }
        };
      }
      return new Response(imageCase.bytes, {
        headers: { 'content-type': 'application/octet-stream' }
      });
    };
    try {
      const image = await downloadTelegramImage(
        {
          BOT_TOKEN: 'test-token',
          ENVIRONMENT: 'production'
        },
        [{
          file_id: `${imageCase.name}-FILE`,
          file_size: imageCase.bytes.byteLength,
          width: 1,
          height: 1
        }]
      );

      assert.equal(image.extension, imageCase.extension);
      assert.equal(image.mime_type, imageCase.mimeType);
      assert.equal(image.size_bytes, imageCase.bytes.byteLength);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
}

test('keeps existing proof image validation errors', async (context) => {
  await context.test('requires a Telegram photo', async () => {
    const fixture = proofFixture();
    try {
      await assert.rejects(
        storeTelegramProof(
          fixture.env,
          'ADMIN-1',
          'PAYROLL-1',
          'bank',
          []
        ),
        /payroll proof photo is required/
      );
    } finally {
      fixture.database.close();
    }
  });

  await context.test('rejects oversized Telegram metadata', async () => {
    const fixture = proofFixture();
    try {
      await assert.rejects(
        storeTelegramProof(
          fixture.env,
          'ADMIN-1',
          'PAYROLL-1',
          'bank',
          [{ file_id: 'PHOTO', file_size: 1025 }]
        ),
        /payroll proof is too large/
      );
    } finally {
      fixture.database.close();
    }
  });

  await context.test('rejects non-image downloads', async () => {
    const fixture = proofFixture();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (String(url).includes('/getFile')) {
        return {
          async json() {
            return {
              ok: true,
              result: { file_path: 'files/proof.txt' }
            };
          }
        };
      }
      return new Response(new Uint8Array([1]), {
        headers: { 'content-type': 'text/plain' }
      });
    };
    try {
      await assert.rejects(
        storeTelegramProof(
          fixture.env,
          'ADMIN-1',
          'PAYROLL-1',
          'bank',
          [{ file_id: 'PHOTO', file_size: 1 }]
        ),
        /payroll proof must be an image/
      );
    } finally {
      globalThis.fetch = originalFetch;
      fixture.database.close();
    }
  });

  await context.test('rejects oversized downloaded bytes', async () => {
    const fixture = proofFixture();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (String(url).includes('/getFile')) {
        return {
          async json() {
            return {
              ok: true,
              result: { file_path: 'photos/proof.jpg' }
            };
          }
        };
      }
      return new Response(new Uint8Array(1025), {
        headers: { 'content-type': 'image/jpeg' }
      });
    };
    try {
      await assert.rejects(
        storeTelegramProof(
          fixture.env,
          'ADMIN-1',
          'PAYROLL-1',
          'bank',
          [{ file_id: 'PHOTO', file_size: 1 }]
        ),
        /payroll proof is too large/
      );
    } finally {
      globalThis.fetch = originalFetch;
      fixture.database.close();
    }
  });
});

test('reports missing active proofs for every non-zero split method', async () => {
  const fixture = proofFixture();
  try {
    assert.deepEqual(
      await proofCompletion(fixture.env, 'PAYROLL-1'),
      {
        complete: false,
        missing_methods: ['bank', 'usdt']
      }
    );
    fixture.database.exec(`
      INSERT INTO payroll_payment_proofs (
        proof_id, payroll_id, attempt_id, method, object_key, telegram_file_id,
        mime_type, size_bytes, sort_order, uploaded_by, uploaded_at
      ) VALUES
        ('P1', 'PAYROLL-1', 'ATTEMPT-CURRENT', 'bank', 'p1', 'T1',
         'image/jpeg', 1, 1, 'ADMIN-1', '2026-07-16T04:00:00.000Z'),
        ('P2', 'PAYROLL-1', 'ATTEMPT-CURRENT', 'usdt', 'p2', 'T2',
         'image/jpeg', 1, 1, 'ADMIN-1', '2026-07-16T04:00:00.000Z');
    `);
    assert.deepEqual(
      await proofCompletion(fixture.env, 'PAYROLL-1'),
      {
        complete: true,
        missing_methods: []
      }
    );
    const completed = await completePayrollProofs(
      fixture.env,
      'ADMIN-1',
      'PAYROLL-1',
      new Date('2026-07-16T05:00:00.000Z')
    );
    assert.equal(
      completed.status,
      'awaiting_employee_confirmation'
    );
    assert.equal(
      fixture.database.prepare(`
        SELECT status FROM payroll_payment_attempts
        WHERE attempt_id = 'ATTEMPT-CURRENT'
      `).get().status,
      'submitted'
    );
  } finally {
    fixture.database.close();
  }
});

test('Telegram completion final SQL rejects a proof race without partial state', async () => {
  const fixture = proofFixture();
  try {
    fixture.database.exec(`
      INSERT INTO payroll_payment_proofs (
        proof_id, payroll_id, attempt_id, method, object_key,
        telegram_file_id, mime_type, size_bytes, sort_order,
        uploaded_by, uploaded_at
      ) VALUES
        ('FINAL-P1', 'PAYROLL-1', 'ATTEMPT-CURRENT', 'bank', 'final-p1', 'T1',
         'image/jpeg', 1, 1, 'ADMIN-1', '2026-07-16T04:00:00.000Z'),
        ('FINAL-P2', 'PAYROLL-1', 'ATTEMPT-CURRENT', 'usdt', 'final-p2', 'T2',
         'image/jpeg', 1, 1, 'ADMIN-1', '2026-07-16T04:00:00.000Z');
    `);
    let removed = false;
    fixture.env.DB = createD1(fixture.database, {
      beforeBatchStatement(sql) {
        if (removed || !sql.includes("SET status = 'submitted'")) return;
        removed = true;
        fixture.database.prepare(`
          DELETE FROM payroll_payment_proofs WHERE proof_id = 'FINAL-P2'
        `).run();
      }
    });

    await assert.rejects(completePayrollProofs(
      fixture.env,
      'ADMIN-1',
      'PAYROLL-1',
      new Date('2026-07-16T05:00:00.000Z')
    ), /payroll proof completion conflict/);
    assert.equal(fixture.database.prepare(`
      SELECT status FROM payroll_payment_attempts
      WHERE attempt_id = 'ATTEMPT-CURRENT'
    `).get().status, 'draft');
    assert.equal(fixture.database.prepare(`
      SELECT status FROM payroll_disbursements
      WHERE payroll_id = 'PAYROLL-1'
    `).get().status, 'awaiting_admin_payment');
    assert.equal(fixture.database.prepare(`
      SELECT COUNT(*) AS total FROM admin_audit_logs
      WHERE action = 'complete_payroll_proofs'
    `).get().total, 0);
  } finally {
    fixture.database.close();
  }
});

test('supports attempt-scoped proof order and compatibility-null metadata', () => {
  const fixture = proofFixture();
  try {
    fixture.database.exec(`
      UPDATE payroll_disbursements SET current_payment_attempt_id = NULL;
      DELETE FROM payroll_payment_attempts;
      INSERT INTO payroll_payment_attempts (
        attempt_id, payroll_id, version, status,
        bank_micros, created_at, updated_at
      ) VALUES
        (
          'ATTEMPT-1', 'PAYROLL-1', 1, 'submitted',
          100000000, '2026-07-16T04:00:00.000Z',
          '2026-07-16T04:00:00.000Z'
        ),
        (
          'ATTEMPT-2', 'PAYROLL-1', 2, 'draft',
          100000000, '2026-07-16T05:00:00.000Z',
          '2026-07-16T05:00:00.000Z'
        );
      INSERT INTO payroll_payment_proofs (
        proof_id, payroll_id, attempt_id, method, object_key,
        telegram_file_id, mime_type, size_bytes, sort_order,
        uploaded_by, uploaded_at
      ) VALUES
        (
          'ATTEMPT-PROOF-1', 'PAYROLL-1', 'ATTEMPT-1', 'bank',
          'attempt-1-proof', NULL, 'image/jpeg', 1, 1,
          'ADMIN-1', '2026-07-16T04:00:00.000Z'
        ),
        (
          'ATTEMPT-PROOF-2', 'PAYROLL-1', 'ATTEMPT-2', 'bank',
          'attempt-2-proof', NULL, 'image/jpeg', 1, 1,
          'ADMIN-1', '2026-07-16T05:00:00.000Z'
        );
    `);
    assert.throws(() => fixture.database.exec(`
      INSERT INTO payroll_payment_proofs (
        proof_id, payroll_id, attempt_id, method, object_key,
        mime_type, size_bytes, sort_order, uploaded_by, uploaded_at
      ) VALUES (
        'ATTEMPT-PROOF-3', 'PAYROLL-1', 'ATTEMPT-2', 'bank',
        'attempt-2-proof-duplicate-order', 'image/jpeg', 1, 1,
        'ADMIN-1', '2026-07-16T05:01:00.000Z'
      );
    `), /UNIQUE constraint failed/);
  } finally {
    fixture.database.close();
  }
});

test('deletes only the new R2 object when proof metadata insertion fails', async () => {
  const fixture = proofFixture();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('/getFile')) {
      return {
        async json() {
          return {
            ok: true,
            result: { file_path: 'photos/proof.png' }
          };
        }
      };
    }
    return new Response(new Uint8Array([1, 2, 3]), {
      headers: { 'content-type': 'image/png' }
    });
  };
  const baseDb = fixture.env.DB;
  fixture.env.DB = {
    ...baseDb,
    prepare(sql) {
      const statement = baseDb.prepare(sql);
      if (!/INSERT INTO payroll_payment_proofs/.test(sql)) {
        return statement;
      }
      return {
        bind() {
          return {
            async run() {
              throw new Error('metadata insert failed');
            }
          };
        }
      };
    }
  };
  try {
    await assert.rejects(
      storeTelegramProof(
        fixture.env,
        'ADMIN-1',
        'PAYROLL-1',
        'bank',
        [{ file_id: 'PHOTO', file_size: 3 }],
        new Date('2026-07-16T04:00:00.000Z')
      ),
      /metadata insert failed/
    );
    assert.equal(fixture.deleted.length, 1);
    assert.equal(fixture.objects.size, 0);
  } finally {
    globalThis.fetch = originalFetch;
    fixture.database.close();
  }
});

test('Telegram upload cleans the new object when the current draft closes before metadata', async () => {
  const fixture = proofFixture();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('/getFile')) {
      return {
        async json() {
          return { ok: true, result: { file_path: 'photos/race.jpg' } };
        }
      };
    }
    return new Response(new Uint8Array([1, 2, 3]), {
      headers: { 'content-type': 'image/jpeg' }
    });
  };
  let closed = false;
  fixture.env.DB = createD1(fixture.database, {
    beforeRun(sql) {
      if (closed || !sql.includes('INSERT INTO payroll_payment_proofs')) return;
      closed = true;
      fixture.database.prepare(`
        UPDATE payroll_payment_attempts SET status = 'abandoned'
        WHERE attempt_id = 'ATTEMPT-CURRENT'
      `).run();
    }
  });
  try {
    await assert.rejects(storeTelegramProof(
      fixture.env,
      'ADMIN-1',
      'PAYROLL-1',
      'bank',
      [{ file_id: 'RACE-PHOTO', file_size: 3 }],
      new Date('2026-07-16T04:00:00.000Z')
    ), /payroll proof upload conflict/);
    assert.equal(fixture.database.prepare(`
      SELECT COUNT(*) AS total FROM payroll_payment_proofs
    `).get().total, 0);
    assert.equal(fixture.objects.size, 0);
    assert.equal(fixture.deleted.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    fixture.database.close();
  }
});

test('Telegram upload preserves the database conflict when R2 cleanup also fails', async () => {
  const fixture = proofFixture();
  const originalFetch = globalThis.fetch;
  const originalConsoleError = console.error;
  const cleanupErrors = [];
  globalThis.fetch = async (url) => {
    if (String(url).includes('/getFile')) {
      return {
        async json() {
          return { ok: true, result: { file_path: 'photos/race.jpg' } };
        }
      };
    }
    return new Response(new Uint8Array([1, 2, 3]), {
      headers: { 'content-type': 'image/jpeg' }
    });
  };
  fixture.env.PAYROLL_PROOFS.delete = async () => {
    throw new Error('R2 cleanup failed');
  };
  console.error = (...args) => cleanupErrors.push(args);
  let closed = false;
  fixture.env.DB = createD1(fixture.database, {
    beforeRun(sql) {
      if (closed || !sql.includes('INSERT INTO payroll_payment_proofs')) return;
      closed = true;
      fixture.database.prepare(`
        UPDATE payroll_payment_attempts SET status = 'abandoned'
        WHERE attempt_id = 'ATTEMPT-CURRENT'
      `).run();
    }
  });
  try {
    await assert.rejects(storeTelegramProof(
      fixture.env,
      'ADMIN-1',
      'PAYROLL-1',
      'bank',
      [{ file_id: 'RACE-PHOTO', file_size: 3 }],
      new Date('2026-07-16T04:00:00.000Z')
    ), /payroll proof upload conflict/);
    assert.equal(cleanupErrors.length, 1);
    assert.equal(cleanupErrors[0][0], 'payroll proof R2 cleanup failed');
    assert.equal(fixture.database.prepare(`
      SELECT COUNT(*) AS total FROM payroll_payment_proofs
    `).get().total, 0);
  } finally {
    console.error = originalConsoleError;
    globalThis.fetch = originalFetch;
    fixture.database.close();
  }
});

test('serves a private proof only to its employee or store admin', async () => {
  const fixture = proofFixture();
  try {
    fixture.objects.set('private-proof', {
      body: new Uint8Array([1, 2]),
      options: { httpMetadata: { contentType: 'image/png' } }
    });
    fixture.database.exec(`
      INSERT INTO payroll_payment_proofs (
        proof_id, payroll_id, method, object_key, telegram_file_id,
        mime_type, size_bytes, sort_order, uploaded_by, uploaded_at
      ) VALUES (
        'PROOF-READ', 'PAYROLL-1', 'bank', 'private-proof',
        'TG', 'image/png', 2, 1, 'ADMIN-1',
        '2026-07-16T04:00:00.000Z'
      );
    `);

    const employeeResponse = await readPayrollProof(
      fixture.env,
      { telegram_id: 'EMP-1' },
      'PROOF-READ'
    );
    const adminResponse = await readPayrollProof(
      fixture.env,
      { telegram_id: 'ADMIN-1' },
      'PROOF-READ'
    );
    const denied = await readPayrollProof(
      fixture.env,
      { telegram_id: 'OTHER' },
      'PROOF-READ'
    );

    assert.equal(employeeResponse.status, 200);
    assert.equal(adminResponse.status, 200);
    assert.equal(denied.status, 403);
    assert.equal(
      employeeResponse.headers.get('cache-control'),
      'private, no-store'
    );
  } finally {
    fixture.database.close();
  }
});
