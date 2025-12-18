import { put } from '@vercel/blob';

export const config = { runtime: 'edge' };

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }
  const { searchParams } = new URL(req.url);
  const id = (searchParams.get('id') || 'default').replace(/[^a-zA-Z0-9_-]/g, '');
  const bodyText = await req.text();
  try {
    // Store as public for simplicity. Switch to 'private' and serve via signed URLs if needed.
    const blob = await put(`leave/${id}.json`, bodyText, {
      access: 'public',
      addRandomSuffix: false,
      contentType: 'application/json',
      cacheControlMaxAge: 0
    });
    return new Response(JSON.stringify({ ok: true, url: blob.url }), {
      headers: { 'content-type': 'application/json' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: err.message }), {
      status: 500, headers: { 'content-type': 'application/json' }
    });
  }
}
