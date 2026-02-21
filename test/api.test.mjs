import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import crypto from 'node:crypto';

process.env.NODE_ENV = 'test';
process.env.DATABASE_PATH = `./test-data-${Date.now()}.json`;
process.env.WEBHOOK_UPI_SECRET = 'upi-secret';

const { buildServer } = await import('../src/server.mjs');
const server = await buildServer();
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const { port } = server.address();
const base = `http://127.0.0.1:${port}`;

const sign = (payload) => crypto.createHmac('sha256', 'upi-secret').update(JSON.stringify(payload)).digest('hex');

async function call(path, method = 'GET', body, token, headers = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: res.status, data: await res.json() };
}

test('growth stack: funnel + bio + attribution + segments + workflows + intelligence', async () => {
  const reg = await call('/api/auth/register', 'POST', { email: `g-${Date.now()}@t.com`, password: 'password123', displayName: 'Growth' });
  const token = reg.data.token;
  await call('/api/billing/upgrade-plan', 'POST', { plan: 'growth' }, token);
  const creatorId = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString()).creatorId;

  const aud = await call('/api/audience', 'POST', { email: 'fan@g.com', segment: 'trading', source: 'reel_1' }, token);
  await call('/api/push/subscribe', 'POST', { audienceUserId: aud.data.audienceUserId, endpoint: 'https://push.example/ok', device: 'android' }, token);

  const funnelTemplates = await call('/api/funnel/templates', 'GET', undefined, token);
  assert.equal(funnelTemplates.status, 200);
  const funnel = await call('/api/funnels', 'POST', { name: 'Trading Funnel', slug: 'trade-funnel', templateId: 'lead-magnet', blocks: [{ title: 'Hook', text: 'Free value' }] }, token);
  assert.equal(funnel.status, 200);
  const bioTemplates = await call('/api/bio-link/templates', 'GET', undefined, token);
  assert.equal(bioTemplates.status, 200);
  const bio = await call('/api/bio-links', 'POST', { title: 'Links', slug: 'creator-links', template: 'creator-pro', links: [{ label: 'Funnel', url: funnel.data.publicUrl }] }, token);
  assert.equal(bio.status, 200);

  const track = await call('/api/traffic/track', 'POST', { creatorId, path: funnel.data.publicUrl, source: 'instagram', medium: 'reel', campaign: 'jan' });
  assert.equal(track.status, 200);
  const attr = await call('/api/attribution/dashboard', 'GET', undefined, token);
  assert.equal(attr.status, 200);
  assert.equal(attr.data.bySource.instagram, 1);

  const ops = await call('/api/segments/operators', 'GET', undefined, token);
  assert.equal(ops.status, 200);
  const rule = await call('/api/segments/rules', 'POST', { name: 'trading-rule', combinator: 'AND', conditions: [{ field: 'segment', op: 'eq', value: 'trading' }, { field: 'source', op: 'eq', value: 'reel_1' }] }, token);
  const prev = await call(`/api/segments/preview/${rule.data.ruleId}`, 'GET', undefined, token);
  assert.equal(prev.data.count, 1);

  const campaign = await call('/api/campaigns', 'POST', { name: 'AB', message: 'Hi', segment: 'trading-rule', variants: [{ id: 'A', message: 'A' }, { id: 'B', message: 'B' }] }, token);
  await call(`/api/campaigns/${campaign.data.campaignId}/send`, 'POST', {}, token);
  await call('/api/workers/run', 'POST', {});
  await call('/api/push/events/open', 'POST', { campaignId: campaign.data.campaignId, variantId: 'A', audienceUserId: aud.data.audienceUserId, device: 'android' });
  const pa = await call(`/api/push/analytics/${campaign.data.campaignId}`, 'GET', undefined, token);
  assert.equal(pa.status, 200);

  const wf = await call('/api/automations/workflows', 'POST', { name: 'Branch', nodes: [{ id: 's', type: 'start' }, { id: 'v', type: 'value' }, { id: 'o', type: 'offer' }], edges: [{ from: 's', to: 'v', condition: 'default' }, { from: 'v', to: 'o', condition: 'if_clicked' }] }, token);
  const sim = await call(`/api/automations/workflows/${wf.data.workflowId}/simulate`, 'POST', { context: { opened: true, clicked: true, purchased: false } }, token);
  assert.equal(sim.status, 200);

  const intel = await call('/api/intelligence/best-send-time', 'GET', undefined, token);
  assert.equal(intel.status, 200);
  assert.ok(['low','medium','high'].includes(intel.data.confidence));
});

