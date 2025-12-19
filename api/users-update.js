import { sql } from '@vercel/postgres';
import { requireAuth } from './auth-helpers.js';
import { logAudit } from './audit-log.js';

export const config = { runtime: 'nodejs' };

export default async function handler(req, res) {
  const user = await requireAuth(req, res, ['HR', 'MANAGER']);
  if (res.headersSent) return;

  const { id, role } = req.body || {};

  if (!id || !role) {
    return res.status(400).json({ ok: false, error: 'User ID and role required' });
  }

  if (!['EMPLOYEE', 'MANAGER', 'HR'].includes(role)) {
    return res.status(400).json({ ok: false, error: 'Invalid role' });
  }

  try {
    // Check if user exists
    const existing = await sql`SELECT * FROM users WHERE id = ${id}`;
    if (existing.rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'User not found' });
    }

    const oldUser = existing.rows[0];

    // Update role
    const result = await sql`
      UPDATE users SET role = ${role} WHERE id = ${id}
      RETURNING id, email, name, picture, role, created_at
    `;

    // Log audit trail
    await logAudit(user.id, user.email, 'UPDATE', 'USER', id, oldUser.email, { role: oldUser.role }, { role }, `User role updated to ${role} by ${user.email}`);

    res.status(200).json({ ok: true, user: result.rows[0] });
  } catch (e) {
    console.error('users-update error:', e);
    res.status(500).json({ ok: false, error: 'Failed to update user' });
  }
}
