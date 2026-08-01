import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import {
  listManageStores,
  listManageTasks,
  manageTaskDetail
} from '../src/index.js';
import { createD1 } from './helpers/d1.js';

const schema = readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8');
const submittedAt = '2026-07-29T03:00:00.000Z';

function insertStore(database, storeId, name, status = 'active') {
  database.prepare(`
    INSERT INTO stores (
      store_id, name, status, currency, created_at, updated_at
    ) VALUES (?, ?, ?, '₫', ?, ?)
  `).run(storeId, name, status, submittedAt, submittedAt);
}

function insertMember(database, storeId, telegramId, role, displayName) {
  database.prepare(`
    INSERT INTO store_members (
      store_id, telegram_id, display_name, role, status,
      cycle_start, joined_at, updated_at
    ) VALUES (?, ?, ?, ?, 'active', '2026-07-01', ?, ?)
  `).run(storeId, telegramId, displayName, role, submittedAt, submittedAt);
}

function seedStoreTasks(database, storeId, suffix = '1') {
  const employeeId = `EMP-${suffix}`;
  insertMember(database, storeId, employeeId, 'employee', suffix === '1' ? 'Alice' : 'Bob');
  database.prepare(`
    INSERT INTO payroll_disbursements (
      payroll_id, store_id, telegram_id, payroll_start_date,
      scheduled_date, cycle_day, period_start, cutoff_at,
      amount_snapshot_micros, currency, status, created_at, updated_at
    ) VALUES (?, ?, ?, '2026-07-01', '2026-07-29', 30,
      '2026-07-16', '2026-07-29T02:00:00.000Z', 100000000, '₫',
      'awaiting_admin_payment', ?, ?)
  `).run(`PAYROLL-${suffix}`, storeId, employeeId, submittedAt, submittedAt);
  database.prepare(`
    INSERT INTO absence_fine_requests (
      request_id, store_id, telegram_id, business_date,
      original_fine, fine, status, created_at
    ) VALUES (?, ?, ?, '2026-07-29', 50, 50, 'pending', ?)
  `).run(`ABS-${suffix}`, storeId, employeeId, submittedAt);
  database.prepare(`
    INSERT INTO leave_requests (
      request_id, store_id, telegram_id, leave_date, status, requested_at
    ) VALUES (?, ?, ?, '2026-07-30', 'pending', ?)
  `).run(`LEAVE-${suffix}`, storeId, employeeId, submittedAt);
  database.prepare(`
    INSERT INTO salary_advance_requests (
      request_id, store_id, telegram_id, amount, status, requested_at
    ) VALUES (?, ?, ?, 80, 'pending', ?)
  `).run(`ADV-${suffix}`, storeId, employeeId, submittedAt);
  database.prepare(`
    INSERT INTO pending_income (
      request_id, store_id, telegram_id, income, commission_rate,
      commission_income, fine, status, submitted_at
    ) VALUES (?, ?, ?, 120, 0.6, 72, 0, 'pending', ?)
  `).run(`INC-${suffix}`, storeId, employeeId, submittedAt);
}

function setup() {
  const database = new DatabaseSync(':memory:');
  database.exec(schema);
  insertStore(database, 'STORE-1', 'Tokyo Club');
  insertStore(database, 'STORE-2', 'Osaka Club');
  insertStore(database, 'STORE-OFF', 'Closed Club', 'inactive');
  insertMember(database, 'STORE-1', 'ADMIN-1', 'admin', 'Manager One');
  insertMember(database, 'STORE-2', 'ADMIN-2', 'owner', 'Manager Two');
  insertMember(database, 'STORE-OFF', 'ADMIN-1', 'admin', 'Manager One');
  seedStoreTasks(database, 'STORE-1', '1');
  seedStoreTasks(database, 'STORE-2', '2');
  return {
    database,
    env: {
      ADMIN_IDS: 'GLOBAL-ADMIN',
      DB: createD1(database)
    }
  };
}

test('lists only active stores administered by the current admin', async () => {
  const fixture = setup();

  assert.deepEqual(
    await listManageStores(fixture.env, 'ADMIN-1'),
    [{ store_id: 'STORE-1', name: 'Tokyo Club', currency: '₫', timezone: 'Asia/Tokyo' }]
  );
  assert.deepEqual(
    (await listManageStores(fixture.env, 'GLOBAL-ADMIN')).map((store) => store.store_id),
    ['DEFAULT', 'STORE-2', 'STORE-1']
  );
});