test('payments hardening: coupons/webhook-signature/subscriptions/dispute/refund', async () => {
  const reg = await call('/api/auth/register', 'POST', { email: `p-${Date.now()}@t.com`, password: 'password123', displayName: 'Pay' });
  const token = reg.data.token;
  const aud = await call('/api/audience', 'POST', { email: 'pay@x.com' }, token);
  await call('/api/coupons', 'POST', { code: 'NEW50', type: 'percent', value: 50 }, token);
  const checkout = await call('/api/payments/checkout', 'POST', { audienceUserId: aud.data.audienceUserId, amountInPaise: 10000, method: 'upi_intent', couponCode: 'NEW50', upsellOfferId: 'upsell_1' }, token);

  const payload = { eventId: `evt_${Date.now()}`, paymentId: checkout.data.paymentId, status: 'success', providerPaymentId: 'pay_1' };
  const bad = await call('/api/payments/webhooks/upi', 'POST', payload, undefined, { 'x-provider-signature': 'bad' });
  assert.equal(bad.status, 401);
  const good = await call('/api/payments/webhooks/upi', 'POST', payload, undefined, { 'x-provider-signature': sign(payload) });
  assert.equal(good.status, 200);

  const sub = await call('/api/subscriptions/create', 'POST', { audienceUserId: aud.data.audienceUserId, planCode: 'pro', interval: 'monthly' }, token);
  const inv = await call(`/api/subscriptions/${sub.data.subscriptionId}/renew`, 'POST', {}, token);
  await call('/api/invoices/mark-failed', 'POST', { invoiceId: inv.data.invoiceId }, token);
  await call('/api/workers/run', 'POST', {});

  const refund = await call('/api/payments/refund', 'POST', { paymentId: checkout.data.paymentId }, token);
  assert.equal(refund.status, 200);
  const dispute = await call('/api/payments/disputes', 'POST', { paymentId: checkout.data.paymentId, reason: 'service_issue' }, token);
  assert.equal(dispute.status, 200);
});



test('white-label enterprise: plan gating, branding controls, and domain provisioning lifecycle', async () => {
  const reg = await call('/api/auth/register', 'POST', { email: `w-${Date.now()}@t.com`, password: 'password123', displayName: 'WhiteLabel' });
  const token = reg.data.token;

  const plans = await call('/api/plans', 'GET');
  assert.equal(plans.status, 200);

  const deniedDomain = await call('/api/domains/provision', 'POST', { domain: 'creatorname.app' }, token);
  assert.equal(deniedDomain.status, 403);

  const deniedBranding = await call('/api/branding/settings', 'POST', { appName: 'WL', color: '#111111' }, token);
  assert.equal(deniedBranding.status, 403);

  const upGrowth = await call('/api/billing/upgrade-plan', 'POST', { plan: 'growth' }, token);
  assert.equal(upGrowth.status, 200);

  const domain = await call('/api/domains/provision', 'POST', { domain: 'creatorname.app' }, token);
  assert.equal(domain.status, 200);
  const verify = await call(`/api/domains/${domain.data.domainId}/verify`, 'POST', {}, token);
  assert.equal(verify.status, 200);

  const poweredDenied = await call('/api/branding/settings', 'POST', { appName: 'Growth Brand', showPoweredBy: false }, token);
  assert.equal(poweredDenied.status, 403);

  const upEnt = await call('/api/billing/upgrade-plan', 'POST', { plan: 'enterprise' }, token);
  assert.equal(upEnt.status, 200);

  const branding = await call('/api/branding/settings', 'POST', { appName: 'Enterprise Brand', color: '#123456', logoUrl: 'https://cdn/logo.svg', splashUrl: 'https://cdn/splash.png', showPoweredBy: false }, token);
  assert.equal(branding.status, 200);
  assert.equal(branding.data.branding.showPoweredBy, false);

  const feature = await call('/api/features/access?feature=removePoweredBy', 'GET', undefined, token);
  assert.equal(feature.status, 200);
  assert.equal(feature.data.enabled, true);

  const domains = await call('/api/domains', 'GET', undefined, token);
  assert.equal(domains.status, 200);
  assert.equal(domains.data.domains.length, 1);
});


test.after(async () => server.close());
