import { sql } from '@vercel/postgres';
import { requireAuth } from './auth-helpers.js';

export const config = { runtime: 'nodejs' };

export default async function handler(req, res){
  try{
    const user = requireAuth(req, res, ['HR','MANAGER']); if(!user) return;
    const email = (req.query?.email || '').toString().trim().toLowerCase();
    if(!email) return res.status(400).json({ ok:false, error:'email required' });

    const users = await sql`SELECT id, email, name, role FROM users WHERE lower(email) = ${email}`;
    const employees = await sql`SELECT id, name, email, role FROM employees WHERE lower(email) = ${email}`;

    const result = {
      ok: true,
      queryEmail: email,
      users: users.rows,
      employees: employees.rows,
      status: ''
    };

    if(employees.rows.length === 0){
      result.status = 'no-employee';
    }else if(users.rows.length === 0){
      result.status = 'no-user';
    }else{
      result.status = 'ok';
    }

    res.status(200).json(result);
  }catch(e){
    console.error('mapping-check error:', e);
    res.status(500).json({ ok:false, error:e.message });
  }
}
