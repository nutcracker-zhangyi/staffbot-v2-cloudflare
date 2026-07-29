import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import worker from '../src/index.js';
import { createD1 } from './helpers/d1.js';

const schema = readFileSync(
  new URL('../db/schema.sql', import.meta.url),
  'utf8'
);

function adminFixture() {
  const database = new DatabaseSync(':memory:');
  database.exec(schema);
  database.exec(`
    INSERT INTO stores (
      store_id, name, status, timezone, currency, created_at, updated_at
    ) VALUES (
      'STORE-1', 'Tokyo Club', 'active', 'Asia/Tokyo', '¥',
      '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z'
    );
    INSERT INTO users (
      telegram_id, name, username, role, status,
      cycle_start, created_at, updated_at
    ) VALUES (
      'EMP-1', 'Alice', 'alice', 'employee', 'active',
      '2026-06-01T00:00:00.000Z',
      '2026-06-01T00:00:00.000Z',
      '2026-07-01T00:00:00.000Z'
    );
    INSERT INTO store_members (
      store_id, telegram_id, display_name, role, status,
      commission_rate, cycle_start, joined_at,
      absence_check_enabled, absence_check_enabled_at, updated_at
    ) VALUES (
      'STORE-1', 'EMP-1', 'Alice', 'employee', 'active',
      0.6, '2026-06-01T00:00:00.000Z',
      '2026-06-01T00:00:00.000Z',
      1, '2026-06-01T00:00:00.000Z',
      '2026-07-01T00:00:00.000Z'
    );
    INSERT INTO admin_sessions (
      token, telegram_id, expires_at, created_at
    ) VALUES (
      'session-1', 'ADMIN-1',
      '2099-01-01T00:00:00.000Z',
      '2026-07-01T00:00:00.000Z'
    );
  `);
  return {
    database,
    env: {
      ENVIRONMENT: 'staging',
      BOT_TOKEN: 'test-token',
      WEBHOOK_SECRET: 'test-secret',
      ADMIN_IDS: 'ADMIN-1',
      DB: createD1(database)
    }
  };
}

function memberRequest(body) {
  return new Request(
    'https://example.com/api/admin/stores/STORE-1/members',
    {
      method: 'POST',
      headers: {
        cookie: 'staffbot_admin_session=session-1',
        'content-type': 'application/json'
      },
      body: JSON.stringify(body)
    }
  );
}

function memberBody(payrollStartDate) {
  return {
    telegram_id: 'EMP-1',
    name: 'Alice',
    username: 'alice',
    role: 'employee',
    status: 'active',
    commission_rate: 0.6,
    absence_check_enabled: true,
    payroll_start_date: payrollStartDate
  };
}

test('admin member list exposes payroll start and automation dates', async () => {
  const fixture = adminFixture();
  try {
    const response = await worker.fetch(new Request(
      'https://example.com/api/admin/stores/STORE-1/members?all=1',
      { headers: { cookie: 'staffbot_admin_session=session-1' } }
    ), fixture.env, { waitUntil() {} });
    const result = await response.json();

    assert.equal(response.status, 200);
    assert.equal(result.members.length, 1);
    assert.equal(result.members[0].payroll_start_date, null);
    assert.equal(result.members[0].payroll_automation_started_at, null);
  } finally {
    fixture.database.close();
  }
});

test('admin starts payroll automation without replacing the current cycle boundary', async () => {
  const fixture = adminFixture();
  try {
    const before = new Date().toISOString();
    const response = await worker.fetch(
      memberRequest(memberBody('2026-04-03')),
      fixture.env,
      { waitUntil() {} }
    );
    const after = new Date().toISOString();
    const member = fixture.database.prepare(`
      SELECT
        cycle_start,
        payroll_start_date,
        payroll_automation_started_at
      FROM store_members
      WHERE store_id = 'STORE-1' AND telegram_id = 'EMP-1'
    `).get();

    assert.equal(response.status, 200);
    assert.equal(member.cycle_start, '2026-06-01T00:00:00.000Z');
    assert.equal(member.payroll_start_date, '2026-04-03');
    assert.ok(member.payroll_automation_started_at >= before);
    assert.ok(member.payroll_automation_started_at <= after);

    const firstStartedAt = member.payroll_automation_started_at;
    const secondResponse = await worker.fetch(
      memberRequest(memberBody('2026-04-03')),
      fixture.env,
      { waitUntil() {} }
    );
    assert.equal(secondResponse.status, 200);
    assert.equal(
      fixture.database.prepare(`
        SELECT payroll_automation_started_at
        FROM store_members
        WHERE store_id = 'STORE-1' AND telegram_id = 'EMP-1'
      `).get().payroll_automation_started_at,
      firstStartedAt
    );
  } finally {
    fixture.database.close();
  }
});

test('admin cannot clear or corrupt an active payroll start date', async () => {
  const fixture = adminFixture();
  try {
    fixture.database.prepare(`
      UPDATE store_members
      SET payroll_start_date = '2026-04-03',
          payroll_automation_started_at = '2026-07-01T00:00:00.000Z'
      WHERE store_id = 'STORE-1' AND telegram_id = 'EMP-1'
    `).run();

    for (const value of ['', '2026-02-30', 'not-a-date']) {
      const response = await worker.fetch(
        memberRequest(memberBody(value)),
        fixture.env,
        { waitUntil() {} }
      );
      assert.equal(response.status, 400);
    }
    assert.deepEqual(
      {
        ...fixture.database.prepare(`
          SELECT payroll_start_date, payroll_automation_started_at
          FROM store_members
          WHERE store_id = 'STORE-1' AND telegram_id = 'EMP-1'
        `).get()
      },
      {
        payroll_start_date: '2026-04-03',
        payroll_automation_started_at: '2026-07-01T00:00:00.000Z'
      }
    );
  } finally {
    fixture.database.close();
  }
});

test('admin document provides a first work date editor', async () => {
  const response = await worker.fetch(
    new Request('https://example.com/admin'),
    { ENVIRONMENT: 'staging' },
    { waitUntil() {} }
  );
  const document = await response.text();

  assert.match(document, /id="memberPayrollStartDate"/);
  assert.match(document, /payroll_start_date/);
  assert.match(document, /payroll_automation_started_at/);
});
