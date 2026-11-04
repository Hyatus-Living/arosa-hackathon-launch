export default {
  async fetch(request, env) {
    const incoming = new URL(request.url);
    if (incoming.hostname !== 'mcp.witharosa.ai') return new Response('Not found', {status: 404});
    const target = new URL(env.UPSTREAM_ORIGIN);
    target.pathname = incoming.pathname;
    target.search = incoming.search;
    const forwarded = new Request(target, request);
    forwarded.headers.delete('host');
    return fetch(forwarded, {redirect: 'manual'});
  }
};
