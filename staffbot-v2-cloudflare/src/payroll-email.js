import { formatMoney } from './money.js';
import { payrollEmailConfig } from './security.js';

const EMAIL_CLAIM_LEASE_MS = 15 * 60 * 1000;

function headerValue(value) {
  return String(value || '').replace(/[\r\n]+/g, ' ').trim();
}

function money(payroll, field) {
  return formatMoney(
    { currency: payroll.currency },
    Number(payroll[field]) / 1_000_000
  );
}

export function renderPayrollEmail(payroll, proofs) {
  const proofRows = proofs || [];
  const splitLines = ['bank', 'usdt', 'cash']
    .filter((method) => Number(payroll[`${method}_micros`]) > 0)
    .map((method) =>
      `${method}: ${money(payroll, `${method}_micros`)}`
    );
  const proofLines = proofRows.map((proof) =>
    `${proof.method} #${proof.sort_order}: ${proof.object_key}`
  );
  return {
    subject: `Payroll confirmed: ${headerValue(payroll.payroll_id)}`,
    text: [
      `payroll_id: ${payroll.payroll_id}`,
      `store: ${payroll.store_name} (${payroll.store_id})`,
      `employee: ${payroll.employee_name} (${payroll.telegram_id})`,
      `period_start: ${payroll.period_start}`,
      `period_end: ${payroll.cutoff_at}`,
      `snapshot: ${money(payroll, 'amount_snapshot_micros')}`,
      ...splitLines,
      `admin_id: ${payroll.current_admin_id}`,
      `confirmed_at: ${payroll.confirmed_at}`,
      `proof_count: ${proofRows.length}`,
      ...proofLines
    ].join('\n')
  };
}

async function dueOutboxRows(env, staleAt) {
  const rows = await env.DB.prepare(`
    SELECT payroll_id
    FROM payroll_email_outbox
    WHERE status = 'pending'
       OR (status = 'sending' AND claimed_at <= ?)
    ORDER BY created_at, payroll_id
  `).bind(staleAt).all();
  return rows.results || [];
}

async function claimOutboxRow(env, payrollId, claimedAt, staleAt) {
  return env.DB.prepare(`
    UPDATE payroll_email_outbox
    SET status = 'sending',
        attempt_count = attempt_count + 1,
        last_error = NULL,
        claimed_at = ?,
        updated_at = ?
    WHERE payroll_id = ?
      AND (
        status = 'pending'
        OR (status = 'sending' AND claimed_at <= ?)
      )
  `).bind(
    claimedAt,
    claimedAt,
    payrollId,
    staleAt
  ).run();
}

async function payrollEmailPayload(env, payrollId) {
  return env.DB.prepare(`
    SELECT
      d.*,
      o.recipient,
      s.name AS store_name,
      COALESCE(m.display_name, d.telegram_id) AS employee_name
    FROM payroll_email_outbox o
    JOIN payroll_disbursements d
      ON d.payroll_id = o.payroll_id
    JOIN stores s ON s.store_id = d.store_id
    LEFT JOIN store_members m
      ON m.store_id = d.store_id
     AND m.telegram_id = d.telegram_id
    WHERE o.payroll_id = ?
      AND o.status = 'sending'
      AND d.status = 'confirmed'
  `).bind(payrollId).first();
}

async function activeProofs(env, payrollId) {
  const rows = await env.DB.prepare(`
    SELECT method, sort_order, object_key
    FROM payroll_payment_proofs
    WHERE payroll_id = ?
      AND superseded_at IS NULL
    ORDER BY method, sort_order
  `).bind(payrollId).all();
  return rows.results || [];
}

async function releaseOutboxRow(
  env,
  payrollId,
  claimedAt,
  errorCode,
  updatedAt
) {
  await env.DB.prepare(`
    UPDATE payroll_email_outbox
    SET status = 'pending',
        last_error = ?,
        claimed_at = NULL,
        updated_at = ?
    WHERE payroll_id = ?
      AND status = 'sending'
      AND claimed_at = ?
  `).bind(
    String(errorCode).slice(0, 160),
    updatedAt,
    payrollId,
    claimedAt
  ).run();
}

export async function deliverPayrollEmailOutbox(
  env,
  now = new Date()
) {
  const nowIso = now.toISOString();
  const staleAt = new Date(
    now.getTime() - EMAIL_CLAIM_LEASE_MS
  ).toISOString();
  const rows = await dueOutboxRows(env, staleAt);
  const summary = {
    scanned: rows.length,
    sent: 0,
    failed: 0
  };

  for (const row of rows) {
    const claimed = await claimOutboxRow(
      env,
      row.payroll_id,
      nowIso,
      staleAt
    );
    if (Number(claimed.meta.changes) !== 1) continue;

    const config = payrollEmailConfig(env);
    if (!config.ready) {
      await releaseOutboxRow(
        env,
        row.payroll_id,
        nowIso,
        'email_not_configured',
        nowIso
      );
      summary.failed += 1;
      continue;
    }

    const payroll = await payrollEmailPayload(env, row.payroll_id);
    if (!payroll) {
      await releaseOutboxRow(
        env,
        row.payroll_id,
        nowIso,
        'email_payload_missing',
        nowIso
      );
      summary.failed += 1;
      continue;
    }
    if (!payroll.recipient) {
      await env.DB.prepare(`
        UPDATE payroll_email_outbox
        SET recipient = ?,
            updated_at = ?
        WHERE payroll_id = ?
          AND status = 'sending'
          AND claimed_at = ?
          AND recipient = ''
      `).bind(
        config.recipient,
        nowIso,
        payroll.payroll_id,
        nowIso
      ).run();
      payroll.recipient = config.recipient;
    }
    if (String(payroll.recipient) !== config.recipient) {
      await releaseOutboxRow(
        env,
        row.payroll_id,
        nowIso,
        'email_recipient_mismatch',
        nowIso
      );
      summary.failed += 1;
      continue;
    }

    const proofs = await activeProofs(env, payroll.payroll_id);
    const message = renderPayrollEmail(payroll, proofs);
    try {
      await env.PAYROLL_EMAIL.send({
        to: config.recipient,
        from: config.sender,
        subject: message.subject,
        text: message.text
      });
    } catch {
      await releaseOutboxRow(
        env,
        row.payroll_id,
        nowIso,
        'email_delivery_failed',
        nowIso
      );
      summary.failed += 1;
      continue;
    }

    const finalized = await env.DB.prepare(`
      UPDATE payroll_email_outbox
      SET status = 'sent',
          last_error = NULL,
          sent_at = ?,
          updated_at = ?
      WHERE payroll_id = ?
        AND status = 'sending'
        AND claimed_at = ?
    `).bind(
      nowIso,
      nowIso,
      row.payroll_id,
      nowIso
    ).run();
    if (Number(finalized.meta.changes) === 1) {
      summary.sent += 1;
    } else {
      summary.failed += 1;
    }
  }
  return summary;
}
