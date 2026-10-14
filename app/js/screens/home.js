// Home: hero for the focused item, nav bar, and Plex's home hubs as rows.
// The last hub payload is cached so a cold start paints instantly.
import { h, setText, setTransform, toggleClass } from '../util/dom.js';
import { Row } from '../ui/row.js';
import { useAmbience, HeroArt } from '../ui/backdrop.js';
import { session, hiddenSections } from '../session.js';
import { metaLine } from '../util/format.js';
import { isFast } from '../input.js';
import * as store from '../util/store.js';
import * as icons from '../ui/icons.js';
import { openItem, playItem, openLibrary, openSearch, openSettings } from '../nav.js';
import { error, log } from '../util/log.js';
import * as watchlist from '../plex/watchlist.js';

const ROWS_TOP = 600;

function slimHub(hub) {
  // Keep the cache small: only fields the home screen renders.
  const keep = ['ratingKey', 'key', 'type', 'title', 'grandparentTitle', 'parentTitle', 'year', 'thumb', 'art',
    'grandparentThumb', 'grandparentArt', 'parentThumb', 'index', 'parentIndex', 'duration', 'viewOffset',
    'viewCount', 'leafCount', 'viewedLeafCount', 'childCount', 'contentRating', 'audienceRating', 'summary',
    'originallyAvailableAt', 'UltraBlurColors', 'grandparentRatingKey', 'parentRatingKey', 'Image', 'guid'];
  return {
    hubIdentifier: hub.hubIdentifier, title: hub.title, type: hub.type,
    Metadata: hub.Metadata.map(m => {
      const o = {};
      for (const k of keep) if (m[k] !== undefined) o[k] = m[k];
      return o;
    }),
  };
}

export function heroArtPath(item) {
  if (item.type === 'episode' || item.type === 'season') return item.grandparentArt || item.art;
  return item.art;
}

export function clearLogo(item) {
  const img = (item.Image || []).find(i => i.type === 'clearLogo');
  return img ? img.url : '';
}

