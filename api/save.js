import { put } from '@vercel/blob';

// Use Node.js runtime for broader module support
export const config = { runtime: 'nodejs18.x' };

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).send('Method Not Allowed');
    return;
  }
  const id = (req.query?.id || 'default').toString().replace(/[^a-zA-Z0-9_-]/g, '');
  const bodyText = typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {});
  try {
    const blob = await put(`leave/${id}.json`, bodyText, {
      access: 'public',
      addRandomSuffix: false,
      contentType: 'application/json',
      cacheControlMaxAge: 0
    });
    res.status(200).json({ ok: true, url: blob.url });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
}
