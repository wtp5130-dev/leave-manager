import { OAuth2Client } from 'google-auth-library';
import { sql } from '@vercel/postgres';
import { ensureSchema } from './db.js';
import { setSessionCookie } from './auth-helpers.js';

export const config = { runtime: 'nodejs' };

export default async function handler(req, res){
  try{
    if(req.method !== 'POST') return res.status(405).send('Method Not Allowed');
    await ensureSchema();
    const { idToken } = req.body || {};
    if(!idToken) return res.status(400).json({ ok:false, error:'idToken required' });

    const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
    const ticket = await client.verifyIdToken({ idToken, audience: process.env.GOOGLE_CLIENT_ID });
    const payload = ticket.getPayload();
    const sub = payload.sub;
    const email = payload.email;
    const name = payload.name || '';
    const picture = payload.picture || '';

    // Check if user is registered (email must be in users table)
    const checkUser = await sql`SELECT id, email, name, picture, role FROM users WHERE email = ${email}`;
    if (checkUser.rows.length === 0) {
      return res.status(403).json({ ok: false, error: 'User not registered. Contact your administrator.' });
    }

    const existingUser = checkUser.rows[0];

    // Update user's Google ID and profile info if not already set
    await sql`UPDATE users 
              SET id = COALESCE(id, ${sub}), name = ${name}, picture = ${picture}, updated_at = now()
              WHERE email = ${email}`;

    const { rows } = await sql`SELECT id, email, name, picture, role FROM users WHERE email = ${email}`;
    const user = rows[0];
    setSessionCookie(res, { id:user.id, email:user.email, name:user.name, picture:user.picture, role:user.role });
    res.status(200).json({ ok:true, user });
  }catch(err){
    res.status(500).json({ ok:false, error: err.message });
  }
}
