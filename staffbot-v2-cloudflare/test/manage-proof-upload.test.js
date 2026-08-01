import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import worker, {
  cleanupAbandonedDraftProofs,
  deleteBrowserDraftProof,
  storeBrowserDraftProof
} from '../src/index.js';
import { createD1 } from './helpers/d1.js';

const schema = readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8');
const NOW = new Date('2026-07-16T05:00:00.000Z');

function setup({ dbHooks = {}, bucketHooks = {} } = {}) {
  const database = new DatabaseSync(':memory:');
  database.exec(schema);
  database.exec(`
    INSERT INTO stores (
      store_id, name, status, timezone, currency, created_at, updated_at
    ) VALUES
      ('STORE-1', 'Tokyo Club', 'active', 'Asia/Tokyo', '$',
       '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z'),
      ('STORE-2', 'Osaka Club', 'active', 'Asia/Tokyo', '$',
       '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z');
    INSERT INTO store_members (
      store_id, telegram_id, display_name, role, status,
      cycle_start, joined_at, updated_at
    ) VALUES
      ('STORE-1', 'ADMIN-1', 'Manager', 'admin', 'active',
       '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z',
       '2026-07-01T00:00:00.000Z'),
      ('STORE-1', 'EMP-1', 'Employee', 'employee', 'active',
       '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z',
       '2026-07-01T00:00:00.000Z');
    INSERT INTO admin_sessions (
      token, telegram_id, expires_at, created_at, csrf_token
    ) VALUES (
      'SESSION-1', 'ADMIN-1', '2099-01-01T00:00:00.000Z',
      '2026-07-01T00:00:00.000Z', 'CSRF-1'
    );
    INSERT INTO payroll_disbursements (
      payroll_id, store_id, telegram_id, payroll_start_date,
      scheduled_date, cycle_day, period_start, cutoff_at,
      amount_snapshot_micros, currency, status,
      accepts_bank, accepts_usdt, accepts_cash,
      bank_micros, usdt_micros, cash_micros,
      current_payment_attempt_id, current_admin_id,
      created_at, updated_at
    ) VALUES (
      'PAYROLL-1', 'STORE-1', 'EMP-1', '2026-07-01',
      '2026-07-16', 16, '2026-07-01T03:00:00.000Z',
      '2026-07-16T03:00:00.000Z', 100000000, '$',
      'awaiting_admin_payment', 1, 1, 0,
      70000000, 30000000, 0,
      'ATTEMPT-1', 'ADMIN-1',
      '2026-07-16T03:10:00.000Z', '2026-07-16T03:10:00.000Z'
    );
    INSERT INTO payroll_payment_attempts (
      attempt_id, payroll_id, version, status,
      bank_micros, usdt_micros, cash_micros, created_at, updated_at
    ) VALUES (
      'ATTEMPT-1', 'PAYROLL-1', 1, 'draft',
      70000000, 30000000, 0,
      '2026-07-16T03:10:00.000Z', '2026-07-16T03:10:00.000Z'
    );
    INSERT INTO admin_task_claims (
      task_type, task_id, store_id, claimed_by,
      claimed_at, lease_expires_at, updated_at
    ) VALUES (
      'payroll', 'PAYROLL-1', 'STORE-1', 'ADMIN-1',
      '2026-07-16T04:00:00.000Z', '2099-01-01T00:00:00.000Z',
      '2026-07-16T04:00:00.000Z'
    );
  `);
  const objects = new Map();
  const operations = [];
  const bucket = {
    async head(key) {
      operations.push(['head', key]);
      return objects.has(key) ? { key } : null;
    },
    async put(key, value, options) {
      operations.push(['put', key, options]);
      if (bucketHooks.put) return bucketHooks.put({ key, value, options, objects });
      if (objects.has(key)) return null;
      objects.set(key, { body: value, options });
      return { key };
    },
    async get(key) {
      operations.push(['get', key]);
      const saved = objects.get(key);
      if (!saved) return null;
      return {
        body: saved.body,
        httpEtag: 'etag-1',
        writeHttpMetadata(headers) {
          headers.set('content-type', saved.options.httpMetadata.contentType);
        }
      };
    },
    async delete(key) {
      operations.push(['delete', key]);
      if (bucketHooks.delete) return bucketHooks.delete({ key, objects });
      objects.delete(key);
    }
  };
  return {
    database,
    objects,
    operations,
    env: {
      ADMIN_IDS: '',
      DB: createD1(database, dbHooks),
      PAYROLL_PROOFS: bucket
    }
  };
}

