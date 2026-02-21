import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import crypto from 'node:crypto';
import { hashPassword, signToken, verifyPassword, verifyToken } from './lib/auth.mjs';
import { appendAudit, appendEvent, dbFileFromEnv, loadDb, saveDbAtomic } from './lib/db.mjs';
import { isEmail, positiveInt, requiredString } from './lib/validation.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me-1234';
const WEBHOOK_STRIPE_SECRET = process.env.WEBHOOK_STRIPE_SECRET || 'stripe-secret';
const WEBHOOK_UPI_SECRET = process.env.WEBHOOK_UPI_SECRET || 'upi-secret';
const CONTENT_SIGNING_SECRET = process.env.CONTENT_SIGNING_SECRET || 'content-signing-secret';
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || 'BMOCK_VAPID_PUBLIC_KEY';
const dbPath = dbFileFromEnv();

const rateMap = new Map();
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 240;


const PLAN_CATALOG = {
  starter: {
    monthlyInr: 79,
    yearlyInr: 790,
    features: {
      customDomain: false,
      advancedBranding: false,
      removePoweredBy: false,
      workflowBranching: false,
      abPush: true
    }
  },
  growth: {
    monthlyInr: 129,
    yearlyInr: 1290,
    features: {
      customDomain: true,
      advancedBranding: true,
      removePoweredBy: false,
      workflowBranching: true,
      abPush: true
    }
  },
  enterprise: {
    monthlyInr: 199,
    yearlyInr: 1990,
    features: {
      customDomain: true,
      advancedBranding: true,
      removePoweredBy: true,
      workflowBranching: true,
      abPush: true
    }
  }
};

const getCreatorById = (db, creatorId) => db.creators.find((c) => c.id === creatorId);
const creatorPlan = (db, creatorId) => PLAN_CATALOG[getCreatorById(db, creatorId)?.plan || 'starter'] || PLAN_CATALOG.starter;
const hasFeature = (db, creatorId, feature) => Boolean(creatorPlan(db, creatorId).features[feature]);

function requireFeature(db, creatorId, feature, res) {
  if (!hasFeature(db, creatorId, feature)) {
    writeJson(res, 403, { error: 'Feature not available on current plan', feature, plan: getCreatorById(db, creatorId)?.plan || 'starter' });
    return false;
  }
  return true;
}

const headers = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'"
};

const writeJson = (res, status, body) => {
  res.writeHead(status, {
    ...headers,
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type, authorization, x-provider-signature'
  });
  res.end(JSON.stringify(body));
};

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1_500_000) reject(new Error('Payload too large'));
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
  });
}

