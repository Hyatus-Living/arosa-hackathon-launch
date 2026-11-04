const destinations = {
  'research.witharosa.ai': 'build.witharosa.ai',
  'www.witharosa.ai': 'witharosa.ai',
  'acres.witharosa.ai': 'build.witharosa.ai',
  'acres.hyatus.com': 'build.witharosa.ai',
  'build.hyatus.com': 'openclaw.witharosa.ai',
  'mcp.acres.hyatus.com': 'mcp.witharosa.ai',
};

export default {
  fetch(request) {
    const url = new URL(request.url);
    const host = destinations[url.hostname];
    if (!host) return new Response('Not found', {status:404});
    url.hostname = host;
    url.protocol = 'https:';
    return Response.redirect(url,302);
  },
};
