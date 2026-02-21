import { existsSync } from 'node:fs';
import { readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export const seedDb = {
  creators: [],
  domains: [],
  domainEvents: [],
  audienceUsers: [],
  pushSubscriptions: [],
  campaigns: [],
  funnels: [],
  bioLinks: [],
  trafficEvents: [],
  segmentRules: [],
  automationFlows: [],
  pushDeliveries: [],
  pushQueue: [],
  contentItems: [],
  secureLinks: [],
  fileAssets: [],
  videoEvents: [],
  payments: [],
  webhookEvents: [],
  entitlements: [],
  subscriptions: [],
  coupons: [],
  invoices: [],
  disputes: [],
  referrals: [],
  automations: [],
  reconciliationJobs: [],
  events: [],
  auditLogs: []
};

export async function loadDb(dbPath) {
  if (!existsSync(dbPath)) {
    await writeFile(dbPath, JSON.stringify(seedDb, null, 2));
    return structuredClone(seedDb);
  }
  const parsed = JSON.parse(await readFile(dbPath, 'utf8'));
  return { ...structuredClone(seedDb), ...parsed };
}

export async function saveDbAtomic(dbPath, db) {
  const tmp = `${dbPath}.tmp`;
  await writeFile(tmp, JSON.stringify(db, null, 2));
  await rename(tmp, dbPath);
}

export function appendEvent(db, creatorId, event, payload = {}) {
  db.events.push({ id: crypto.randomUUID(), creatorId, event, payload, at: new Date().toISOString() });
}

export function appendAudit(db, creatorId, action, payload = {}) {
  db.auditLogs.push({ id: crypto.randomUUID(), creatorId, action, payload, at: new Date().toISOString() });
}

export function dbFileFromEnv() {
  return process.env.DATABASE_PATH || path.join(process.cwd(), 'data.json');
}
