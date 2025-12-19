import { sql } from '@vercel/postgres';
import { ensureSchema, touchChange } from './db.js';
import { broadcastChange } from './realtime.js';
import { logAudit } from './audit-log.js';

export const config = { runtime: 'nodejs' };

export default async function handler(req, res) {
  try {
    await ensureSchema();
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');
    const { requireAuth } = await import('./auth-helpers.js');
    const user = requireAuth(req, res, ['HR','MANAGER']); if(!user) return;
    const { id, name, jobTitle, department, dateJoined, email, role, entitlement } = req.body || {};
    if (!id || !name) return res.status(400).json({ ok: false, error: 'id and name required' });

    let isNewEmployee = true;
    let oldEmployee = null;

    try {
      // Try to check if employee exists
      const existing = await sql`SELECT * FROM employees WHERE id = ${id}`;
      
      if (existing.rows.length > 0) {
        // Update existing
        oldEmployee = existing.rows[0];
        isNewEmployee = false;
        await sql`UPDATE employees 
                  SET name = ${name}, 
                      job_title = ${jobTitle||null}, 
                      department = ${department||null}, 
                      date_joined = ${dateJoined||null}, 
                      email = ${email||null}, 
                      role = ${role||'EMPLOYEE'},
                      updated_at = now()
                  WHERE id = ${id}`;
      } else {
        // Insert new
        await sql`INSERT INTO employees (id, name, job_title, department, date_joined, email, role)
                  VALUES (${id}, ${name}, ${jobTitle||null}, ${department||null}, ${dateJoined||null}, ${email||null}, ${role||'EMPLOYEE'})`;
      }
    } catch (e) {
      console.error('Employee insert/update error:', e);
      throw e;
    }

    if (entitlement && entitlement.year) {
      try {
        const existing = await sql`SELECT * FROM entitlements WHERE employee_id = ${id} AND year = ${entitlement.year}`;
        if (existing.rows.length > 0) {
          await sql`UPDATE entitlements SET carry = ${entitlement.carry||0}, current = ${entitlement.current||0} WHERE employee_id = ${id} AND year = ${entitlement.year}`;
        } else {
          await sql`INSERT INTO entitlements (employee_id, year, carry, current) VALUES (${id}, ${entitlement.year}, ${entitlement.carry||0}, ${entitlement.current||0})`;
        }
      } catch (e) {
        console.error('Entitlement insert/update error:', e);
        throw e;
      }
    }

    // Log audit trail
    const action = isNewEmployee ? 'CREATE' : 'UPDATE';
    await logAudit(user.id, user.email, action, 'EMPLOYEE', id, name, oldEmployee ? { name: oldEmployee.name, role: oldEmployee.role } : null, { name, role: role || 'EMPLOYEE' }, `Employee ${action.toLowerCase()}d`);

    await touchChange();
    await broadcastChange({ scope: 'employee' });
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('employee endpoint error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
}
