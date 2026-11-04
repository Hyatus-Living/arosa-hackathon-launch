import {ALERT_KINDS, ALERT_CADENCES} from './alerts.mjs';

// Chat management of the signed-in user's own email alerts. The handle is bound to the
// run's account by the service (mirroring the architecture plan tools), so a tool call can
// only ever read or change that account's rules, and mail only ever goes to the email the
// identity provider verified for the account — never an address typed in chat.

export const manageAlertsDefinition = {
  name: 'acres_manage_alerts',
  description: 'Manage the signed-in user\'s email alerts (sent to the email on their Arosa account). Kinds: "finished" (their research runs and walkthrough renders complete or fail), "activity" (someone else changes a site they can access: site data, floor-plan revisions, drawings, renders), "listings" (new deal-store listings match criteria). Each rule is "instant" (emailed within about a minute) or "daily" (one morning digest). Use op=list to show current alerts before changing them; op=test queues a test email. Always report the returned rules back in plain language, including the destination email and whether delivery is active yet.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      op: {type: 'string', enum: ['list', 'create', 'update', 'pause', 'resume', 'delete', 'master', 'test'], description: 'What to do. pause/resume/delete/update need ruleId from a prior list.'},
      ruleId: {type: 'string', description: 'Rule id from op=list, for update/pause/resume/delete.'},
      kind: {type: 'string', enum: ALERT_KINDS, description: 'finished | activity | listings (create; optional on update).'},
      cadence: {type: 'string', enum: ALERT_CADENCES, description: 'instant | daily (default instant).'},
      projectId: {type: 'string', description: 'Limit a finished/activity rule to one site (default: every site the user can access). Not used for listings.'},
      criteria: {
        type: 'object', additionalProperties: false, description: 'Listings rules only; same filters as the deal store.',
        properties: {
          borough: {type: 'string'}, zipCode: {type: 'string'}, area: {type: 'string'}, zoningPrefix: {type: 'string'},
          styles: {type: 'array', items: {type: 'string', enum: ['land', 'multi_family', 'townhomes', 'single_family', 'duplex_triplex']}},
          minListPrice: {type: 'number', minimum: 0}, maxListPrice: {type: 'number', minimum: 0},
          minUnusedZfa: {type: 'number', minimum: 0}, maxPricePerBuildableZfa: {type: 'number', minimum: 0},
          dealVerdict: {type: 'string', enum: ['great_deal', 'good_deal', 'fair_deal', 'full_price', 'unpriced_opportunity', 'great_deal,good_deal']},
          excludeLandmarks: {type: 'boolean'},
          mihArea: {type: 'string', enum: ['inside', 'outside'], description: 'Only parcels inside, or confirmed outside, a mapped Mandatory Inclusionary Housing area.'},
        },
      },
      enabled: {type: 'boolean', description: 'For op=master: turn all of the user\'s alerts on or off at once.'},
    },
    required: ['op'],
  },
};

export function createAlertTools({alerts} = {}) {
  if (!alerts) return {definitions: [], handlers: {}};
  const snapshot = note => ({
    email: alerts.email,
    alertsEnabled: alerts.prefs().enabled,
    emailDeliveryActive: alerts.deliveryConfigured(),
    ...(alerts.deliveryConfigured() ? {} : {deliveryNote: 'Alert rules are saved now; email delivery activates as soon as the sending service is switched on for this workspace. Nothing is lost meanwhile; matching events queue up.'}),
    rules: alerts.list(),
    ...(note ? {note} : {}),
  });
  async function manage(args = {}) {
    const {op, ruleId, ...rest} = args;
    if (op === 'list') return snapshot();
    if (op === 'create') {
      const rule = alerts.create({kind: rest.kind, cadence: rest.cadence, projectId: rest.projectId ?? null, criteria: rest.criteria ?? {}});
      return snapshot(`Created ${rule.cadence} ${rule.kind} alert ${rule.id}.`);
    }
    if (op === 'master') {
      if (typeof rest.enabled !== 'boolean') throw new Error('For op=master, pass enabled=true or enabled=false.');
      alerts.setEnabled(rest.enabled);
      return snapshot(rest.enabled ? 'All your alerts are on.' : 'All your alerts are off. Rules are kept; turn them back on any time.');
    }
    if (op === 'test') {
      alerts.test();
      return snapshot(alerts.deliveryConfigured() ? 'A test email is on its way (within about a minute).' : 'A test email is queued; it will send once email delivery is activated for this workspace.');
    }
    if (!ruleId) throw new Error(`For op=${op}, pass ruleId from op=list.`);
    if (op === 'update') return snapshot(`Updated alert ${alerts.update(ruleId, rest).id}.`);
    if (op === 'pause') return snapshot(`Paused alert ${alerts.update(ruleId, {paused: true}).id}.`);
    if (op === 'resume') return snapshot(`Resumed alert ${alerts.update(ruleId, {paused: false}).id}.`);
    if (op === 'delete') { alerts.remove(ruleId); return snapshot(`Deleted alert ${ruleId}.`); }
    throw new Error(`Unknown op "${op}".`);
  }
  return {definitions: [manageAlertsDefinition], handlers: {acres_manage_alerts: manage}};
}
