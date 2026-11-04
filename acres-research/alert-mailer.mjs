// Transactional email for user alerts via the SendGrid v3 HTTP API (the existing Twilio
// SendGrid account; no SDK dependency). The API key comes from Google Secret Manager
// (acres-sendgrid-api-key, a Mail-Send-only restricted key) through the normal secrets
// pull as SENDGRID_API_KEY. Until that secret exists the mailer reports configured=false
// and the runner holds queued mail instead of failing or dropping it, so alert rules can
// be created and tested before sending is activated. Sending also needs the From domain
// authenticated in SendGrid (witharosa.ai, whitelabel id 33542435) — until its DNS records
// validate, SendGrid rejects sends and the outbox retries with backoff.

function parseFrom(from) {
  const match = String(from).match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  if (match) return {name: match[1] || undefined, email: match[2]};
  return {email: String(from).trim()};
}

export function createMailer({apiKey = '', from = 'Arosa Alerts <alerts@witharosa.ai>', fetchImpl = fetch, timeoutMs = 15000} = {}) {
  const configured = typeof apiKey === 'string' && apiKey.startsWith('SG.') && apiKey.length >= 20;
  // unsubscribeUrl becomes the one-click List-Unsubscribe header (RFC 8058) that mail apps show.
  async function send({to, subject, text, unsubscribeUrl}) {
    if (!configured) throw new Error('Email sending is not configured yet (SENDGRID_API_KEY missing).');
    if (!to || !subject || !text || !unsubscribeUrl) throw new Error('Alert email needs a recipient, subject, body and unsubscribe link.');
    const res = await fetchImpl('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {authorization: `Bearer ${apiKey}`, 'content-type': 'application/json'},
      body: JSON.stringify({
        personalizations: [{to: [{email: to}]}],
        from: parseFrom(from),
        subject,
        content: [{type: 'text/plain', value: text}],
        headers: {'List-Unsubscribe': `<${unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'},
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      let detail = '';
      try {
        const body = await res.json();
        detail = (body.errors || []).map(e => e.message).filter(Boolean).join('; ').slice(0, 200);
      } catch { /* status alone is enough */ }
      throw new Error(`SendGrid returned HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
    }
    return {id: res.headers?.get?.('x-message-id') ?? null};
  }
  return {configured, from, send};
}

export function mailerFromSecrets(secrets = {}, extra = {}) {
  return createMailer({apiKey: secrets.SENDGRID_API_KEY || '', from: secrets.ALERTS_FROM || undefined, ...extra});
}
