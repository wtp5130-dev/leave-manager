import { sql } from '@vercel/postgres';
import { ensureSchema, touchChange } from './db.js';
import { broadcastChange } from './realtime.js';
import { logAudit } from './audit-log.js';

export const config = { runtime: 'nodejs' };

export default async function handler(req, res) {
  try {
    await ensureSchema();
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');
    const l = req.body || {};
    console.log('leave.js: received request body:', JSON.stringify(l));
    
    // authorization logic
    const { requireAuth } = await import('./auth-helpers.js');
    const user = requireAuth(req, res); if(!user) return;
    console.log('leave.js: user authenticated:', user.id, user.role);

    // If approving/rejecting, require MANAGER/HR
    if ((l.status === 'APPROVED' || l.status === 'REJECTED') && !['MANAGER','HR'].includes(user.role)) {
      return res.status(403).json({ ok:false, error:'forbidden' });
    }

    // For edits on existing leave, prevent employees editing others' records
    let oldLeave = null;
    let isNew = true;
    if (l.id) {
      try {
        const { rows } = await sql`SELECT id, created_by, status, days FROM leaves WHERE id=${l.id}`;
        if (rows?.[0]) {
          // Existing record found: employees are not allowed to edit
          if (user.role === 'EMPLOYEE') {
            return res.status(403).json({ ok:false, error:'forbidden' });
          }
          const owner = rows[0]?.created_by;
          if(owner && owner !== user.id && user.role==='EMPLOYEE'){
            return res.status(403).json({ ok:false, error:'forbidden' });
          }
          oldLeave = rows[0];
          isNew = false;
        }
      } catch (e) {
        console.error('leave.js: error checking existing leave:', e);
      }
    }
    if (!l.id || !l.employeeId || !l.type) return res.status(400).json({ ok: false, error: 'id, employeeId, type required' });
    if (!l.reason || !String(l.reason).trim()) return res.status(400).json({ ok: false, error: 'reason required' });
    
    console.log('leave.js: inserting/updating leave:', l.id, 'emp:', l.employeeId, 'type:', l.type);
    await sql`INSERT INTO leaves (id, employee_id, type, status, applied, from_date, to_date, days, reason, approved_by, approved_at, created_by, updated_at)
              VALUES (${l.id}, ${l.employeeId}, ${l.type}, ${l.status||'PENDING'}, ${l.applied||null}, ${l.from||null}, ${l.to||null}, ${l.days||0}, ${l.reason||null}, ${l.approvedBy||null}, ${l.approvedAt||null}, ${user.id||null}, now())
              ON CONFLICT (id) DO UPDATE SET employee_id=excluded.employee_id, type=excluded.type, status=excluded.status, applied=excluded.applied, from_date=excluded.from_date, to_date=excluded.to_date, days=excluded.days, reason=excluded.reason, approved_by=excluded.approved_by, approved_at=excluded.approved_at, updated_at=now()`;
    console.log('leave.js: insert/update succeeded');
    
    // Log audit trail
    const action = isNew ? 'CREATE' : 'UPDATE';
    const statusChange = oldLeave && oldLeave.status !== (l.status || 'PENDING');
    if (statusChange && (l.status === 'APPROVED' || l.status === 'REJECTED')) {
      // Log approval/rejection separately
      await logAudit(user.id, user.email, l.status === 'APPROVED' ? 'APPROVE' : 'REJECT', 'LEAVE', l.id, `${l.type} leave (${l.from} to ${l.to})`, { status: oldLeave.status }, { status: l.status }, `Leave ${l.status === 'APPROVED' ? 'approved' : 'rejected'} by ${user.email}`);
    } else {
      // Log create/update
      await logAudit(user.id, user.email, action, 'LEAVE', l.id, `${l.type} leave (${l.from} to ${l.to})`, oldLeave ? { status: oldLeave.status, days: oldLeave.days } : null, { status: l.status || 'PENDING', days: l.days }, `Leave ${action.toLowerCase()}d`);
    }
    
    await touchChange();
    await broadcastChange({ scope: 'leave' });
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('leave endpoint error:', err);
    const msg = err?.message || 'internal error';
    res.status(500).json({ ok: false, error: msg });
  }
}