function imageFile(type = 'image/jpeg', bytes = [0xff, 0xd8, 0xff, 0xd9], name = 'receipt.jpg') {
  return new File([new Uint8Array(bytes)], name, { type });
}

function manageRequest(env, path, { method = 'GET', body, csrf = true } = {}) {
  const headers = {
    cookie: 'staffbot_admin_session=SESSION-1',
    ...(method === 'GET' || !csrf ? {} : { 'x-csrf-token': 'CSRF-1' })
  };
  return worker.fetch(new Request(`https://staffbot.test${path}`, {
    method,
    headers,
    body
  }), env, { waitUntil() {} });
}

test('browser upload validates real image bytes and stores R2 before guarded metadata', async () => {
  let fixture;
  const order = [];
  fixture = setup({
    dbHooks: {
      beforeBatchStatement(sql) {
        if (sql.includes('INSERT INTO payroll_payment_proofs')) order.push('metadata');
      }
    },
    bucketHooks: {
      put({ key, value, options, objects }) {
        order.push('object');
        assert.deepEqual(options.onlyIf, { etagDoesNotMatch: '*' });
        objects.set(key, { body: value, options });
        return { key };
      }
    }
  });
  try {
    const proof = await storeBrowserDraftProof(
      fixture.env,
      'ADMIN-1',
      'ATTEMPT-1',
      'bank',
      imageFile(),
      NOW
    );
    assert.deepEqual(order, ['object', 'metadata']);
    assert.match(
      proof.object_key,
      /^payroll\/STORE-1\/PAYROLL-1\/ATTEMPT-1\/bank\/PROOF-[^/]+\.jpg$/
    );
    assert.equal(proof.attempt_id, 'ATTEMPT-1');
    assert.equal(proof.telegram_file_id, null);
    assert.equal(proof.telegram_delivered_at, null);
    assert.equal(proof.file_name, 'receipt.jpg');
  } finally {
    fixture.database.close();
  }
});

