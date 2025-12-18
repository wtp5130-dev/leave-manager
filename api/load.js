import { list } from '@vercel/blob';

export const config = { runtime: 'edge' };

export default async function handler(req) {
  const { searchParams } = new URL(req.url);
  const id = (searchParams.get('id') || 'default').replace(/[^a-zA-Z0-9_-]/g, '');
  try {
    const l = await list({ prefix: `leave/${id}.json` });
    if (!l.blobs.length) {
      return new Response(JSON.stringify({ ok: false, error: 'not found' }), {
        status: 404,
        headers: { 'content-type': 'application/json' }
      });
    }
    const url = l.blobs[0].url;
    const r = await fetch(url);
    const text = await r.text();
    // Pass through the JSON (DB format)
    return new Response(text, { headers: { 'content-type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: err.message }), {
      status: 500,
      headers: { 'content-type': 'application/json' }
    });
  }
}
