import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import {
  claimTask,
  forceTakeoverTask,
  isStoreOwner,
  releaseTaskClaim,
  renewTaskClaim,
  requireActiveTaskClaim
} from '../src/index.js';
import { createD1 } from './helpers/d1.js';

const schema = readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8');
const task = { task_type: 'income', task_id: 'INCOME-1', store_id: 'STORE-1' };

function at(value) {
  return new Date(value);
}

function setup() {
  const database = new DatabaseSync(':memory:');
  database.exec(schema);
  addStoreMember(database, 'ADMIN-1', 'admin');
  addStoreMember(database, 'ADMIN-2', 'admin');
  return {
    database,
    env: {
      ADMIN_IDS: 'GLOBAL-ADMIN',
      DB: createD1(database)
    }
  };
}

function addStoreMember(
  database,
  telegramId,
  role,
  status = 'active',
  storeId = task.store_id
) {
  database.prepare(`
    INSERT INTO store_members (
      store_id, telegram_id, role, status, cycle_start, joined_at, updated_at
    ) VALUES (?, ?, ?, ?, '2026-07-01', ?, ?)
  `).run(
    storeId,
    telegramId,
    role,
    status,
    '2026-07-01T00:00:00.000Z',
    '2026-07-01T00:00:00.000Z'
  );
}

test('rejects a non-member before creating a claim', async () => {
  const { env, database } = setup();

  await assert.rejects(
    claimTask(env, 'NON-MEMBER', task, at('2026-07-29T00:00:00Z')),
    /forbidden/
  );

  assert.equal(database.prepare(`SELECT COUNT(*) AS total FROM admin_task_claims`).get().total, 0);
});

test('rejects an inactive member before creating a claim', async () => {
  const { env, database } = setup();
  addStoreMember(database, 'INACTIVE-ADMIN', 'admin', 'inactive');

  await assert.rejects(
    claimTask(env, 'INACTIVE-ADMIN', task, at('2026-07-29T00:00:00Z')),
    /forbidden/
  );

  assert.equal(database.prepare(`SELECT COUNT(*) AS total FROM admin_task_claims`).get().total, 0);
});

test('rejects an admin whose active membership belongs to another store', async () => {
  const { env, database } = setup();
  addStoreMember(database, 'OTHER-STORE-ADMIN', 'admin', 'active', 'STORE-2');

  await assert.rejects(
    claimTask(env, 'OTHER-STORE-ADMIN', task, at('2026-07-29T00:00:00Z')),
    /forbidden/
  );

  assert.equal(database.prepare(`SELECT COUNT(*) AS total FROM admin_task_claims`).get().total, 0);
});

test('an inactive admin cannot renew an existing claim', async () => {
  const { env, database } = setup();
  await claimTask(env, 'ADMIN-1', task, at('2026-07-29T00:00:00Z'));
  database.prepare(`
    UPDATE store_members SET status = 'inactive'
    WHERE store_id = ? AND telegram_id = ?
  `).run(task.store_id, 'ADMIN-1');

  await assert.rejects(
    renewTaskClaim(env, 'ADMIN-1', task, at('2026-07-29T00:10:00Z')),
    /forbidden/
  );

  const stored = database.prepare(`SELECT * FROM admin_task_claims`).get();
  assert.equal(stored.updated_at, '2026-07-29T00:00:00.000Z');
  assert.equal(stored.lease_expires_at, '2026-07-29T00:15:00.000Z');
});

test('claims an unclaimed task for exactly fifteen minutes', async () => {
  const { env } = setup();

  const claim = await claimTask(
    env,
    'ADMIN-1',
    task,
    at('2026-07-29T00:00:00Z')
  );

  assert.deepEqual({ ...claim }, {
    task_type: 'income',
    task_id: 'INCOME-1',
    store_id: 'STORE-1',
    claimed_by: 'ADMIN-1',
    claimed_at: '2026-07-29T00:00:00.000Z',
    lease_expires_at: '2026-07-29T00:15:00.000Z',
    updated_at: '2026-07-29T00:00:00.000Z'
  });
});

