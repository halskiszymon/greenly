// cron.js — daily watering reminder over web push.
// CLI:  node cron.js            (Plesk "Scheduled tasks", once a day in the morning)
// HTTP: GET /api/cron?secret=…  (fallback when CLI cron is unavailable; see server.js)

import { fileURLToPath } from 'node:url';
import webpush from 'web-push';
import { openDb, loadConfig, loadCare, duePlants, listSubs, deleteSub, markNotified, getUser } from './lib.js';

function buildPayload(plants, appUrl, lang = 'pl') {
  const en = lang === 'en';
  if (plants.length === 1) {
    const p = plants[0];
    return { title: en ? `Time to water: ${p.name}` : `Czas podlać: ${p.name}`, body: p.group_note, url: appUrl, tag: 'greenly-water' };
  }
  const names = plants.map((p) => p.name).join(', ');
  return { title: en ? `To water: ${plants.length}` : `Do podlania: ${plants.length}`, body: names, url: appUrl, tag: 'greenly-water' };
}

function isSubscriptionExpired(err) {
  return err?.statusCode === 404 || err?.statusCode === 410;
}

/** Each user gets one notification about their own due plants, sent to their own subscriptions. */
export async function runCron(config, db) {
  loadCare();
  const plants = duePlants(db);
  const result = { due: plants.length, sent: 0, removed: 0, failed: 0 };
  if (!plants.length) return result;

  const { subject, publicKey, privateKey } = config.vapid ?? {};
  if (!publicKey || !privateKey) {
    console.warn('cron: VAPID keys missing in config.js — nothing sent.');
    return result;
  }
  webpush.setVapidDetails(subject || 'mailto:admin@example.com', publicKey, privateKey);

  const byUser = new Map();
  for (const p of plants) {
    if (!byUser.has(p.user_id)) byUser.set(p.user_id, []);
    byUser.get(p.user_id).push(p);
  }
  for (const [userId, mine] of byUser) {
    const payload = JSON.stringify(buildPayload(mine, config.appUrl || '/', getUser(db, userId)?.lang || 'pl'));
    for (const sub of listSubs(db, userId)) {
      const pushSub = { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } };
      try {
        await webpush.sendNotification(pushSub, payload, { TTL: 12 * 3600, urgency: 'normal' });
        result.sent++;
      } catch (err) {
        if (isSubscriptionExpired(err)) {
          deleteSub(db, sub.endpoint);
          result.removed++;
        } else {
          result.failed++;
          console.error('cron: push failed', err.statusCode ?? '', err.body ?? err.message);
        }
      }
    }
  }

  markNotified(db, plants.map((p) => p.id));
  return result;
}

// CLI entry. No top-level await: this module is also imported by server.js, which
// Passenger loads with require() (see the note in server.js).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  (async () => {
    const config = await loadConfig();
    const db = openDb();
    const r = await runCron(config, db);
    console.log(`cron: due=${r.due} sent=${r.sent} removed=${r.removed} failed=${r.failed}`);
  })().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
