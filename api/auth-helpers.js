import jwt from 'jsonwebtoken';

export const config = { runtime: 'nodejs' };

const COOKIE_NAME = 'session';
function parseCookies(req){
  const str = req.headers?.cookie || '';
  const obj = {};
  str.split(';').forEach(p=>{ const [k,...v]=p.trim().split('='); if(k) obj[k]=decodeURIComponent(v.join('=')); });
  return obj;
}

export function getUserFromRequest(req){
  try{
    const cookies = parseCookies(req);
    const token = cookies[COOKIE_NAME]; if(!token) return null;
    const data = jwt.verify(token, process.env.AUTH_SECRET || 'dev-secret');
    return data?.user || null;
  }catch{ return null; }
}

export function requireAuth(req, res, roles){
  const user = getUserFromRequest(req);
  if(!user){ res.status(401).json({ ok:false, error:'unauthorized' }); return null; }
  if(roles && roles.length && !roles.includes(user.role)){
    res.status(403).json({ ok:false, error:'forbidden' }); return null;
  }
  return user;
}

export function setSessionCookie(res, user){
  const token = jwt.sign({ user }, process.env.AUTH_SECRET || 'dev-secret', { expiresIn:'7d' });
  const cookie = `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800; ${process.env.VERCEL ? 'Secure;' : ''}`;
  res.setHeader('set-cookie', cookie);
}

export function clearSessionCookie(res){
  res.setHeader('set-cookie', `${COOKIE_NAME}=; Path=/; Max-Age=0; ${process.env.VERCEL ? 'Secure;' : ''}`);
}
