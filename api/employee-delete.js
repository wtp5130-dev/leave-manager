import { sql } from '@vercel/postgres';
import { ensureSchema, touchChange } from './db.js';
import { broadcastChange } from './realtime.js';
import { logAudit } from './audit-log.js';

export const config = { runtime: 'nodejs' };

export default async function handler(req, res) {
  try {
    await ensureSchema();
    const { requireAuth } = await import('./auth-helpers.js');
    const user = requireAuth(req, res, ['HR','MANAGER']); if(!user) return;
    const id = (req.query?.id||'').toString();
    if (!id) return res.status(400).json({ ok: false, error: 'id required' });
    
    // Get employee details for audit log
    const { rows } = await sql`SELECT * FROM employees WHERE id=${id}`;
    const employee = rows?.[0];
    
    await sql`DELETE FROM employees WHERE id=${id}`;
    
    // Log audit trail
    if (employee) {
      await logAudit(user.id, user.email, 'DELETE', 'EMPLOYEE', id, employee.name, { name: employee.name, role: employee.role, email: employee.email }, null, `Employee deleted by ${user.email}`);
    }
    
    await touchChange();
    await broadcastChange({ scope: 'employee' });
    res.status(200).json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
}
