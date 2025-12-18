import { sql } from '@vercel/postgres';
import { requireAuth } from './auth-helpers.js';
import { logAudit } from './audit-log.js';
import { randomUUID } from 'crypto';

export const config = { runtime: 'nodejs' };

export default async function handler(req, res) {
  const user = await requireAuth(req, res, ['HR', 'MANAGER']);
  if (res.headersSent) return;

  const { email, name, role } = req.body || {};

  if (!email || !name) {
    return res.status(400).json({ ok: false, error: 'Email and name required' });
  }

  if (!['EMPLOYEE', 'MANAGER', 'HR'].includes(role)) {
    return res.status(400).json({ ok: false, error: 'Invalid role' });
  }

  try {
    // Check if user already exists
    const existing = await sql`SELECT id FROM users WHERE email = ${email}`;
    if (existing.rows.length > 0) {
      return res.status(409).json({ ok: false, error: 'User already exists' });
    }

    // Generate UUID for new user (will be replaced with Google sub on first login)
    const userId = randomUUID();

    // Create new user (without Google sub, will be set on first login)
    const result = await sql`
      INSERT INTO users (id, email, name, role)
      VALUES (${userId}, ${email}, ${name}, ${role || 'EMPLOYEE'})
      RETURNING id, email, name, picture, role, created_at
    `;

    // Log audit trail
    await logAudit(user.id, user.email, 'CREATE', 'USER', userId, email, null, { email, name, role }, `User created by ${user.email}`);

    res.status(201).json({ ok: true, user: result.rows[0] });
  } catch (e) {
    console.error('users-create error:', e);
    res.status(500).json({ ok: false, error: 'Failed to create user' });
  }
}
