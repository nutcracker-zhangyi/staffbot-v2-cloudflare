import { isGlobalAdmin } from './security.js';
import { isStoreAdmin, isStoreOwner } from './stores.js';

const CLAIM_LEASE_MS = 15 * 60 * 1000;

function claimTimes(now) {
  const claimedAt = new Date(now).toISOString();
  return {
    claimedAt,
    leaseExpiresAt: new Date(new Date(now).getTime() + CLAIM_LEASE_MS).toISOString()
  };
}

async function getTaskClaim(env, task) {
  return env.DB.prepare(`
    SELECT * FROM admin_task_claims
    WHERE task_type = ? AND task_id = ?
  `).bind(task.task_type, task.task_id).first();
}

export async function claimTask(env, actorId, task, now) {
  const actor = String(actorId);
  if (!await isStoreAdmin(env, actor, task.store_id)) {
    throw new Error('forbidden');
  }
  const { claimedAt, leaseExpiresAt } = claimTimes(now);
  await env.DB.prepare(`
    INSERT INTO admin_task_claims (
      task_type, task_id, store_id, claimed_by,
      claimed_at, lease_expires_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(task_type, task_id) DO UPDATE SET
      store_id = excluded.store_id,
      claimed_by = excluded.claimed_by,
      claimed_at = CASE
        WHEN admin_task_claims.claimed_by = excluded.claimed_by
          THEN admin_task_claims.claimed_at
        ELSE excluded.claimed_at
      END,
      lease_expires_at = excluded.lease_expires_at,
      updated_at = excluded.updated_at
    WHERE admin_task_claims.store_id = excluded.store_id
      AND (
        admin_task_claims.claimed_by = excluded.claimed_by
        OR admin_task_claims.lease_expires_at <= excluded.updated_at
      )
  `).bind(
    task.task_type,
    task.task_id,
    task.store_id,
    actor,
    claimedAt,
    leaseExpiresAt,
    claimedAt
  ).run();

  const claim = await getTaskClaim(env, task);
  if (
    !claim
    || claim.store_id !== task.store_id
    || String(claim.claimed_by) !== actor
    || claim.lease_expires_at <= claimedAt
  ) {
    throw new Error('task_claimed');
  }
  return claim;
}

export async function renewTaskClaim(env, actorId, task, now) {
  return claimTask(env, actorId, task, now);
}

export async function releaseTaskClaim(env, actorId, task, now) {
  const releasedAt = new Date(now).toISOString();
  await env.DB.prepare(`
    DELETE FROM admin_task_claims
    WHERE task_type = ? AND task_id = ? AND store_id = ?
      AND claimed_by = ? AND lease_expires_at > ?
  `).bind(
    task.task_type,
    task.task_id,
    task.store_id,
    String(actorId),
    releasedAt
  ).run();
}

export async function requireActiveTaskClaim(env, actorId, task, now) {
  const claim = await env.DB.prepare(`
    SELECT * FROM admin_task_claims
    WHERE task_type = ? AND task_id = ? AND store_id = ?
      AND claimed_by = ? AND lease_expires_at > ?
  `).bind(
    task.task_type,
    task.task_id,
    task.store_id,
    String(actorId),
    new Date(now).toISOString()
  ).first();
  if (!claim) throw new Error('task_claim_required');
  return claim;
}

export async function forceTakeoverTask(env, actorId, task, reason, now) {
  const actor = String(actorId);
  if (
    !isGlobalAdmin(env, actor)
    && !await isStoreOwner(env, actor, task.store_id)
  ) {
    throw new Error('forbidden');
  }

  const { claimedAt, leaseExpiresAt } = claimTimes(now);
  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO admin_audit_logs (
        store_id, admin_id, action, target_id, details_json, created_at
      ) SELECT
        ?, ?, 'force_takeover_task', ?,
        json_object(
          'task_type', ?,
          'prior_actor', (
            SELECT claimed_by FROM admin_task_claims
            WHERE task_type = ? AND task_id = ? AND store_id = ?
          ),
          'new_actor', ?,
          'reason', ?,
          'time', ?
        ), ?
      WHERE NOT EXISTS (
        SELECT 1 FROM admin_task_claims
        WHERE task_type = ? AND task_id = ? AND store_id <> ?
      )
    `).bind(
      task.store_id,
      actor,
      task.task_id,
      task.task_type,
      task.task_type,
      task.task_id,
      task.store_id,
      actor,
      String(reason),
      claimedAt,
      claimedAt,
      task.task_type,
      task.task_id,
      task.store_id
    ),
    env.DB.prepare(`
      INSERT INTO admin_task_claims (
        task_type, task_id, store_id, claimed_by,
        claimed_at, lease_expires_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_type, task_id) DO UPDATE SET
        store_id = excluded.store_id,
        claimed_by = excluded.claimed_by,
        claimed_at = excluded.claimed_at,
        lease_expires_at = excluded.lease_expires_at,
        updated_at = excluded.updated_at
      WHERE admin_task_claims.store_id = excluded.store_id
    `).bind(
      task.task_type,
      task.task_id,
      task.store_id,
      actor,
      claimedAt,
      leaseExpiresAt,
      claimedAt
    )
  ]);

  return requireActiveTaskClaim(env, actor, task, now);
}
