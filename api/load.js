import { list } from '@vercel/blob';

export const config = { runtime: 'nodejs' };

export default async function handler(req, res) {
  const id = (req.query?.id || 'default').toString().replace(/[^a-zA-Z0-9_-]/g, '');
  try {
    const l = await list({ prefix: `leave/${id}.json` });
    if (!l.blobs.length) {
      res.status(404).json({ ok: false, error: 'not found' });
      return;
    }
    const url = l.blobs[0].url;
    const r = await fetch(url);
    const text = await r.text();
    res.setHeader('content-type', 'application/json');
    res.status(200).send(text);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
}
