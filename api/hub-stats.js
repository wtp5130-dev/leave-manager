import { sql } from '@vercel/postgres';
import { ensureSchema } from './db.js';

export const config = { runtime: 'nodejs' };

export default async function handler(req, res) {
  try {
    const pendingApprovals = await getPendingApprovalsCount();
    res.status(200).json({ pendingApprovals });
  } catch (e) {
    // Be resilient: return 0 if anything goes wrong
    res.status(200).json({ pendingApprovals: 0 });
  }
}

async function getPendingApprovalsCount() {
  // Count leave requests with status PENDING
  await ensureSchema();
  const { rows } = await sql`SELECT COUNT(*)::int AS c FROM leaves WHERE status = 'PENDING'`;
  return Number(rows?.[0]?.c || 0);
}