test('a payroll payment claim does not expire', async () => {
  const { env } = setup();
  const payrollTask = {
    task_type: 'payroll',
    task_id: 'PAYROLL-1',
    store_id: 'STORE-1'
  };

  const claim = await claimTask(
    env,
    'ADMIN-1',
    payrollTask,
    at('2026-07-29T00:00:00Z')
  );

  assert.equal(claim.lease_expires_at, '9999-12-31T23:59:59.999Z');
  assert.equal(
    (await requireActiveTaskClaim(
      env,
      'ADMIN-1',
      payrollTask,
      at('2099-01-01T00:00:00Z')
    )).claimed_by,
    'ADMIN-1'
  );
});

test('the same admin renews a claim without resetting its claimed time', async () => {
  const { env } = setup();
  await claimTask(env, 'ADMIN-1', task, at('2026-07-29T00:00:00Z'));

  const renewed = await renewTaskClaim(
    env,
    'ADMIN-1',
    task,
    at('2026-07-29T00:10:00Z')
  );

  assert.equal(renewed.claimed_at, '2026-07-29T00:00:00.000Z');
  assert.equal(renewed.updated_at, '2026-07-29T00:10:00.000Z');
  assert.equal(renewed.lease_expires_at, '2026-07-29T00:25:00.000Z');
});

test('two concurrent claimants produce exactly one winner', async () => {
  const { env, database } = setup();

  const results = await Promise.allSettled([
    claimTask(env, 'ADMIN-1', task, at('2026-07-29T00:00:00Z')),
    claimTask(env, 'ADMIN-2', task, at('2026-07-29T00:00:00Z'))
  ]);

  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  assert.match(
    results.find((result) => result.status === 'rejected').reason.message,
    /task_claimed/
  );
  const stored = database.prepare(`
    SELECT claimed_by FROM admin_task_claims
    WHERE task_type = ? AND task_id = ?
  `).get(task.task_type, task.task_id);
  assert.equal(
    stored.claimed_by,
    results.find((result) => result.status === 'fulfilled').value.claimed_by
  );
});

test('an expired fifteen-minute lease can be claimed by another admin', async () => {
  const { env } = setup();
  await claimTask(env, 'ADMIN-1', task, at('2026-07-29T00:00:00Z'));
  await assert.rejects(
    claimTask(env, 'ADMIN-2', task, at('2026-07-29T00:14:59Z')),
    /task_claimed/
  );

  const claim = await claimTask(
    env,
    'ADMIN-2',
    task,
    at('2026-07-29T00:15:00Z')
  );

  assert.equal(claim.claimed_by, 'ADMIN-2');
  assert.equal(claim.claimed_at, '2026-07-29T00:15:00.000Z');
  assert.equal(claim.lease_expires_at, '2026-07-29T00:30:00.000Z');
});

test('release deletes only the matching admin active claim', async () => {
  const { env, database } = setup();
  await claimTask(env, 'ADMIN-1', task, at('2026-07-29T00:00:00Z'));

  await releaseTaskClaim(env, 'ADMIN-2', task, at('2026-07-29T00:01:00Z'));
  assert.equal(database.prepare(`SELECT COUNT(*) AS total FROM admin_task_claims`).get().total, 1);

  await releaseTaskClaim(env, 'ADMIN-1', task, at('2026-07-29T00:01:00Z'));
  assert.equal(database.prepare(`SELECT COUNT(*) AS total FROM admin_task_claims`).get().total, 0);
});

test('release leaves an expired claim for conditional takeover', async () => {
  const { env, database } = setup();
  await claimTask(env, 'ADMIN-1', task, at('2026-07-29T00:00:00Z'));

  await releaseTaskClaim(env, 'ADMIN-1', task, at('2026-07-29T00:15:00Z'));

  assert.equal(database.prepare(`SELECT COUNT(*) AS total FROM admin_task_claims`).get().total, 1);
});

test('requires the same admin to hold an unexpired task claim', async () => {
  const { env } = setup();
  await claimTask(env, 'ADMIN-1', task, at('2026-07-29T00:00:00Z'));

  const active = await requireActiveTaskClaim(
    env,
    'ADMIN-1',
    task,
    at('2026-07-29T00:14:59Z')
  );
  assert.equal(active.claimed_by, 'ADMIN-1');
  await assert.rejects(
    requireActiveTaskClaim(env, 'ADMIN-2', task, at('2026-07-29T00:14:59Z')),
    /task_claim_required/
  );
  await assert.rejects(
    requireActiveTaskClaim(env, 'ADMIN-1', task, at('2026-07-29T00:15:00Z')),
    /task_claim_required/
  );
});