test('browser upload accepts PNG and WebP magic and rejects MIME spoofing or oversized files', async () => {
  const valid = [
    ['image/png', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'proof.png'],
    ['image/webp', [...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WEBP')], 'proof.webp']
  ];
  for (const [type, bytes, name] of valid) {
    const fixture = setup();
    try {
      const proof = await storeBrowserDraftProof(
        fixture.env, 'ADMIN-1', 'ATTEMPT-1', 'bank',
        imageFile(type, bytes, name), NOW
      );
      assert.equal(proof.mime_type, type);
    } finally {
      fixture.database.close();
    }
  }

  const fixture = setup();
  try {
    await assert.rejects(
      storeBrowserDraftProof(
        fixture.env, 'ADMIN-1', 'ATTEMPT-1', 'bank',
        imageFile('image/png', [0xff, 0xd8, 0xff], 'fake.png'), NOW
      ),
      /must match its image type/
    );
    await assert.rejects(
      storeBrowserDraftProof(
        fixture.env, 'ADMIN-1', 'ATTEMPT-1', 'bank',
        new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'large.jpg', { type: 'image/jpeg' }),
        NOW
      ),
      /too large/
    );
    assert.equal(fixture.objects.size, 0);
  } finally {
    fixture.database.close();
  }
});

test('browser upload enforces five active proofs per attempt and method', async () => {
  const fixture = setup();
  try {
    fixture.database.exec(`
      INSERT INTO payroll_payment_proofs (
        proof_id, payroll_id, attempt_id, method, object_key,
        mime_type, size_bytes, sort_order, uploaded_by, uploaded_at
      ) VALUES
        ('P1', 'PAYROLL-1', 'ATTEMPT-1', 'bank', 'p1', 'image/jpeg', 1, 1, 'ADMIN-1', '2026-07-16T04:00:00.000Z'),
        ('P2', 'PAYROLL-1', 'ATTEMPT-1', 'bank', 'p2', 'image/jpeg', 1, 2, 'ADMIN-1', '2026-07-16T04:00:00.000Z'),
        ('P3', 'PAYROLL-1', 'ATTEMPT-1', 'bank', 'p3', 'image/jpeg', 1, 3, 'ADMIN-1', '2026-07-16T04:00:00.000Z'),
        ('P4', 'PAYROLL-1', 'ATTEMPT-1', 'bank', 'p4', 'image/jpeg', 1, 4, 'ADMIN-1', '2026-07-16T04:00:00.000Z'),
        ('P5', 'PAYROLL-1', 'ATTEMPT-1', 'bank', 'p5', 'image/jpeg', 1, 5, 'ADMIN-1', '2026-07-16T04:00:00.000Z');
    `);
    await assert.rejects(
      storeBrowserDraftProof(
        fixture.env, 'ADMIN-1', 'ATTEMPT-1', 'bank', imageFile(), NOW
      ),
      /proof limit/
    );
    assert.equal(fixture.objects.size, 0);
  } finally {
    fixture.database.close();
  }
});

test('browser upload rechecks active claim at metadata insert and removes only its new object', async () => {
  let closed = false;
  const fixture = setup({
    dbHooks: {
      beforeBatchStatement(sql) {
        if (!closed && sql.includes('INSERT INTO payroll_payment_proofs')) {
          closed = true;
          fixture.database.prepare(`
            UPDATE admin_task_claims
            SET lease_expires_at = '2026-07-16T04:59:59.000Z'
            WHERE task_type = 'payroll' AND task_id = 'PAYROLL-1'
          `).run();
        }
      }
    }
  });
  fixture.objects.set('pre-existing', { body: new Uint8Array([1]), options: { httpMetadata: { contentType: 'image/png' } } });
  try {
    await assert.rejects(
      storeBrowserDraftProof(
        fixture.env, 'ADMIN-1', 'ATTEMPT-1', 'bank', imageFile(), NOW
      ),
      /upload conflict/
    );
    assert.deepEqual([...fixture.objects.keys()], ['pre-existing']);
    assert.equal(fixture.operations.filter(([action]) => action === 'delete').length, 1);
  } finally {
    fixture.database.close();
  }
});

test('draft delete is claim-protected and never restores a row after R2 orphaning', async () => {
  const fixture = setup({
    bucketHooks: {
      delete() { throw new Error('R2 unavailable'); }
    }
  });
  try {
    fixture.objects.set('draft-proof', { body: new Uint8Array([1]), options: { httpMetadata: { contentType: 'image/jpeg' } } });
    fixture.database.exec(`
      INSERT INTO payroll_payment_proofs (
        proof_id, payroll_id, attempt_id, method, object_key,
        mime_type, size_bytes, sort_order, uploaded_by, uploaded_at
      ) VALUES (
        'PROOF-DRAFT', 'PAYROLL-1', 'ATTEMPT-1', 'bank', 'draft-proof',
        'image/jpeg', 1, 1, 'ADMIN-1', '2026-07-16T04:00:00.000Z'
      );
    `);
    await deleteBrowserDraftProof(fixture.env, 'ADMIN-1', 'PROOF-DRAFT', NOW);
    assert.equal(fixture.database.prepare(`
      SELECT COUNT(*) AS total FROM payroll_payment_proofs WHERE proof_id = 'PROOF-DRAFT'
    `).get().total, 0);
    assert.equal(fixture.database.prepare(`
      SELECT COUNT(*) AS total FROM admin_audit_logs
      WHERE action = 'delete_payroll_draft_proof'
    `).get().total, 1);
    const orphan = fixture.database.prepare(`
      SELECT payload_json FROM bot_logs
      WHERE event = 'payroll_proof_r2_orphaned'
    `).get();
    assert.equal(JSON.parse(orphan.payload_json).object_key, 'draft-proof');
  } finally {
    fixture.database.close();
  }
});

test('submitted proof and expired claimant cannot delete proof metadata', async () => {
  const fixture = setup();
  try {
    fixture.database.exec(`
      INSERT INTO payroll_payment_proofs (
        proof_id, payroll_id, attempt_id, method, object_key,
        mime_type, size_bytes, sort_order, uploaded_by, uploaded_at
      ) VALUES (
        'PROOF-DRAFT', 'PAYROLL-1', 'ATTEMPT-1', 'bank', 'draft-proof',
        'image/jpeg', 1, 1, 'ADMIN-1', '2026-07-16T04:00:00.000Z'
      );
      UPDATE payroll_payment_attempts SET status = 'submitted' WHERE attempt_id = 'ATTEMPT-1';
    `);
    await assert.rejects(
      deleteBrowserDraftProof(fixture.env, 'ADMIN-1', 'PROOF-DRAFT', NOW),
      /not editable/
    );
  } finally {
    fixture.database.close();
  }

  const expired = setup();
  try {
    expired.database.exec(`
      INSERT INTO payroll_payment_proofs (
        proof_id, payroll_id, attempt_id, method, object_key,
        mime_type, size_bytes, sort_order, uploaded_by, uploaded_at
      ) VALUES (
        'PROOF-DRAFT', 'PAYROLL-1', 'ATTEMPT-1', 'bank', 'draft-proof',
        'image/jpeg', 1, 1, 'ADMIN-1', '2026-07-16T04:00:00.000Z'
      );
      UPDATE admin_task_claims
      SET lease_expires_at = '2026-07-16T04:00:00.000Z';
    `);
    await assert.rejects(
      deleteBrowserDraftProof(expired.env, 'ADMIN-1', 'PROOF-DRAFT', NOW),
      /task_claim_required/
    );
    assert.equal(expired.database.prepare(`
      SELECT COUNT(*) AS total FROM payroll_payment_proofs WHERE proof_id = 'PROOF-DRAFT'
    `).get().total, 1);
  } finally {
    expired.database.close();
  }
});

test('missing private storage never discards proof metadata during delete or cleanup', async () => {
  const fixture = setup();
  try {
    delete fixture.env.PAYROLL_PROOFS;
    fixture.database.exec(`
      INSERT INTO payroll_payment_proofs (
        proof_id, payroll_id, attempt_id, method, object_key,
        mime_type, size_bytes, sort_order, uploaded_by, uploaded_at
      ) VALUES (
        'PROOF-SAFE', 'PAYROLL-1', 'ATTEMPT-1', 'bank', 'proof-safe',
        'image/jpeg', 1, 1, 'ADMIN-1', '2026-07-01T00:00:00.000Z'
      );
    `);
    await assert.rejects(
      deleteBrowserDraftProof(fixture.env, 'ADMIN-1', 'PROOF-SAFE', NOW),
      /storage is not configured/
    );
    assert.equal(fixture.database.prepare(`
      SELECT COUNT(*) AS total FROM payroll_payment_proofs
      WHERE proof_id = 'PROOF-SAFE'
    `).get().total, 1);
    fixture.database.exec(`
      UPDATE payroll_payment_attempts
      SET status = 'abandoned', updated_at = '2026-07-01T00:00:00.000Z'
      WHERE attempt_id = 'ATTEMPT-1';
    `);
    const cleanup = await cleanupAbandonedDraftProofs(fixture.env, NOW);
    assert.deepEqual(cleanup, { deleted: 0, failed: 1 });
    assert.equal(fixture.database.prepare(`
      SELECT COUNT(*) AS total FROM payroll_payment_proofs
      WHERE proof_id = 'PROOF-SAFE'
    `).get().total, 1);
  } finally {
    fixture.database.close();
  }
});

test('manage upload/delete routes require CSRF and private proof route wins over payroll dossier routing', async () => {
  const fixture = setup();
  try {
    const form = new FormData();
    form.set('method', 'bank');
    form.set('proof', imageFile());
    const noCsrf = await manageRequest(
      fixture.env,
      '/api/manage/stores/STORE-1/payroll/PAYROLL-1/attempts/ATTEMPT-1/proofs',
      { method: 'POST', body: form, csrf: false }
    );
    assert.equal(noCsrf.status, 403);

    const uploadForm = new FormData();
    uploadForm.set('method', 'bank');
    uploadForm.set('proof', imageFile());
    const uploaded = await manageRequest(
      fixture.env,
      '/api/manage/stores/STORE-1/payroll/PAYROLL-1/attempts/ATTEMPT-1/proofs',
      { method: 'POST', body: uploadForm }
    );
    assert.equal(uploaded.status, 200);
    const uploadedBody = await uploaded.json();
    assert.equal(uploadedBody.ok, true);
    assert.equal(Object.hasOwn(uploadedBody.proof, 'object_key'), false);
    const privateObjectKey = fixture.database.prepare(`
      SELECT object_key FROM payroll_payment_proofs WHERE proof_id = ?
    `).get(uploadedBody.proof.proof_id).object_key;

    const read = await manageRequest(
      fixture.env,
      `/api/manage/stores/STORE-1/payroll/proofs/${uploadedBody.proof.proof_id}`
    );
    assert.equal(read.status, 200);
    assert.equal(read.headers.get('cache-control'), 'private, no-store');
    assert.equal(read.headers.get('content-type'), 'image/jpeg');

    const crossStore = await manageRequest(
      fixture.env,
      `/api/manage/stores/STORE-2/payroll/proofs/${uploadedBody.proof.proof_id}`
    );
    assert.equal(crossStore.status, 403);

    const deleted = await manageRequest(
      fixture.env,
      `/api/manage/stores/STORE-1/payroll/PAYROLL-1/attempts/ATTEMPT-1/proofs/${uploadedBody.proof.proof_id}`,
      { method: 'DELETE' }
    );
    assert.equal(deleted.status, 200);

    const dossier = await manageRequest(
      fixture.env,
      '/api/manage/stores/STORE-1/payroll/PAYROLL-1'
    );
    const dossierText = await dossier.text();
    assert.equal(dossier.status, 200);
    assert.doesNotMatch(dossierText, /object_key/);
    assert.equal(dossierText.includes(privateObjectKey), false);
  } finally {
    fixture.database.close();
  }
});

test('manage upload maps unavailable private storage without exposing an internal error', async () => {
  const fixture = setup();
  try {
    delete fixture.env.PAYROLL_PROOFS;
    const form = new FormData();
    form.set('method', 'bank');
    form.set('proof', imageFile());
    const response = await manageRequest(
      fixture.env,
      '/api/manage/stores/STORE-1/payroll/PAYROLL-1/attempts/ATTEMPT-1/proofs',
      { method: 'POST', body: form }
    );
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      ok: false,
      error: 'storage_not_configured'
    });
  } finally {
    fixture.database.close();
  }
});

