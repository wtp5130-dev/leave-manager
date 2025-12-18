import { sql } from '@vercel/postgres';
import { ensureSchema } from './db.js';

export const config = { runtime: 'nodejs' };

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ ok: false, error: 'Method not allowed' });
    }

    await ensureSchema();

    const { email, name } = req.body || {};
    const setupToken = req.headers['x-setup-token'] || req.query.token || '';

    // Verify setup token matches environment variable
    const expectedToken = process.env.SETUP_TOKEN || '';
    if (!setupToken || setupToken !== expectedToken) {
      return res.status(401).json({ ok: false, error: 'Invalid or missing setup token' });
    }

    if (!email) {
      return res.status(400).json({ ok: false, error: 'Email required' });
    }

    // Check if any HR or MANAGER users already exist
    const existing = await sql`
      SELECT id FROM users WHERE role IN ('HR', 'MANAGER')
    `;

    if (existing.rows.length > 0) {
      return res.status(409).json({ 
        ok: false, 
        error: 'Admin user already exists. Use the app to manage users.' 
      });
    }

    // Create the first admin user
    const result = await sql`
      INSERT INTO users (email, name, role)
      VALUES (${email}, ${name || email.split('@')[0]}, 'HR')
      ON CONFLICT (email) DO UPDATE 
      SET role = 'HR', updated_at = now()
      RETURNING id, email, name, role, created_at
    `;

    res.status(201).json({ 
      ok: true, 
      user: result.rows[0],
      message: 'Admin user created successfully. You can now sign in with Google.'
    });
  } catch (e) {
    console.error('setup-admin error:', e);
    res.status(500).json({ ok: false, error: 'Setup failed: ' + e.message });
  }
}
