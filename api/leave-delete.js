import { sql } from '@vercel/postgres';
import { ensureSchema, touchChange } from './db.js';
import { broadcastChange } from './realtime.js';
import { logAudit } from './audit-log.js';

export const config = { runtime: 'nodejs' };

export default async function handler(req, res) {
  try {
    await ensureSchema();
    const id = (req.query?.id||'').toString();
    if (!id) return res.status(400).json({ ok: false, error: 'id required' });
    
    // Get leave details for audit log
    const { rows } = await sql`SELECT * FROM leaves WHERE id=${id}`;
    const leave = rows?.[0];
    
    // Get current user
    const { requireAuth } = await import('./auth-helpers.js');
    const user = requireAuth(req, res);
    if(!user) return;
    
    // Check authorization - only employee who created it or managers can delete
    if (leave && leave.created_by !== user.id && !['MANAGER','HR'].includes(user.role)) {
      return res.status(403).json({ ok: false, error: 'forbidden' });
    }
    
    await sql`DELETE FROM leaves WHERE id=${id}`;
    
    // Log audit trail
    if (leave) {
      await logAudit(user.id, user.email, 'DELETE', 'LEAVE', id, `${leave.type} leave (${leave.from_date} to ${leave.to_date})`, { status: leave.status, days: leave.days, type: leave.type }, null, `Leave deleted by ${user.email}`);
    }
    
    await touchChange();
    await broadcastChange({ scope: 'leave' });
    res.status(200).json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
}