test('manage upload maps a zero-value payment method to a stable conflict', async () => {
  const fixture = setup();
  try {
    const form = new FormData();
    form.set('method', 'cash');
    form.set('proof', imageFile());
    const response = await manageRequest(
      fixture.env,
      '/api/manage/stores/STORE-1/payroll/PAYROLL-1/attempts/ATTEMPT-1/proofs',
      { method: 'POST', body: form }
    );
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      ok: false,
      error: 'proof_method_not_payable'
    });
    assert.equal(fixture.objects.size, 0);
  } finally {
    fixture.database.close();
  }
});

test('abandoned proof cleanup rechecks age and draft status per object and reports failures', async () => {
  let raced = false;
  const fixture = setup({
    dbHooks: {
      beforeBatchStatement(sql) {
        if (!raced && sql.includes('DELETE FROM payroll_payment_proofs')) {
          raced = true;
          fixture.database.prepare(`
            UPDATE payroll_payment_attempts SET status = 'submitted'
            WHERE attempt_id = 'ATTEMPT-RACE'
          `).run();
        }
      }
    },
    bucketHooks: {
      delete({ key, objects }) {
        if (key === 'proof-fail') throw new Error('R2 unavailable');
        objects.delete(key);
      }
    }
  });
  try {
    fixture.database.exec(`
      UPDATE payroll_payment_attempts
      SET status = 'abandoned', updated_at = '2026-07-01T00:00:00.000Z'
      WHERE attempt_id = 'ATTEMPT-1';
      INSERT INTO payroll_payment_attempts (
        attempt_id, payroll_id, version, status, created_at, updated_at
      ) VALUES
        ('ATTEMPT-RACE', 'PAYROLL-1', 2, 'draft', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z'),
        ('ATTEMPT-NEW', 'PAYROLL-1', 3, 'abandoned', '2026-07-15T00:00:00.000Z', '2026-07-15T00:00:00.000Z'),
        ('ATTEMPT-FINAL', 'PAYROLL-1', 4, 'submitted', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z');
      INSERT INTO payroll_payment_proofs (
        proof_id, payroll_id, attempt_id, method, object_key,
        mime_type, size_bytes, sort_order, uploaded_by, uploaded_at
      ) VALUES
        ('PROOF-OLD', 'PAYROLL-1', 'ATTEMPT-1', 'bank', 'proof-old', 'image/jpeg', 1, 1, 'ADMIN-1', '2026-07-01T00:00:00.000Z'),
        ('PROOF-FAIL', 'PAYROLL-1', 'ATTEMPT-1', 'bank', 'proof-fail', 'image/jpeg', 1, 2, 'ADMIN-1', '2026-07-01T00:00:00.000Z'),
        ('PROOF-RACE', 'PAYROLL-1', 'ATTEMPT-RACE', 'bank', 'proof-race', 'image/jpeg', 1, 1, 'ADMIN-1', '2026-07-01T00:00:00.000Z'),
        ('PROOF-NEW', 'PAYROLL-1', 'ATTEMPT-NEW', 'bank', 'proof-new', 'image/jpeg', 1, 1, 'ADMIN-1', '2026-07-15T00:00:00.000Z'),
        ('PROOF-FINAL', 'PAYROLL-1', 'ATTEMPT-FINAL', 'bank', 'proof-final', 'image/jpeg', 1, 1, 'ADMIN-1', '2026-07-01T00:00:00.000Z');
    `);
    for (const key of ['proof-old', 'proof-fail', 'proof-race', 'proof-new', 'proof-final']) {
      fixture.objects.set(key, { body: new Uint8Array([1]), options: { httpMetadata: { contentType: 'image/jpeg' } } });
    }
    const result = await cleanupAbandonedDraftProofs(fixture.env, NOW);
    assert.deepEqual(result, { deleted: 1, failed: 1 });
    assert.equal(fixture.objects.has('proof-old'), false);
    assert.equal(fixture.objects.has('proof-fail'), true);
    assert.equal(fixture.objects.has('proof-race'), true);
    assert.equal(fixture.objects.has('proof-new'), true);
    assert.equal(fixture.objects.has('proof-final'), true);
    assert.deepEqual(
      fixture.database.prepare(`
        SELECT proof_id FROM payroll_payment_proofs ORDER BY proof_id
      `).all().map((row) => row.proof_id),
      ['PROOF-FINAL', 'PROOF-NEW', 'PROOF-RACE']
    );
    assert.equal(fixture.database.prepare(`
      SELECT COUNT(*) AS total FROM bot_logs
      WHERE event = 'payroll_proof_r2_orphaned'
    `).get().total, 1);
  } finally {
    fixture.database.close();
  }
});

