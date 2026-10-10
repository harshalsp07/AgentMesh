// site/_worker.js — Cloudflare Pages Advanced Edge Worker
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Add CORS headers to all responses
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, PUT, DELETE',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Mesh-Actor, X-Mesh-Token',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // Try serving the static asset from Pages asset bucket
    let response = await env.ASSETS.fetch(request);

    // If 404 and not an API call, fallback to index.html (SPA client routing)
    if (response.status === 404 && !url.pathname.startsWith('/api/') && !url.pathname.startsWith('/a2a/')) {
      const indexReq = new Request(new URL('/index.html', request.url), request);
      response = await env.ASSETS.fetch(indexReq);
    }

    // Clone response to add CORS & security headers
    const newHeaders = new Headers(response.headers);
    for (const [k, v] of Object.entries(corsHeaders)) {
      newHeaders.set(k, v);
    }
    newHeaders.set('X-Content-Type-Options', 'nosniff');

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: newHeaders,
    });
  },
};