const ip = (req) => (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
function rateLimited(req) {
  const key = ip(req);
  const now = Date.now();
  const cur = (rateMap.get(key) || []).filter((t) => now - t < RATE_WINDOW_MS);
  cur.push(now);
  rateMap.set(key, cur);
  return cur.length > RATE_MAX;
}

function auth(req, res) {
  const token = (req.headers.authorization || '').toString().replace(/^Bearer\s+/i, '');
  const user = verifyToken(token, JWT_SECRET);
  if (!user?.creatorId) {
    writeJson(res, 401, { error: 'Unauthorized' });
    return null;
  }
  return user;
}

const signHmac = (secret, payload) => crypto.createHmac('sha256', secret).update(payload).digest('hex');
function verifyWebhookSignature(req, body, secret) {
  const provided = (req.headers['x-provider-signature'] || '').toString();
  const expected = signHmac(secret, JSON.stringify(body));
  return provided && provided.length === expected.length && crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

const stableHash = (input) => crypto.createHash('sha256').update(input).digest('hex');
const assignVariant = (campaign, userId) => {
  const variants = campaign.variants?.length ? campaign.variants : [{ id: 'A', message: campaign.message }];
  const n = parseInt(stableHash(`${campaign.id}:${userId}`).slice(0, 8), 16);
  return variants[n % variants.length];
};

const dashboard = (db, creatorId) => {
  const subs = db.audienceUsers.filter((u) => u.creatorId === creatorId);
  const paid = db.payments.filter((p) => p.creatorId === creatorId && p.status === 'success');
  return {
    totalSubscribers: subs.length,
    activePushSubscribers: db.pushSubscriptions.filter((s) => s.creatorId === creatorId && s.status === 'active').length,
    revenueInr: paid.reduce((a, p) => a + p.amountInPaise, 0) / 100,
    conversionRate: subs.length ? Number(((paid.length / subs.length) * 100).toFixed(2)) : 0
  };
};

function runPushWorker(db) {
  const now = Date.now();
  for (const job of db.pushQueue.filter((j) => j.status === 'queued' || (j.status === 'retry' && j.nextAttemptAt <= now))) {
    const sub = db.pushSubscriptions.find((s) => s.id === job.subscriptionId);
    job.attempts += 1;
    if (sub?.endpoint?.startsWith('https://')) {
      job.status = 'done';
      db.pushDeliveries.push({ id: crypto.randomUUID(), campaignId: job.campaignId, audienceUserId: job.audienceUserId, variantId: job.variantId, device: job.device || 'web', status: 'delivered', at: new Date().toISOString() });
    } else if (job.attempts >= 3) {
      job.status = 'failed';
      db.pushDeliveries.push({ id: crypto.randomUUID(), campaignId: job.campaignId, audienceUserId: job.audienceUserId, variantId: job.variantId, device: 'unknown', status: 'failed', at: new Date().toISOString() });
    } else {
      job.status = 'retry';
      job.nextAttemptAt = now + job.attempts * 30_000;
    }
  }
}

function runReconciliationWorker(db) {
  const threshold = Date.now() - 10 * 60_000;
  for (const p of db.payments.filter((x) => x.status === 'pending' && Date.parse(x.createdAt) < threshold)) {
    p.status = 'failed';
    p.updatedAt = new Date().toISOString();
    db.reconciliationJobs.push({ id: crypto.randomUUID(), paymentId: p.id, action: 'mark_failed_stale_pending', at: new Date().toISOString() });
  }
  const now = Date.now();
  for (const i of db.invoices.filter((x) => x.status === 'failed' && x.retryAt && Date.parse(x.retryAt) <= now && x.retryCount < 3)) {
    i.retryCount += 1;
    i.status = 'pending';
    i.retryAt = null;
  }
}

function pushAnalytics(db, creatorId, campaignId) {
  const deliveries = db.pushDeliveries.filter((d) => d.campaignId === campaignId);
  const opens = db.events.filter((e) => e.creatorId === creatorId && e.event === 'push_open' && e.payload.campaignId === campaignId);
  const clicks = db.events.filter((e) => e.creatorId === creatorId && e.event === 'push_click' && e.payload.campaignId === campaignId);
  const byVariant = {};
  for (const d of deliveries) {
    byVariant[d.variantId] ||= { variantId: d.variantId, delivered: 0, opens: 0, clicks: 0 };
    if (d.status === 'delivered') byVariant[d.variantId].delivered += 1;
  }
  for (const e of opens) {
    byVariant[e.payload.variantId] ||= { variantId: e.payload.variantId, delivered: 0, opens: 0, clicks: 0 };
    byVariant[e.payload.variantId].opens += 1;
  }
  for (const e of clicks) {
    byVariant[e.payload.variantId] ||= { variantId: e.payload.variantId, delivered: 0, opens: 0, clicks: 0 };
    byVariant[e.payload.variantId].clicks += 1;
  }
  const byChannelDevice = {};
  for (const d of deliveries) {
    const k = `${d.device || 'web'}:browser_push`;
    byChannelDevice[k] = (byChannelDevice[k] || 0) + 1;
  }
  return {
    totals: { delivered: deliveries.filter((d) => d.status === 'delivered').length, opens: opens.length, clicks: clicks.length },
    byVariant: Object.values(byVariant).map((r) => ({ ...r, openRate: r.delivered ? Number((r.opens / r.delivered).toFixed(4)) : 0, ctr: r.delivered ? Number((r.clicks / r.delivered).toFixed(4)) : 0 })),
    byChannelDevice
  };
}

const evaluateRule = (rule, user) => {
  const conds = Array.isArray(rule?.conditions) ? rule.conditions : [];
  if (!conds.length) return true;
  return conds.every((c) => {
    if (c.field === 'segment' && c.op === 'eq') return user.segment === c.value;
    if (c.field === 'source' && c.op === 'eq') return user.source === c.value;
    if (c.field === 'email' && c.op === 'contains') return (user.email || '').includes(c.value);
    return false;
  });
};

const bestSendTime = (db, creatorId) => {
  const events = db.events.filter((e) => e.creatorId === creatorId && (e.event === 'push_open' || e.event === 'push_click'));
  const buckets = Array.from({ length: 24 }, (_, h) => ({ hour: h, score: 0 }));
  for (const e of events) {
    const hour = new Date(e.at).getUTCHours();
    const add = e.event === 'push_click' ? 2 : 1;
    buckets[hour].score += add;
  }
  buckets.sort((a, b) => b.score - a.score);
  return { recommendedUtcHour: buckets[0].hour, topHours: buckets.slice(0, 5) };
};

export async function buildServer() {
  const db = await loadDb(dbPath);
  const persist = async (creatorId, action, payload = {}) => {
    if (creatorId && action) appendAudit(db, creatorId, action, payload);
    await saveDbAtomic(dbPath, db);
  };

  return http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { ...headers, 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, authorization, x-provider-signature' });
      return res.end();
    }
    if (rateLimited(req)) return writeJson(res, 429, { error: 'Rate limit exceeded' });

    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    try {
      if (req.method === 'GET' && url.pathname === '/health') return writeJson(res, 200, { ok: true });
      if (req.method === 'POST' && url.pathname === '/api/workers/run') {
        runPushWorker(db); runReconciliationWorker(db); await persist(null, null); return writeJson(res, 200, { ok: true });
      }

      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/app')) {
        const html = await readFile(path.join(__dirname, 'public/index.html'), 'utf8');
        res.writeHead(200, { ...headers, 'content-type': 'text/html; charset=utf-8' });
        return res.end(html);
      }
      if (req.method === 'GET' && url.pathname === '/manifest.webmanifest') {
        const m = await readFile(path.join(__dirname, 'public/manifest.webmanifest'), 'utf8');
        res.writeHead(200, { ...headers, 'content-type': 'application/manifest+json' });
        return res.end(m);
      }
      if (req.method === 'GET' && url.pathname === '/sw.js') {
        const sw = await readFile(path.join(__dirname, 'public/sw.js'), 'utf8');
        res.writeHead(200, { ...headers, 'content-type': 'application/javascript' });
        return res.end(sw);
      }
      if (req.method === 'GET' && url.pathname.startsWith('/assets/')) {
        const asset = await readFile(path.join(__dirname, 'public', url.pathname));
        res.writeHead(200, { ...headers, 'content-type': 'image/svg+xml' });
        return res.end(asset);
      }

      if (req.method === 'GET' && url.pathname === '/api/push/vapid-public-key') return writeJson(res, 200, { publicKey: VAPID_PUBLIC_KEY });

      if (req.method === 'POST' && url.pathname === '/api/auth/register') {
        const body = await parseBody(req);
        if (!isEmail(body.email) || !requiredString(body.password, 8) || !requiredString(body.displayName, 2)) return writeJson(res, 400, { error: 'Invalid payload' });
        const email = body.email.toLowerCase();
        if (db.creators.some((c) => c.email === email)) return writeJson(res, 409, { error: 'Email already exists' });
        const creator = { id: crypto.randomUUID(), email, password: hashPassword(body.password), displayName: body.displayName, plan: 'starter', branding: { appName: body.displayName, color: '#2563eb', logoUrl: null, splashUrl: null, showPoweredBy: true }, createdAt: new Date().toISOString() };
        db.creators.push(creator); appendEvent(db, creator.id, 'creator_registered'); await persist(creator.id, 'creator.register');
        return writeJson(res, 200, { token: signToken({ creatorId: creator.id, email }, JWT_SECRET), creatorId: creator.id });
      }
      if (req.method === 'POST' && url.pathname === '/api/auth/login') {
        const body = await parseBody(req);
        const c = db.creators.find((x) => x.email === body?.email?.toLowerCase());
        if (!c || !verifyPassword(body.password || '', c.password)) return writeJson(res, 401, { error: 'Invalid credentials' });
        return writeJson(res, 200, { token: signToken({ creatorId: c.id, email: c.email }, JWT_SECRET), creatorId: c.id });
      }

      if (req.method === 'GET' && url.pathname === '/api/plans') {
        return writeJson(res, 200, { plans: PLAN_CATALOG });
      }
      if (req.method === 'POST' && url.pathname === '/api/billing/upgrade-plan') {
        const u = auth(req, res); if (!u) return;
        const b = await parseBody(req);
        if (!requiredString(b.plan) || !PLAN_CATALOG[b.plan]) return writeJson(res, 400, { error: 'Invalid plan' });
        const c = getCreatorById(db, u.creatorId);
        if (!c) return writeJson(res, 404, { error: 'Creator not found' });
        c.plan = b.plan;
        appendEvent(db, u.creatorId, 'plan_upgraded', { plan: b.plan });
        await persist(u.creatorId, 'billing.plan.upgrade', { plan: b.plan });
        return writeJson(res, 200, { ok: true, plan: c.plan, features: creatorPlan(db, u.creatorId).features });
      }
      if (req.method === 'GET' && url.pathname === '/api/features/access') {
        const u = auth(req, res); if (!u) return;
        const feature = url.searchParams.get('feature');
        if (!feature) return writeJson(res, 400, { error: 'Missing feature query param' });
        return writeJson(res, 200, { feature, enabled: hasFeature(db, u.creatorId, feature), plan: getCreatorById(db, u.creatorId)?.plan || 'starter' });
      }

      if (req.method === 'POST' && url.pathname === '/api/branding/settings') {
        const u = auth(req, res); if (!u) return;
        const b = await parseBody(req);
        if (!requireFeature(db, u.creatorId, 'advancedBranding', res)) return;
        const c = getCreatorById(db, u.creatorId);
        if (!c) return writeJson(res, 404, { error: 'Creator not found' });
        c.branding ||= { appName: c.displayName, color: '#2563eb', logoUrl: null, splashUrl: null, showPoweredBy: true };
        c.branding.appName = requiredString(b.appName, 2) ? b.appName : c.branding.appName;
        c.branding.color = /^#[0-9A-Fa-f]{6}$/.test(b.color || '') ? b.color : c.branding.color;
        c.branding.logoUrl = requiredString(b.logoUrl || '') ? b.logoUrl : c.branding.logoUrl;
        c.branding.splashUrl = requiredString(b.splashUrl || '') ? b.splashUrl : c.branding.splashUrl;
        if (typeof b.showPoweredBy === 'boolean') {
          if (b.showPoweredBy === false && !hasFeature(db, u.creatorId, 'removePoweredBy')) {
            return writeJson(res, 403, { error: 'removePoweredBy feature required' });
          }
          c.branding.showPoweredBy = b.showPoweredBy;
        }
        await persist(u.creatorId, 'branding.settings.update', c.branding);
        return writeJson(res, 200, { ok: true, branding: c.branding });
      }

      if (req.method === 'POST' && url.pathname === '/api/domains/provision') {
        const u = auth(req, res); if (!u) return;
        if (!requireFeature(db, u.creatorId, 'customDomain', res)) return;
        const b = await parseBody(req);
        if (!requiredString(b.domain, 4)) return writeJson(res, 400, { error: 'Invalid domain' });
        const domain = b.domain.toLowerCase();
        if (db.domains.some((d) => d.domain === domain && d.status !== 'failed')) return writeJson(res, 409, { error: 'Domain already exists' });
        const verificationToken = crypto.randomBytes(8).toString('hex');
        const row = { id: crypto.randomUUID(), creatorId: u.creatorId, domain, status: 'pending_dns', verification: { txtName: `_creator_verify.${domain}`, txtValue: verificationToken }, sslStatus: 'pending', createdAt: new Date().toISOString(), verifiedAt: null };
        db.domains.push(row);
        db.domainEvents.push({ id: crypto.randomUUID(), domainId: row.id, type: 'provision_requested', at: new Date().toISOString() });
        await persist(u.creatorId, 'domain.provision.request', { domain });
        return writeJson(res, 200, { domainId: row.id, domain, verification: row.verification, cnameTarget: 'cname.creator-engine.app' });
      }
      if (req.method === 'POST' && url.pathname.startsWith('/api/domains/') && url.pathname.endsWith('/verify')) {
        const u = auth(req, res); if (!u) return;
        const domainId = url.pathname.split('/')[3];
        const row = db.domains.find((d) => d.id === domainId && d.creatorId === u.creatorId);
        if (!row) return writeJson(res, 404, { error: 'Domain not found' });
        row.status = 'active';
        row.sslStatus = 'issued';
        row.verifiedAt = new Date().toISOString();
        db.domainEvents.push({ id: crypto.randomUUID(), domainId: row.id, type: 'verified', at: new Date().toISOString() });
        await persist(u.creatorId, 'domain.verify', { domainId: row.id });
        return writeJson(res, 200, { ok: true, status: row.status, sslStatus: row.sslStatus, domain: row.domain });
      }
      if (req.method === 'GET' && url.pathname === '/api/domains') {
        const u = auth(req, res); if (!u) return;
        return writeJson(res, 200, { domains: db.domains.filter((d) => d.creatorId === u.creatorId) });
      }

      if (req.method === 'GET' && url.pathname === '/api/dashboard') {
        const u = auth(req, res); if (!u) return; return writeJson(res, 200, { ...dashboard(db, u.creatorId), plan: getCreatorById(db, u.creatorId)?.plan || 'starter', domains: db.domains.filter((d) => d.creatorId === u.creatorId).length });
      }

      if (req.method === 'POST' && url.pathname === '/api/audience') {
        const u = auth(req, res); if (!u) return;
        const b = await parseBody(req);
        const row = { id: crypto.randomUUID(), creatorId: u.creatorId, email: b.email || null, segment: b.segment || 'all', source: b.source || 'direct', createdAt: new Date().toISOString() };
        db.audienceUsers.push(row); appendEvent(db, u.creatorId, 'audience_captured', { segment: row.segment, source: row.source }); await persist(u.creatorId, 'audience.create');
        return writeJson(res, 200, { audienceUserId: row.id });
      }

      if (req.method === 'POST' && url.pathname === '/api/segments/rules') {
        const u = auth(req, res); if (!u) return;
        const b = await parseBody(req);
        if (!requiredString(b.name, 3) || !Array.isArray(b.conditions)) return writeJson(res, 400, { error: 'Invalid payload' });
        const rule = { id: crypto.randomUUID(), creatorId: u.creatorId, name: b.name, conditions: b.conditions, createdAt: new Date().toISOString() };
        db.segmentRules.push(rule); await persist(u.creatorId, 'segment.rule.create');
        return writeJson(res, 200, { ruleId: rule.id });
      }
      if (req.method === 'GET' && url.pathname.startsWith('/api/segments/preview/')) {
        const u = auth(req, res); if (!u) return;
        const ruleId = url.pathname.split('/').pop();
        const rule = db.segmentRules.find((r) => r.id === ruleId && r.creatorId === u.creatorId);
        if (!rule) return writeJson(res, 404, { error: 'Rule not found' });
        const matched = db.audienceUsers.filter((x) => x.creatorId === u.creatorId && evaluateRule(rule, x));
        return writeJson(res, 200, { count: matched.length, audienceUserIds: matched.map((m) => m.id) });
      }

      if (req.method === 'POST' && url.pathname === '/api/push/subscribe') {
        const u = auth(req, res); if (!u) return;
        const b = await parseBody(req);
        if (!requiredString(b.audienceUserId) || !requiredString(b.endpoint, 8)) return writeJson(res, 400, { error: 'Invalid payload' });
        db.pushSubscriptions.push({ id: crypto.randomUUID(), creatorId: u.creatorId, audienceUserId: b.audienceUserId, endpoint: b.endpoint, status: 'active', device: b.device || 'web', createdAt: new Date().toISOString() });
        appendEvent(db, u.creatorId, 'push_opted_in'); await persist(u.creatorId, 'push.subscribe');
        return writeJson(res, 200, { ok: true });
      }

      if (req.method === 'POST' && url.pathname === '/api/campaigns') {
        const u = auth(req, res); if (!u) return;
        const b = await parseBody(req);
        if (!requiredString(b.name, 3) || !requiredString(b.message, 3)) return writeJson(res, 400, { error: 'Invalid payload' });
        const variants = Array.isArray(b.variants) && b.variants.length ? b.variants : [{ id: 'A', message: b.message }, { id: 'B', message: `${b.message} ✨` }];
        const campaign = { id: crypto.randomUUID(), creatorId: u.creatorId, name: b.name, message: b.message, segment: b.segment || 'all', variants, status: 'scheduled', createdAt: new Date().toISOString() };
        db.campaigns.push(campaign); await persist(u.creatorId, 'campaign.create');
        return writeJson(res, 200, { campaignId: campaign.id, variants });
      }
      if (req.method === 'POST' && url.pathname.startsWith('/api/campaigns/') && url.pathname.endsWith('/send')) {
        const u = auth(req, res); if (!u) return;
        const campaignId = url.pathname.split('/')[3];
        const campaign = db.campaigns.find((c) => c.id === campaignId && c.creatorId === u.creatorId);
        if (!campaign) return writeJson(res, 404, { error: 'Campaign not found' });
        let users = db.audienceUsers.filter((x) => x.creatorId === u.creatorId);
        const rule = db.segmentRules.find((r) => r.creatorId === u.creatorId && r.name === campaign.segment);
        users = rule ? users.filter((x) => evaluateRule(rule, x)) : users.filter((x) => campaign.segment === 'all' || x.segment === campaign.segment);
        const subs = db.pushSubscriptions.filter((s) => s.creatorId === u.creatorId && s.status === 'active');
        const subByUser = Object.fromEntries(subs.map((s) => [s.audienceUserId, s]));
        let queued = 0;
        for (const usr of users) {
          const sub = subByUser[usr.id]; if (!sub) continue;
          const v = assignVariant(campaign, usr.id);
          db.pushQueue.push({ id: crypto.randomUUID(), campaignId: campaign.id, creatorId: u.creatorId, subscriptionId: sub.id, audienceUserId: usr.id, variantId: v.id, payload: v.message, attempts: 0, status: 'queued', nextAttemptAt: Date.now(), device: sub.device });
          queued += 1;
        }
        campaign.status = 'queued'; appendEvent(db, u.creatorId, 'campaign_queued', { campaignId, queued }); await persist(u.creatorId, 'campaign.send.queue');
        return writeJson(res, 200, { ok: true, queued });
      }
      if (req.method === 'GET' && url.pathname.startsWith('/api/push/analytics/')) {
        const u = auth(req, res); if (!u) return;
        return writeJson(res, 200, pushAnalytics(db, u.creatorId, url.pathname.split('/').pop()));
      }
      if (req.method === 'POST' && url.pathname === '/api/push/events/open') {
        const b = await parseBody(req); const c = db.campaigns.find((x) => x.id === b.campaignId); if (!c) return writeJson(res, 404, { error: 'Campaign not found' });
        appendEvent(db, c.creatorId, 'push_open', { campaignId: b.campaignId, variantId: b.variantId, audienceUserId: b.audienceUserId, device: b.device || 'web' }); await persist(c.creatorId, 'push.open');
        return writeJson(res, 200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/push/events/click') {
        const b = await parseBody(req); const c = db.campaigns.find((x) => x.id === b.campaignId); if (!c) return writeJson(res, 404, { error: 'Campaign not found' });
        appendEvent(db, c.creatorId, 'push_click', { campaignId: b.campaignId, variantId: b.variantId, audienceUserId: b.audienceUserId, device: b.device || 'web' }); await persist(c.creatorId, 'push.click');
        return writeJson(res, 200, { ok: true });
      }

      if (req.method === 'GET' && url.pathname === '/api/funnel/templates') {
        const u = auth(req, res); if (!u) return;
        return writeJson(res, 200, {
          templates: [
            { id: 'lead-magnet', name: 'Lead Magnet', blocks: [{ type: 'hero', title: 'Free Resource' }, { type: 'cta', text: 'Unlock now' }] },
            { id: 'webinar', name: 'Webinar Registration', blocks: [{ type: 'hero', title: 'Live Workshop' }, { type: 'proof', text: 'Social proof' }, { type: 'cta', text: 'Reserve seat' }] },
            { id: 'tripwire', name: 'Tripwire Offer', blocks: [{ type: 'hero', title: 'Low-ticket offer' }, { type: 'offer', text: '₹99 entry offer' }] }
          ]
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/funnels') {
        const u = auth(req, res); if (!u) return;
        const b = await parseBody(req);
        if (!requiredString(b.name, 3) || !Array.isArray(b.blocks)) return writeJson(res, 400, { error: 'Invalid payload' });
        const slug = (b.slug || crypto.randomBytes(3).toString('hex')).toLowerCase();
        const funnel = { id: crypto.randomUUID(), creatorId: u.creatorId, name: b.name, slug, blocks: b.blocks, templateId: b.templateId || null, createdAt: new Date().toISOString() };
        db.funnels.push(funnel); await persist(u.creatorId, 'funnel.create');
        return writeJson(res, 200, { funnelId: funnel.id, publicUrl: `/f/${slug}` });
      }
      if (req.method === 'GET' && url.pathname === '/api/funnels') {
        const u = auth(req, res); if (!u) return;
        return writeJson(res, 200, db.funnels.filter((f) => f.creatorId === u.creatorId));
      }
      if (req.method === 'GET' && url.pathname.startsWith('/f/')) {
        const slug = url.pathname.split('/').pop();
        const funnel = db.funnels.find((f) => f.slug === slug);
        if (!funnel) return writeJson(res, 404, { error: 'Funnel not found' });
        const creator = getCreatorById(db, funnel.creatorId);
        const showPoweredBy = creator?.branding?.showPoweredBy !== false;
        const html = `<!doctype html><html><body style="font-family:sans-serif;padding:20px"><h1>${funnel.name}</h1>${funnel.blocks.map((b) => `<section><h3>${b.title || ''}</h3><p>${b.text || ''}</p></section>`).join('')} ${showPoweredBy ? '<hr><small>powered by Creator Engine</small>' : ''}</body></html>`;
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(html);
      }

      if (req.method === 'POST' && url.pathname === '/api/traffic/track') {
        const b = await parseBody(req);
        if (!requiredString(b.creatorId) || !requiredString(b.path)) return writeJson(res, 400, { error: 'Invalid payload' });
        db.trafficEvents.push({ id: crypto.randomUUID(), creatorId: b.creatorId, path: b.path, source: b.source || 'direct', medium: b.medium || null, campaign: b.campaign || null, utm: b.utm || {}, visitorId: b.visitorId || crypto.randomUUID(), converted: Boolean(b.converted), at: new Date().toISOString() });
        await persist(b.creatorId, 'traffic.track');
        return writeJson(res, 200, { ok: true });
      }
      if (req.method === 'GET' && url.pathname === '/api/attribution/dashboard') {
        const u = auth(req, res); if (!u) return;
        const events = db.trafficEvents.filter((e) => e.creatorId === u.creatorId);
        const bySource = {}, byCampaign = {}, byMedium = {};
        let converted = 0;
        for (const e of events) {
          bySource[e.source || 'direct'] = (bySource[e.source || 'direct'] || 0) + 1;
          byCampaign[e.campaign || 'unknown'] = (byCampaign[e.campaign || 'unknown'] || 0) + 1;
          byMedium[e.medium || 'unknown'] = (byMedium[e.medium || 'unknown'] || 0) + 1;
          if (e.converted) converted += 1;
        }
        return writeJson(res, 200, { visits: events.length, converted, conversionRate: events.length ? Number((converted / events.length).toFixed(4)) : 0, bySource, byCampaign, byMedium });
      }

      if (req.method === 'GET' && url.pathname === '/api/bio-link/templates') {
        const u = auth(req, res); if (!u) return;
        return writeJson(res, 200, {
          templates: [
            { id: 'minimal', name: 'Minimal', palette: { bg: '#0b1220', fg: '#e5e7eb' } },
            { id: 'creator-pro', name: 'Creator Pro', palette: { bg: '#111827', fg: '#ffffff' } },
            { id: 'neon', name: 'Neon', palette: { bg: '#020617', fg: '#22d3ee' } }
          ]
        });
      }
      if (req.method === 'POST' && url.pathname === '/api/bio-links') {
        const u = auth(req, res); if (!u) return;
        const b = await parseBody(req);
        if (!requiredString(b.title, 2) || !Array.isArray(b.links)) return writeJson(res, 400, { error: 'Invalid payload' });
        const slug = (b.slug || crypto.randomBytes(3).toString('hex')).toLowerCase();
        const bio = { id: crypto.randomUUID(), creatorId: u.creatorId, title: b.title, slug, links: b.links, template: b.template || 'minimal', hero: b.hero || null, createdAt: new Date().toISOString() };
        db.bioLinks.push(bio); await persist(u.creatorId, 'biolink.create');
        return writeJson(res, 200, { bioLinkId: bio.id, publicUrl: `/b/${slug}` });
      }
      if (req.method === 'GET' && url.pathname.startsWith('/b/')) {
        const slug = url.pathname.split('/').pop();
        const bio = db.bioLinks.find((x) => x.slug === slug);
        if (!bio) return writeJson(res, 404, { error: 'Bio link not found' });
        const creator = getCreatorById(db, bio.creatorId);
        const showPoweredBy = creator?.branding?.showPoweredBy !== false;
        const html = `<!doctype html><html><body style="font-family:sans-serif;padding:20px"><h1>${bio.title}</h1>${bio.hero ? `<p>${bio.hero}</p>` : ''}${bio.links.map((l) => `<p><a href="${l.url}">${l.label}</a></p>`).join('')} ${showPoweredBy ? '<hr><small>powered by Creator Engine</small>' : ''}</body></html>`;
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(html);
      }

      if (req.method === 'GET' && url.pathname === '/api/segments/operators') {
        const u = auth(req, res); if (!u) return;
        return writeJson(res, 200, {
          fields: ['segment', 'source', 'email'],
          operators: [
            { op: 'eq', label: 'equals', supportedFields: ['segment', 'source', 'email'] },
            { op: 'neq', label: 'not_equals', supportedFields: ['segment', 'source', 'email'] },
            { op: 'contains', label: 'contains', supportedFields: ['email', 'source'] }
          ]
        });
      }
      if (req.method === 'POST' && url.pathname === '/api/segments/rules') {
        const u = auth(req, res); if (!u) return;
        const b = await parseBody(req);
        if (!requiredString(b.name, 3) || !Array.isArray(b.conditions) || b.conditions.length === 0) return writeJson(res, 400, { error: 'Invalid payload' });
        for (const c of b.conditions) {
          if (!requiredString(c.field) || !requiredString(c.op) || typeof c.value !== 'string') return writeJson(res, 400, { error: 'Invalid condition' });
        }
        const rule = { id: crypto.randomUUID(), creatorId: u.creatorId, name: b.name, combinator: b.combinator === 'OR' ? 'OR' : 'AND', conditions: b.conditions, createdAt: new Date().toISOString() };
        db.segmentRules.push(rule); await persist(u.creatorId, 'segment.rule.create');
        return writeJson(res, 200, { ruleId: rule.id });
      }
      if (req.method === 'GET' && url.pathname.startsWith('/api/segments/preview/')) {
        const u = auth(req, res); if (!u) return;
        const ruleId = url.pathname.split('/').pop();
        const rule = db.segmentRules.find((r) => r.id === ruleId && r.creatorId === u.creatorId);
        if (!rule) return writeJson(res, 404, { error: 'Rule not found' });
        const matched = db.audienceUsers.filter((x) => x.creatorId === u.creatorId).filter((user) => {
          const checks = rule.conditions.map((c) => {
            const v = String(user[c.field] || '');
            if (c.op === 'eq') return v === c.value;
            if (c.op === 'neq') return v !== c.value;
            if (c.op === 'contains') return v.includes(c.value);
            return false;
          });
          return rule.combinator === 'OR' ? checks.some(Boolean) : checks.every(Boolean);
        });
        return writeJson(res, 200, { count: matched.length, audienceUserIds: matched.map((m) => m.id) });
      }

      if (req.method === 'POST' && url.pathname === '/api/automations/workflows') {
        const u = auth(req, res); if (!u) return;
        if (!requireFeature(db, u.creatorId, 'workflowBranching', res)) return;
        const b = await parseBody(req);
        if (!requiredString(b.name, 3) || !Array.isArray(b.nodes) || !Array.isArray(b.edges) || b.nodes.length === 0) return writeJson(res, 400, { error: 'Invalid payload' });
        const ids = new Set(b.nodes.map((n) => n.id));
        for (const e of b.edges) if (!ids.has(e.from) || !ids.has(e.to)) return writeJson(res, 400, { error: 'Edge references unknown node' });
        const flow = { id: crypto.randomUUID(), creatorId: u.creatorId, name: b.name, trigger: b.trigger || 'signup', nodes: b.nodes, edges: b.edges, status: 'active', createdAt: new Date().toISOString() };
        db.automationFlows.push(flow); await persist(u.creatorId, 'automation.workflow.create');
        return writeJson(res, 200, { workflowId: flow.id });
      }
      if (req.method === 'POST' && url.pathname.startsWith('/api/automations/workflows/') && url.pathname.endsWith('/simulate')) {
        const u = auth(req, res); if (!u) return;
        const b = await parseBody(req);
        const id = url.pathname.split('/')[4];
        const flow = db.automationFlows.find((f) => f.id === id && f.creatorId === u.creatorId);
        if (!flow) return writeJson(res, 404, { error: 'Workflow not found' });
        const ctx = b.context || { opened: true, clicked: false, purchased: false };
        const traversed = [];
        let node = flow.nodes.find((n) => n.type === 'start') || flow.nodes[0];
        for (let i = 0; i < 20 && node; i++) {
          traversed.push(node.id);
          const outs = flow.edges.filter((e) => e.from === node.id);
          let chosen = outs.find((e) => e.condition === 'default') || outs[0];
          for (const e of outs) {
            if (e.condition === 'if_opened' && ctx.opened) chosen = e;
            if (e.condition === 'if_clicked' && ctx.clicked) chosen = e;
            if (e.condition === 'if_purchased' && ctx.purchased) chosen = e;
          }
          node = chosen ? flow.nodes.find((n) => n.id === chosen.to) : null;
        }
        return writeJson(res, 200, { traversed, context: ctx });
      }
      if (req.method === 'GET' && url.pathname === '/api/intelligence/best-send-time') {
        const u = auth(req, res); if (!u) return;
        const rec = bestSendTime(db, u.creatorId);
        const sample = db.events.filter((e) => e.creatorId === u.creatorId && (e.event === 'push_open' || e.event === 'push_click')).length;
        const confidence = sample > 50 ? 'high' : sample > 15 ? 'medium' : 'low';
        return writeJson(res, 200, { ...rec, confidence, sampleSize: sample });
      }
      if (req.method === 'POST' && url.pathname === '/api/content') {
        const u = auth(req, res); if (!u) return;
        const b = await parseBody(req);
        if (!requiredString(b.title, 3) || !requiredString(b.body, 1)) return writeJson(res, 400, { error: 'Invalid payload' });
        const row = { id: crypto.randomUUID(), creatorId: u.creatorId, title: b.title, body: b.body, accessTier: b.accessTier === 'paid' ? 'paid' : 'free', unlockAt: b.unlockAt || null, createdAt: new Date().toISOString() };
        db.contentItems.push(row); await persist(u.creatorId, 'content.create');
        return writeJson(res, 200, { contentId: row.id });
      }
      if (req.method === 'POST' && url.pathname === '/api/content/secure-link') {
        const u = auth(req, res); if (!u) return;
        const b = await parseBody(req);
        if (!requiredString(b.contentId) || !positiveInt(b.ttlSec || 0)) return writeJson(res, 400, { error: 'Invalid payload' });
        const token = crypto.randomBytes(16).toString('hex');
        db.secureLinks.push({ token, creatorId: u.creatorId, contentId: b.contentId, oneTime: b.oneTime !== false, expiresAt: Date.now() + b.ttlSec * 1000, consumedAt: null, createdAt: new Date().toISOString() });
        await persist(u.creatorId, 'content.secure_link.create');
        return writeJson(res, 200, { url: `/api/content/secure-link/${token}` });
      }
      if (req.method === 'GET' && url.pathname.startsWith('/api/content/secure-link/')) {
        const t = url.pathname.split('/').pop();
        const link = db.secureLinks.find((l) => l.token === t);
        if (!link) return writeJson(res, 404, { error: 'Link not found' });
        if (Date.now() > link.expiresAt || (link.oneTime && link.consumedAt)) return writeJson(res, 410, { error: 'Link expired or used' });
        const content = db.contentItems.find((c) => c.id === link.contentId);
        if (!content) return writeJson(res, 404, { error: 'Content not found' });
        if (link.oneTime) link.consumedAt = new Date().toISOString();
        await persist(link.creatorId, 'content.secure_link.consume');
        return writeJson(res, 200, { content });
      }
      if (req.method === 'POST' && url.pathname === '/api/content/files/register') {
        const u = auth(req, res); if (!u) return;
        const b = await parseBody(req);
        if (!requiredString(b.fileName)) return writeJson(res, 400, { error: 'Invalid payload' });
        const file = { id: crypto.randomUUID(), creatorId: u.creatorId, fileName: b.fileName, contentType: b.contentType || 'application/octet-stream', storagePath: b.storagePath || `/mock/${b.fileName}` };
        db.fileAssets.push(file); await persist(u.creatorId, 'file.register');
        return writeJson(res, 200, { fileId: file.id });
      }
      if (req.method === 'POST' && url.pathname === '/api/content/files/sign-url') {
        const u = auth(req, res); if (!u) return;
        const b = await parseBody(req);
        const file = db.fileAssets.find((f) => f.id === b.fileId && f.creatorId === u.creatorId);
        if (!file) return writeJson(res, 404, { error: 'File not found' });
        const exp = Math.floor(Date.now() / 1000) + (b.ttlSec || 300);
        const sig = signHmac(CONTENT_SIGNING_SECRET, `${file.id}:${exp}`);
        return writeJson(res, 200, { signedUrl: `/api/content/files/download?fileId=${file.id}&exp=${exp}&sig=${sig}` });
      }
      if (req.method === 'GET' && url.pathname === '/api/content/files/download') {
        const fileId = url.searchParams.get('fileId'); const exp = Number(url.searchParams.get('exp') || 0); const sig = url.searchParams.get('sig') || '';
        if (!fileId || !exp || Date.now() / 1000 > exp || sig !== signHmac(CONTENT_SIGNING_SECRET, `${fileId}:${exp}`)) return writeJson(res, 403, { error: 'Invalid signature' });
        const file = db.fileAssets.find((f) => f.id === fileId);
        if (!file) return writeJson(res, 404, { error: 'File not found' });
        return writeJson(res, 200, { download: true, file });
      }
      if (req.method === 'POST' && url.pathname === '/api/content/video/events') {
        const b = await parseBody(req);
        if (!requiredString(b.videoId) || !requiredString(b.event)) return writeJson(res, 400, { error: 'Invalid payload' });
        db.videoEvents.push({ id: crypto.randomUUID(), creatorId: b.creatorId || null, audienceUserId: b.audienceUserId || null, videoId: b.videoId, event: b.event, atSec: Number(b.atSec || 0), at: new Date().toISOString() });
        await persist(b.creatorId || null, 'video.event.track');
        return writeJson(res, 200, { ok: true });
      }

      if (req.method === 'POST' && url.pathname === '/api/coupons') {
        const u = auth(req, res); if (!u) return;
        const b = await parseBody(req);
        if (!requiredString(b.code) || !['fixed', 'percent'].includes(b.type) || !positiveInt(b.value)) return writeJson(res, 400, { error: 'Invalid payload' });
        db.coupons.push({ id: crypto.randomUUID(), creatorId: u.creatorId, code: b.code.toUpperCase(), type: b.type, value: b.value, maxUses: b.maxUses || 1000, used: 0, expiresAt: b.expiresAt || null, active: true });
        await persist(u.creatorId, 'coupon.create');
        return writeJson(res, 200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/payments/checkout') {
        const u = auth(req, res); if (!u) return;
        const b = await parseBody(req);
        if (!requiredString(b.audienceUserId) || !positiveInt(b.amountInPaise)) return writeJson(res, 400, { error: 'Invalid payload' });
        let amount = b.amountInPaise; let couponApplied = null;
        if (b.couponCode) {
          const c = db.coupons.find((x) => x.creatorId === u.creatorId && x.code === b.couponCode.toUpperCase() && x.active && x.used < x.maxUses && (!x.expiresAt || Date.now() < Date.parse(x.expiresAt)));
          if (c) { couponApplied = c.code; c.used += 1; amount = c.type === 'fixed' ? Math.max(1, amount - c.value) : Math.max(1, Math.floor(amount * (100 - c.value) / 100)); }
        }
        const p = { id: crypto.randomUUID(), creatorId: u.creatorId, audienceUserId: b.audienceUserId, provider: b.method === 'stripe' ? 'stripe' : 'upi_psp', method: b.method || 'upi_intent', amountInPaise: amount, baseAmountInPaise: b.amountInPaise, couponApplied, upsellOfferId: b.upsellOfferId || null, status: 'pending', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
        db.payments.push(p); await persist(u.creatorId, 'payment.checkout.create');
        if (p.method === 'stripe') return writeJson(res, 200, { paymentId: p.id, checkoutUrl: `/mock/stripe?paymentId=${p.id}` });
        const upi = `upi://pay?pa=merchant@upi&pn=CreatorSaaS&am=${(amount / 100).toFixed(2)}&cu=INR&tr=${p.id}`;
        return writeJson(res, 200, { paymentId: p.id, upiIntentUrl: upi, upiQrPayload: upi, collectRequestToken: p.method === 'upi_collect' ? `collect_${p.id}` : null, couponApplied, upsellOfferId: p.upsellOfferId });
      }
      if (req.method === 'POST' && (url.pathname === '/api/payments/webhooks/upi' || url.pathname === '/api/payments/webhooks/stripe')) {
        const b = await parseBody(req); const secret = url.pathname.endsWith('stripe') ? WEBHOOK_STRIPE_SECRET : WEBHOOK_UPI_SECRET;
        if (!verifyWebhookSignature(req, b, secret)) return writeJson(res, 401, { error: 'Invalid webhook signature' });
        if (!requiredString(b.eventId) || !requiredString(b.paymentId) || !['success', 'failed'].includes(b.status)) return writeJson(res, 400, { error: 'Invalid payload' });
        if (db.webhookEvents.some((w) => w.id === b.eventId)) return writeJson(res, 200, { ok: true, deduplicated: true });
        const p = db.payments.find((x) => x.id === b.paymentId); if (!p) return writeJson(res, 404, { error: 'Payment not found' });
        db.webhookEvents.push({ id: b.eventId, provider: url.pathname.endsWith('stripe') ? 'stripe' : 'upi', payload: b, at: new Date().toISOString() });
        p.status = b.status; p.providerPaymentId = b.providerPaymentId || null; p.updatedAt = new Date().toISOString();
        if (b.status === 'success') db.entitlements.push({ id: crypto.randomUUID(), creatorId: p.creatorId, audienceUserId: p.audienceUserId, type: 'paid_member', createdAt: new Date().toISOString() });
        await persist(p.creatorId, 'payment.webhook.process');
        return writeJson(res, 200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/subscriptions/create') {
        const u = auth(req, res); if (!u) return;
        const b = await parseBody(req);
        if (!requiredString(b.audienceUserId) || !requiredString(b.planCode) || !requiredString(b.interval)) return writeJson(res, 400, { error: 'Invalid payload' });
        const next = new Date(Date.now() + (b.interval === 'yearly' ? 365 : 30) * 86400000).toISOString();
        const sub = { id: crypto.randomUUID(), creatorId: u.creatorId, audienceUserId: b.audienceUserId, planCode: b.planCode, interval: b.interval, status: 'active', nextBillingAt: next, failedCount: 0, createdAt: new Date().toISOString() };
        db.subscriptions.push(sub); await persist(u.creatorId, 'subscription.create');
        return writeJson(res, 200, { subscriptionId: sub.id, nextBillingAt: next });
      }
      if (req.method === 'POST' && url.pathname.startsWith('/api/subscriptions/') && url.pathname.endsWith('/renew')) {
        const u = auth(req, res); if (!u) return;
        const sub = db.subscriptions.find((s) => s.id === url.pathname.split('/')[3] && s.creatorId === u.creatorId);
        if (!sub) return writeJson(res, 404, { error: 'Subscription not found' });
        const inv = { id: crypto.randomUUID(), subscriptionId: sub.id, creatorId: u.creatorId, amountInPaise: 9900, status: 'pending', retryCount: 0, retryAt: null, createdAt: new Date().toISOString() };
        db.invoices.push(inv); await persist(u.creatorId, 'subscription.renew.invoiced');
        return writeJson(res, 200, { invoiceId: inv.id });
      }
      if (req.method === 'POST' && url.pathname === '/api/invoices/mark-failed') {
        const u = auth(req, res); if (!u) return;
        const b = await parseBody(req); const i = db.invoices.find((x) => x.id === b.invoiceId && x.creatorId === u.creatorId);
        if (!i) return writeJson(res, 404, { error: 'Invoice not found' });
        i.status = 'failed'; i.retryAt = new Date(Date.now() + 24 * 3600000).toISOString();
        const s = db.subscriptions.find((x) => x.id === i.subscriptionId); if (s) s.failedCount += 1;
        await persist(u.creatorId, 'invoice.failed.dunning');
        return writeJson(res, 200, { ok: true, retryAt: i.retryAt });
      }
      if (req.method === 'POST' && url.pathname.startsWith('/api/subscriptions/') && url.pathname.endsWith('/cancel')) {
        const u = auth(req, res); if (!u) return;
        const s = db.subscriptions.find((x) => x.id === url.pathname.split('/')[3] && x.creatorId === u.creatorId);
        if (!s) return writeJson(res, 404, { error: 'Subscription not found' });
        s.status = 'canceled'; await persist(u.creatorId, 'subscription.cancel'); return writeJson(res, 200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/payments/refund') {
        const u = auth(req, res); if (!u) return;
        const b = await parseBody(req); const p = db.payments.find((x) => x.id === b.paymentId && x.creatorId === u.creatorId && x.status === 'success');
        if (!p) return writeJson(res, 404, { error: 'Payment not found or not refundable' });
        p.status = 'refunded'; await persist(u.creatorId, 'payment.refund'); return writeJson(res, 200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/payments/disputes') {
        const u = auth(req, res); if (!u) return;
        const b = await parseBody(req); if (!requiredString(b.paymentId) || !requiredString(b.reason, 3)) return writeJson(res, 400, { error: 'Invalid payload' });
        db.disputes.push({ id: crypto.randomUUID(), creatorId: u.creatorId, paymentId: b.paymentId, reason: b.reason, status: 'open', createdAt: new Date().toISOString() });
        await persist(u.creatorId, 'payment.dispute.open'); return writeJson(res, 200, { ok: true });
      }

      if (req.method === 'GET' && url.pathname === '/api/creator/analytics') {
        const u = auth(req, res); if (!u) return;
        const events = db.events.filter((e) => e.creatorId === u.creatorId);
        const payments = db.payments.filter((p) => p.creatorId === u.creatorId);
        return writeJson(res, 200, {
          funnels: { signups: events.filter((e) => e.event === 'audience_captured').length, checkouts: payments.length, paid: payments.filter((p) => p.status === 'success').length },
          paymentsByMethod: Object.values(payments.reduce((acc, p) => { acc[p.method] = acc[p.method] || { method: p.method, count: 0, grossInr: 0 }; acc[p.method].count += 1; if (p.status === 'success') acc[p.method].grossInr += p.amountInPaise / 100; return acc; }, {})),
          attribution: { totalTraffic: db.trafficEvents.filter((t) => t.creatorId === u.creatorId).length },
          intelligence: bestSendTime(db, u.creatorId)
        });
      }

      return writeJson(res, 404, { error: 'Not found' });
    } catch (err) {
      return writeJson(res, 500, { error: 'Internal server error', details: err.message });
    }
  });
}

if (process.env.NODE_ENV !== 'test') {
  const server = await buildServer();
  setInterval(async () => {
    const db = await loadDb(dbPath);
    runPushWorker(db);
    runReconciliationWorker(db);
    await saveDbAtomic(dbPath, db);
  }, 15_000).unref();
  server.listen(PORT, HOST, () => console.log(`Server listening on http://${HOST}:${PORT}`));
}
