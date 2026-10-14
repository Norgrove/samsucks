// Plex Watchlist. It lives on plex.tv's discover service, not on the media
// server, and is keyed by Plex's own ids: the tail of an item's plex:// guid.
import { request } from './client.js';
import { session } from '../session.js';
import * as store from '../util/store.js';
import { warn } from '../util/log.js';

// Plex has moved these endpoints between hosts before; fall back on a 404.
const HOSTS = ['https://discover.provider.plex.tv', 'https://metadata.provider.plex.tv'];
let host = HOSTS[0];

async function call(path, opts) {
  try {
    return await request(host + path, opts);
  } catch (e) {
    if (e.status !== 404) throw e;
    host = host === HOSTS[0] ? HOSTS[1] : HOSTS[0];
    warn('watchlist: 404, trying', host);
    return request(host + path, opts);
  }
}

let cache = null; // { at, entries, ids: Set of plex ids }
let pending = null;

// The ids are saved so a detail page can show the button the moment it opens,
// even straight after start-up, before plex.tv has answered.
const account = () => (session.user && session.user.uuid) || 'default';

function setCache(c) {
  cache = c;
  store.set('watchlistIds', { account: account(), ids: Array.from(c.ids) });
}

function seed() {
  if (cache) return;
  const saved = store.get('watchlistIds');
  if (saved && saved.account === account()) cache = { at: 0, entries: [], ids: new Set(saved.ids) };
}
export let changedAt = 0;

// plex.tv can take a while to reflect an add or remove, so our own recent
// changes win over what it returns for a couple of minutes.
const OVERRIDE_MS = 120000;
const overrides = new Map(); // plex id -> { on, at }

function applyOverrides(list) {
  const now = Date.now();
  overrides.forEach((o, id) => { if (now - o.at > OVERRIDE_MS) overrides.delete(id); });
  const kept = list.filter(e => { const o = overrides.get(e.ratingKey); return !o || o.on; });
  const ids = new Set(kept.map(e => e.ratingKey));
  overrides.forEach((o, id) => { if (o.on) ids.add(id); });
  return { at: now, entries: kept, ids };
}

export function plexId(item) {
  const m = /^plex:\/\/(movie|show)\/([0-9a-f]+)$/i.exec((item && item.guid) || '');
  return m ? m[2] : null;
}

export function available() {
  return !!session.token && session.token !== 'lan-dev';
}

// Watchlist entries (plex.tv metadata, newest first).
export async function entries({ maxAge = 60000 } = {}) {
  if (!available()) return [];
  if (cache && Date.now() - cache.at < maxAge) return cache.entries;
  if (!pending) {
    pending = fetchAll().then(list => {
      setCache(applyOverrides(list));
      return cache.entries;
    }).finally(() => { pending = null; });
  }
  return pending;
}

// plex.tv rejects pages larger than 100.
const PAGE = 100;

async function fetchAll() {
  const all = [];
  for (let start = 0; ; start += PAGE) {
    const json = await call('/library/sections/watchlist/all', {
      token: session.token,
      params: { 'X-Plex-Container-Start': start, 'X-Plex-Container-Size': PAGE, includeCollections: 0, includeExternalMedia: 0 },
    });
    const mc = json.MediaContainer || json;
    const page = mc.Metadata || [];
    all.push.apply(all, page);
    if (page.length < PAGE || all.length >= (mc.totalSize || 0)) break;
  }
  return all.filter(e => e.type === 'movie' || e.type === 'show');
}

// true / false, or null when the item can't be watchlisted (no plex:// guid).
// Right now, without the network: true / false, or null when unknown or the
// item can't be watchlisted (no plex:// guid).
export function state(item) {
  const id = plexId(item);
  if (!id || !available()) return null;
  seed();
  return cache ? cache.ids.has(id) : null;
}

export async function has(item) {
  const id = plexId(item);
  if (!id || !available()) return null;
  seed();
  // Answer from the last list straight away; refresh it in the background.
  if (cache) {
    entries().catch(() => {});
    return cache.ids.has(id);
  }
  await entries();
  return cache.ids.has(id);
}

export async function setOn(item, on) {
  const id = plexId(item);
  if (!id) return;
  await call('/actions/' + (on ? 'addToWatchlist' : 'removeFromWatchlist'), {
    method: 'PUT', token: session.token, params: { ratingKey: id },
  });
  overrides.set(id, { on, at: Date.now() });
  if (cache) {
    const at = on ? 0 : cache.at; // an add needs plex.tv's entry for it, so refetch
    const ids = cache.ids;
    const next = applyOverrides(cache.entries);
    // Keep ids we only know from the saved list (entries not fetched yet).
    ids.forEach(k => { const o = overrides.get(k); if (!o) next.ids.add(k); });
    next.at = at;
    setCache(next);
  }
  changedAt = Date.now();
}

// True when we know the item is no longer on the Watchlist (no network).
export function removed(item) {
  const id = plexId(item);
  seed();
  return !!(id && cache && !cache.ids.has(id));
}

// Watchlist entries that are in this server's libraries, as server items.
// Finding items by guid takes the server seconds, so matches are remembered
// per server (guid -> [ratingKey or null, when checked]) and only new Watchlist
// entries are looked up, in batches. Misses are rechecked after a day in case
// the item has been added to the library since.
const MISS_RECHECK = 24 * 3600 * 1000;
const GUID_BATCH = 25;
const TYPES = { movie: 1, show: 2 };

export async function onServer(server) {
  const list = await entries();
  const saved = store.get('watchlistMatches', {});
  const matches = saved[server.id] || {};
  const now = Date.now();
  const todo = list.filter(e => {
    const m = matches[e.guid];
    return !m || (m[0] === null && now - m[1] > MISS_RECHECK);
  }).map(e => e.guid);
  const batches = [];
  for (let i = 0; i < todo.length; i += GUID_BATCH) batches.push(todo.slice(i, i + GUID_BATCH));
  let next = 0;
  async function worker() {
    while (next < batches.length) {
      const batch = batches[next++];
      try {
        const hits = await server.byGuids(batch);
        const byGuid = {};
        hits.forEach(m => { byGuid[m.guid] = m.ratingKey; });
        batch.forEach(g => { matches[g] = [byGuid[g] || null, Date.now()]; });
      } catch (err) { /* lookup failed: try again next time */ }
    }
  }
  await Promise.all([worker(), worker()]);

  // Then fresh metadata for every match: one quick request per type. Ids the
  // server no longer has are simply missing from the answer.
  const byKey = {};
  await Promise.all(Object.keys(TYPES).map(async t => {
    const ids = list.filter(e => e.type === t && matches[e.guid] && matches[e.guid][0]).map(e => matches[e.guid][0]);
    if (ids.length) (await server.byIds(TYPES[t], ids)).forEach(m => { byKey[m.ratingKey] = m; });
  }));
  list.forEach(e => {
    const m = matches[e.guid];
    if (m && m[0] && !byKey[m[0]]) delete matches[e.guid]; // gone from the server: look up again
  });
  // Forget entries that have left the Watchlist.
  const live = new Set(list.map(e => e.guid));
  Object.keys(matches).forEach(g => { if (!live.has(g)) delete matches[g]; });
  saved[server.id] = matches;
  store.set('watchlistMatches', saved);
  return list.map(e => matches[e.guid] && byKey[matches[e.guid][0]]).filter(Boolean);
}