test('cleanup counts one failed object when orphan logging itself needs a fallback', async () => {
  const fixture = setup({
    dbHooks: {
      beforeRun(sql, params) {
        if (sql.includes('INSERT INTO bot_logs')
          && params[2] === 'payroll_proof_r2_orphaned') {
          throw new Error('orphan log unavailable');
        }
      }
    },
    bucketHooks: {
      delete() { throw new Error('R2 unavailable'); }
    }
  });
  try {
    fixture.database.exec(`
      UPDATE payroll_payment_attempts
      SET status = 'abandoned', updated_at = '2026-07-01T00:00:00.000Z'
      WHERE attempt_id = 'ATTEMPT-1';
      INSERT INTO payroll_payment_proofs (
        proof_id, payroll_id, attempt_id, method, object_key,
        mime_type, size_bytes, sort_order, uploaded_by, uploaded_at
      ) VALUES (
        'PROOF-FAIL', 'PAYROLL-1', 'ATTEMPT-1', 'bank', 'proof-fail',
        'image/jpeg', 1, 1, 'ADMIN-1', '2026-07-01T00:00:00.000Z'
      );
    `);
    const result = await cleanupAbandonedDraftProofs(fixture.env, NOW);
    assert.deepEqual(result, { deleted: 0, failed: 1 });
    assert.equal(fixture.database.prepare(`
      SELECT COUNT(*) AS total FROM bot_logs
      WHERE event = 'payroll_proof_cleanup_failed'
    `).get().total, 1);
  } finally {
    fixture.database.close();
  }
});