test('identifies only an active store owner as a store owner', async () => {
  const { env, database } = setup();
  addStoreMember(database, 'OWNER-1', 'owner');
  addStoreMember(database, 'OWNER-INACTIVE', 'owner', 'inactive');

  assert.equal(await isStoreOwner(env, 'OWNER-1', task.store_id), true);
  assert.equal(await isStoreOwner(env, 'ADMIN-1', task.store_id), false);
  assert.equal(await isStoreOwner(env, 'OWNER-INACTIVE', task.store_id), false);
  assert.equal(await isStoreOwner(env, 'GLOBAL-ADMIN', task.store_id), false);
});

test('an active store owner can force takeover and the change is audited', async () => {
  const { env, database } = setup();
  addStoreMember(database, 'OWNER-1', 'owner');
  await claimTask(env, 'ADMIN-1', task, at('2026-07-29T00:00:00Z'));

  const claim = await forceTakeoverTask(
    env,
    'OWNER-1',
    task,
    'Admin left the shift',
    at('2026-07-29T00:05:00Z')
  );

  assert.equal(claim.claimed_by, 'OWNER-1');
  assert.equal(claim.claimed_at, '2026-07-29T00:05:00.000Z');
  assert.equal(claim.lease_expires_at, '2026-07-29T00:20:00.000Z');
  const audit = database.prepare(`
    SELECT store_id, admin_id, action, target_id, details_json, created_at
    FROM admin_audit_logs ORDER BY id DESC LIMIT 1
  `).get();
  assert.deepEqual(
    { ...audit, details_json: JSON.parse(audit.details_json) },
    {
      store_id: 'STORE-1',
      admin_id: 'OWNER-1',
      action: 'force_takeover_task',
      target_id: 'INCOME-1',
      details_json: {
        task_type: 'income',
        prior_actor: 'ADMIN-1',
        new_actor: 'OWNER-1',
        reason: 'Admin left the shift',
        time: '2026-07-29T00:05:00.000Z'
      },
      created_at: '2026-07-29T00:05:00.000Z'
    }
  );
});

test('a global admin can force takeover without store membership', async () => {
  const { env } = setup();
  await claimTask(env, 'ADMIN-1', task, at('2026-07-29T00:00:00Z'));

  const claim = await forceTakeoverTask(
    env,
    'GLOBAL-ADMIN',
    task,
    'Escalated support',
    at('2026-07-29T00:02:00Z')
  );

  assert.equal(claim.claimed_by, 'GLOBAL-ADMIN');
});

test('a store admin cannot force takeover or create an audit entry', async () => {
  const { env, database } = setup();
  await claimTask(env, 'ADMIN-1', task, at('2026-07-29T00:00:00Z'));

  await assert.rejects(
    forceTakeoverTask(
      env,
      'ADMIN-2',
      task,
      'I want this task',
      at('2026-07-29T00:02:00Z')
    ),
    /forbidden/
  );

  assert.equal(
    database.prepare(`SELECT claimed_by FROM admin_task_claims`).get().claimed_by,
    'ADMIN-1'
  );
  assert.equal(database.prepare(`SELECT COUNT(*) AS total FROM admin_audit_logs`).get().total, 0);
});

test('a different-store owner cannot move or audit an existing task claim', async () => {
  const { env, database } = setup();
  addStoreMember(database, 'STORE-2-OWNER', 'owner', 'active', 'STORE-2');
  await claimTask(env, 'ADMIN-1', task, at('2026-07-29T00:00:00Z'));

  await assert.rejects(
    forceTakeoverTask(
      env,
      'STORE-2-OWNER',
      { ...task, store_id: 'STORE-2' },
      'Move this task',
      at('2026-07-29T00:05:00Z')
    )
  );

  const stored = database.prepare(`SELECT * FROM admin_task_claims`).get();
  assert.equal(stored.store_id, 'STORE-1');
  assert.equal(stored.claimed_by, 'ADMIN-1');
  assert.equal(database.prepare(`SELECT COUNT(*) AS total FROM admin_audit_logs`).get().total, 0);
});