export function HomeScreen() {
  const el = h('div', 'screen home');
  const ambience = useAmbience();
  const hero = new HeroArt(el, 'hero-art home-art');

  const top = h('header', 'topbar', el);
  const brand = h('div', 'brand', top);
  h('img', 'brand-mark', brand).src = 'img/mascot.png';
  const brandText = h('div', 'brand-text', brand);
  h('img', 'brand-wordmark', brandText).src = 'img/wordmark.png';
  h('div', 'brand-by', brandText).textContent = 'by rfaile313';
  // Library tabs slide inside a clip so Search and Settings stay pinned on screen.
  const navEl = h('nav', 'nav', top);
  const navClip = h('div', 'nav-clip', navEl);
  const navTrack = h('div', 'nav-track', navClip);
  const navPinned = h('div', 'nav-pinned', navEl);
  const who = h('div', 'topbar-who', top);
  setText(who, session.server ? session.server.name : '');

  const info = h('div', 'hero-info', el);
  const heroLogo = h('img', 'hero-logo', info);
  const heroTitle = h('h1', 'hero-title', info);
  const heroMeta = h('div', 'hero-meta', info);
  const heroSummary = h('p', 'hero-summary', info);

  const rowsClip = h('div', 'home-rows', el);
  rowsClip.style.top = ROWS_TOP + 'px';
  const track = h('div', 'rows-track', rowsClip);
  const empty = h('div', 'home-empty', el);

  let rows = [];
  let offsets = [];
  let rowIndex = 0;
  let zone = 'rows';
  let navItems = [];
  let navIndex = 0;
  let navScroll = 0;
  let loadedAt = 0;
  let heroTimer = 0;
  let artTimer = 0;
  let reportedPaint = false;
  let allSections = [];
  let hiddenSig = '';
  let serverHubs = [];
  let watchHub = null;
  let watchAt = 0;

  const navKey = n => n.id + (n.section ? ':' + n.section.key : '');

  function buildNav(sections) {
    allSections = sections;
    const hidden = hiddenSections();
    hiddenSig = hidden.join(',');
    const focused = navItems[navIndex] ? navKey(navItems[navIndex]) : '';
    navTrack.innerHTML = '';
    navPinned.innerHTML = '';
    navScroll = 0;
    setTransform(navTrack, 'translateX(0px)');
    navItems = [{ label: 'Home', id: 'home' }]
      .concat(sections.filter(s => hidden.indexOf(s.key) < 0).map(s => ({ label: s.title, id: 'section', section: s })))
      .concat([{ label: 'Search', id: 'search', icon: icons.search }, { label: 'Settings', id: 'settings', icon: icons.gear }]);
    h('i', 'nav-sep', navPinned);
    navItems.forEach(n => {
      n.el = h('div', 'nav-item' + (n.icon ? ' nav-icon' : ''), n.icon ? navPinned : navTrack);
      if (n.icon) n.el.innerHTML = n.icon;
      else h('span', '', n.el).textContent = n.label;
    });
    // Keep focus on the same item (e.g. the Settings icon) when tabs come and go.
    const same = navItems.findIndex(n => navKey(n) === focused);
    navIndex = same >= 0 ? same : Math.min(navIndex, navItems.length - 1);
    renderNav();
  }

  // Slide the tab track just far enough to bring the focused tab into view.
  function scrollNav() {
    const n = navItems[navIndex];
    if (!n || n.el.parentNode !== navTrack) return;
    const pad = 24;
    const clipW = navClip.offsetWidth;
    const maxScroll = Math.max(0, navTrack.scrollWidth - clipW);
    const left = n.el.offsetLeft;
    const right = left + n.el.offsetWidth;
    if (left - pad < navScroll) navScroll = left - pad;
    else if (right + pad > navScroll + clipW) navScroll = right + pad - clipW;
    navScroll = Math.max(0, Math.min(maxScroll, navScroll));
    setTransform(navTrack, 'translateX(' + (-navScroll) + 'px)');
  }

  function renderNav() {
    navItems.forEach((n, i) => {
      toggleClass(n.el, 'focus', zone === 'nav' && i === navIndex);
      toggleClass(n.el, 'current', n.id === 'home');
    });
    toggleClass(el, 'in-nav', zone === 'nav');
    scrollNav();
  }

  function showHero(item) {
    if (!item) return;
    const logoPath = clearLogo(item);
    const server = session.server;
    if (logoPath && item.type !== 'episode') {
      heroLogo.src = server.image(logoPath, 640, 200, { format: 'png' });
      heroLogo.style.display = '';
      heroTitle.style.display = 'none';
    } else {
      heroLogo.style.display = 'none';
      heroTitle.style.display = '';
      setText(heroTitle, item.type === 'episode' ? item.grandparentTitle : item.title);
    }
    setText(heroMeta, (item.type === 'episode' ? item.title + '  ·  ' : '') + metaLine(item));
    setText(heroSummary, item.summary || '');
    ambience.set(item.UltraBlurColors);
    clearTimeout(artTimer);
    artTimer = setTimeout(() => hero.set(server.image(heroArtPath(item), 1344, 756)), isFast() ? 350 : 120);
  }

  function onFocusItem(item) {
    clearTimeout(heroTimer);
    // While a key is held, skip the text repaint until the user settles.
    if (isFast()) heroTimer = setTimeout(() => showHero(item), 160);
    else showHero(item);
  }

  function layoutRows() {
    offsets = [];
    let y = 0;
    rows.forEach(r => {
      offsets.push(y);
      setTransform(r.el, 'translateY(' + y + 'px)');
      y += r.height;
    });
  }

  function renderRows() {
    rows.forEach((r, i) => {
      r.setActive(zone === 'rows' && i === rowIndex);
      toggleClass(r.el, 'above', i < rowIndex);
    });
    setTransform(track, 'translateY(' + (-(offsets[rowIndex] || 0)) + 'px)');
  }

  function setHubs(hubs) {
    const sameShape = hubs.length === rows.length && hubs.every((hb, i) => rows[i].hubId === hb.hubIdentifier);
    const focusedKey = rows[rowIndex] && rows[rowIndex].current() && rows[rowIndex].current().ratingKey;
    if (sameShape) {
      hubs.forEach((hb, i) => rows[i].setItems(hb.Metadata, i === rowIndex ? focusedKey : null));
    } else {
      track.innerHTML = '';
      rows = hubs.map(hb => {
        const wide = /continue|ondeck/i.test(hb.hubIdentifier);
        const row = new Row({
          title: hb.title, kind: wide ? 'wide' : 'poster', items: hb.Metadata,
          onFocus: onFocusItem, onSelect: item => openItem(item),
        });
        row.hubId = hb.hubIdentifier;
        track.appendChild(row.el);
        return row;
      });
      rowIndex = Math.min(rowIndex, Math.max(0, rows.length - 1));
      layoutRows();
    }
    renderRows();
    setText(empty, rows.length ? '' : 'Nothing here yet. Add some media to your Plex server.');
    const cur = rows[rowIndex] && rows[rowIndex].current();
    if (cur) showHero(cur);
    if (!reportedPaint && rows.length) {
      reportedPaint = true;
      log('home rows ready at ' + Math.round(performance.now()) + 'ms after page start');
    }
  }

  // The Watchlist row goes after Continue Watching / On Deck.
  function withWatchlist(hubs) {
    if (!watchHub || !watchHub.Metadata.length) return hubs;
    let i = 0;
    while (i < hubs.length && /continue|ondeck/i.test(hubs[i].hubIdentifier)) i++;
    return hubs.slice(0, i).concat([watchHub], hubs.slice(i));
  }

  function saveCache() {
    store.set('homeCache', { server: session.server.id, sections: allSections, hubs: withWatchlist(serverHubs).map(slimHub) });
  }

  async function load() {
    const server = session.server;
    loadedAt = Date.now();
    try {
      const [sections, hubs] = await Promise.all([server.sections(), server.hubs()]);
      serverHubs = hubs;
      buildNav(sections);
      setHubs(withWatchlist(hubs));
      saveCache();
    } catch (e) {
      error('home load failed', e);
      if (!rows.length) setText(empty, 'Couldn\'t load from ' + server.name + '. Press OK to retry.');
      return;
    }
    loadWatchlist();
  }

  // Only Watchlist items that are on this server, so everything in the row plays.
  async function loadWatchlist() {
    if (!watchlist.available()) return;
    watchAt = Date.now();
    try {
      const items = await watchlist.onServer(session.server);
      watchHub = { hubIdentifier: 'watchlist', title: 'Watchlist', type: 'mixed', Metadata: items };
      setHubs(withWatchlist(serverHubs));
      saveCache();
    } catch (e) {
      error('watchlist load failed', e);
    }
  }

  const cached = store.get('homeCache');
  if (cached && session.server && cached.server === session.server.id) {
    buildNav(cached.sections || []);
    const hubs = cached.hubs || [];
    watchHub = hubs.find(hb => hb.hubIdentifier === 'watchlist') || null;
    serverHubs = hubs.filter(hb => hb !== watchHub);
    setHubs(hubs);
  } else {
    buildNav([]);
  }
  load();

  function activateNav(n) {
    if (n.id === 'section') openLibrary(n.section);
    else if (n.id === 'search') openSearch();
    else if (n.id === 'settings') openSettings();
  }

  return {
    el,
    name: 'home',
    onShow() {
      ambience.restore();
      // Libraries may have been hidden or shown in Settings.
      if (hiddenSections().join(',') !== hiddenSig) buildNav(allSections);
      const watchChanged = watchlist.changedAt > watchAt;
      if (watchChanged && watchHub) {
        // Removed on a detail page: drop it from the row now, not after the refresh.
        const kept = watchHub.Metadata.filter(m => !watchlist.removed(m));
        if (kept.length !== watchHub.Metadata.length) {
          watchHub = Object.assign({}, watchHub, { Metadata: kept });
          setHubs(withWatchlist(serverHubs));
          saveCache();
        }
      }
      // Coming back from playback: progress and Continue Watching changed.
      if (Date.now() - loadedAt > 5000) load();
      // Added to the Watchlist on a detail page (load() covers it too).
      else if (watchChanged) loadWatchlist();
    },
    onKey(action) {
      if (zone === 'nav') {
        if (action === 'left') { navIndex = Math.max(0, navIndex - 1); renderNav(); return true; }
        if (action === 'right') { navIndex = Math.min(navItems.length - 1, navIndex + 1); renderNav(); return true; }
        if (action === 'down' && rows.length) { zone = 'rows'; renderNav(); renderRows(); return true; }
        if (action === 'enter') { activateNav(navItems[navIndex]); return true; }
        if (action === 'back') return false;
        return true;
      }
      const row = rows[rowIndex];
      if (!row) {
        if (action === 'up') { zone = 'nav'; renderNav(); return true; }
        if (action === 'enter') { load(); return true; }
        return false;
      }
      switch (action) {
        case 'left': row.move(-1); return true;
        case 'right': row.move(1); return true;
        case 'up':
          if (rowIndex === 0) { zone = 'nav'; renderNav(); renderRows(); return true; }
          rowIndex--; renderRows(); onFocusItem(rows[rowIndex].current()); return true;
        case 'down':
          if (rowIndex < rows.length - 1) { rowIndex++; renderRows(); onFocusItem(rows[rowIndex].current()); }
          return true;
        case 'enter': row.select(); return true;
        case 'play': case 'playpause': if (row.current()) playItem(row.current()); return true;
        case 'back':
          // Back from deep in the rows returns to the top first.
          if (rowIndex > 0 || row.index > 0) {
            rowIndex = 0; rows.forEach(r => r.focusIndex(0)); renderRows(); onFocusItem(rows[0].current());
            return true;
          }
          return false;
      }
      return false;
    },
  };
}