test('lists only authorized pending tasks in exact urgency order', async () => {
  const fixture = setup();
  fixture.database.prepare(`
    INSERT INTO admin_task_claims (
      task_type, task_id, store_id, claimed_by,
      claimed_at, lease_expires_at, updated_at
    ) VALUES ('payroll', 'PAYROLL-1', 'STORE-1', 'ADMIN-2',
      '2026-07-29T03:05:00.000Z', '2026-07-29T12:05:00.000Z',
      '2026-07-29T03:05:00.000Z')
  `).run();

  const tasks = await listManageTasks(
    fixture.env,
    'ADMIN-1',
    { store_id: 'STORE-1', type: '' },
    new Date('2026-07-29T12:00:00.000Z')
  );

  assert.deepEqual(
    tasks.map((item) => item.task_type),
    ['payroll', 'absence', 'leave', 'advance', 'income']
  );
  assert.deepEqual(tasks.map((item) => item.urgency), [500, 400, 300, 200, 100]);
  assert.ok(tasks.every((item) => item.store_id === 'STORE-1'));
  assert.ok(tasks.every((item) => Object.hasOwn(item, 'claim')));
  assert.deepEqual(tasks[0], {
    task_type: 'payroll',
    task_id: 'PAYROLL-1',
    store_id: 'STORE-1',
    store_name: 'Tokyo Club',
    employee_id: 'EMP-1',
    employee_name: 'Alice',
    amount_micros: 100_000_000,
    currency: '₫',
    business_date: '2026-07-29',
    submitted_at: submittedAt,
    status: 'awaiting_admin_payment',
    urgency: 500,
    claim: {
      claimed_by: 'ADMIN-2',
      claimed_at: '2026-07-29T03:05:00.000Z',
      lease_expires_at: '2026-07-29T12:05:00.000Z',
      active: true
    }
  });
});

test('prioritizes disputed payroll and uses oldest time then stable task id', async () => {
  const fixture = setup();
  fixture.database.prepare(`
    INSERT INTO payroll_disbursements (
      payroll_id, store_id, telegram_id, payroll_start_date,
      scheduled_date, cycle_day, period_start, cutoff_at,
      amount_snapshot_micros, currency, status, created_at, updated_at
    ) VALUES ('PAYROLL-B', 'STORE-1', 'EMP-1', '2026-07-01',
      '2026-07-30', 30, '2026-07-16', '2026-07-29T02:00:00.000Z',
      90000000, '₫', 'disputed', '2026-07-29T01:00:00.000Z', ?)
  `).run(submittedAt);
  fixture.database.prepare(`
    INSERT INTO payroll_disbursements (
      payroll_id, store_id, telegram_id, payroll_start_date,
      scheduled_date, cycle_day, period_start, cutoff_at,
      amount_snapshot_micros, currency, status, created_at, updated_at
    ) VALUES ('PAYROLL-A', 'STORE-1', 'EMP-1', '2026-07-01',
      '2026-07-31', 30, '2026-07-16', '2026-07-29T02:00:00.000Z',
      80000000, '₫', 'disputed', '2026-07-29T01:00:00.000Z', ?)
  `).run(submittedAt);

  const tasks = await listManageTasks(
    fixture.env,
    'ADMIN-1',
    { store_id: 'STORE-1', type: 'payroll' },
    new Date('2026-07-29T12:00:00.000Z')
  );

  assert.deepEqual(
    tasks.map((item) => [item.task_id, item.urgency]),
    [
      ['PAYROLL-A', 600],
      ['PAYROLL-B', 600],
      ['PAYROLL-1', 500]
    ]
  );
});

test('returns authorized task detail and hides another store task', async () => {
  const fixture = setup();

  const detail = await manageTaskDetail(fixture.env, 'ADMIN-1', {
    task_type: 'income',
    task_id: 'INC-1'
  });

  assert.equal(detail.task_id, 'INC-1');
  assert.equal(detail.amount_micros, 120_000_000);
  assert.equal(detail.claim, null);
  assert.equal(await manageTaskDetail(fixture.env, 'ADMIN-1', {
    task_type: 'income',
    task_id: 'INC-2'
  }), null);
});
