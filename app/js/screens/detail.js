// Detail page for a movie, show, season (opens its show) or episode.
import { h, setText, setTransform, toggleClass } from '../util/dom.js';
import { useAmbience, HeroArt } from '../ui/backdrop.js';
import { Row } from '../ui/row.js';
import { session } from '../session.js';
import { metaLine, clock, episodeLabel } from '../util/format.js';
import { clearLogo } from './home.js';
import * as icons from '../ui/icons.js';
import * as router from '../router.js';
import { playItem } from '../nav.js';
import { error } from '../util/log.js';
import * as watchlist from '../plex/watchlist.js';

const SHIFT = 400; // how far the body slides up to reveal seasons/episodes

export function DetailScreen(initial, { autoplay = false } = {}) {
  const el = h('div', 'screen detail');
  const ambience = useAmbience(initial.UltraBlurColors);
  const art = new HeroArt(el, 'hero-art detail-art');
  const body = h('div', 'detail-body', el);
  const logo = h('img', 'detail-logo', body);
  const title = h('h1', 'detail-title', body);
  const sub = h('div', 'detail-sub', body);
  const meta = h('div', 'detail-meta', body);
  const tags = h('div', 'detail-tags', body);
  const summary = h('p', 'detail-summary', body);
  const buttonsEl = h('div', 'detail-buttons', body);
  const seasonsEl = h('div', 'detail-seasons', body);
  const episodesWrap = h('div', 'detail-episodes', body);

  let item = initial;
  let buttons = [];
  let buttonIndex = 0;
  let seasons = [];
  let seasonIndex = 0;
  let episodes = null;
  let zone = 'buttons';
  let alive = true;
  let shown = false;
  // Known straight away from the saved Watchlist; checked again after load.
  let onWatchlist = (initial.type === 'movie' || initial.type === 'show') ? watchlist.state(initial) : null;

  const isShowLike = () => item.type === 'show';

  function renderHeader() {
    const server = session.server;
    const logoPath = clearLogo(item);
    const showTitle = item.type === 'episode' ? item.grandparentTitle : item.title;
    if (logoPath) {
      logo.src = server.image(logoPath, 720, 240, { format: 'png' });
      logo.style.display = '';
      title.style.display = 'none';
    } else {
      logo.style.display = 'none';
      title.style.display = '';
      setText(title, showTitle);
    }
    setText(sub, item.type === 'episode' ? episodeLabel(item) + '   ' + item.title : (item.tagline || ''));
    setText(meta, metaLine(item));
    const genres = (item.Genre || []).slice(0, 3).map(g => g.tag);
    const people = (item.Director || []).slice(0, 1).map(d => 'Directed by ' + d.tag)
      .concat((item.Role || []).length ? ['Starring ' + item.Role.slice(0, 3).map(r => r.tag).join(', ')] : []);
    setText(tags, genres.concat(people).join('   ·   '));
    setText(summary, item.summary || '');
    ambience.set(item.UltraBlurColors);
    const artPath = item.type === 'episode' ? (item.grandparentArt || item.art) : item.art;
    art.set(server.image(artPath, 1920, 1080));
  }

  function target() {
    // What Play acts on: the item itself, or for a show the next episode.
    if (!isShowLike()) return item;
    if (item.onDeck) return item.onDeck;
    if (!episodes) return null;
    const eps = episodes.items;
    return eps.find(e => e.viewOffset) || eps.find(e => !e.viewCount) || eps[0] || null;
  }

  function renderButtons() {
    buttonsEl.innerHTML = '';
    buttons = [];
    const t = target();
    const add = (icon, label, run) => {
      const b = h('div', 'btn', buttonsEl);
      b.innerHTML = icon;
      h('span', '', b).textContent = label;
      buttons.push({ el: b, run });
    };
    if (t) {
      const prefix = isShowLike() ? episodeLabel(t) + '  ' : '';
      if (t.viewOffset) {
        add(icons.play, prefix + 'Resume ' + clock(t.viewOffset), () => playItem(t, { offset: t.viewOffset }));
        add(icons.restart, 'From the start', () => playItem(t, { offset: 0 }));
      } else {
        add(icons.play, isShowLike() ? 'Play ' + prefix : 'Play', () => playItem(t, { offset: 0 }));
      }
    }
    const watched = isShowLike() ? item.viewedLeafCount >= item.leafCount : !!item.viewCount;
    add(watched ? icons.check : icons.uncheck, watched ? 'Watched' : 'Mark watched', toggleWatched);
    if (onWatchlist !== null) {
      add(onWatchlist ? icons.bookmarked : icons.bookmark, onWatchlist ? 'On Watchlist' : 'Add to Watchlist', toggleWatchlist);
    }
    if (item.type === 'episode' && item.grandparentRatingKey) {
      add(icons.tv, 'Go to show', () => router.push(DetailScreen({ ratingKey: item.grandparentRatingKey, type: 'show', title: item.grandparentTitle })));
    }
    buttonIndex = Math.min(buttonIndex, buttons.length - 1);
    renderFocus();
  }

  function renderSeasons() {
    seasonsEl.innerHTML = '';
    seasons.forEach(s => { s.el = h('div', 'pill', seasonsEl); s.el.textContent = s.title; });
    renderFocus();
  }

  function renderFocus() {
    buttons.forEach((b, i) => toggleClass(b.el, 'focus', zone === 'buttons' && i === buttonIndex));
    seasons.forEach((s, i) => {
      toggleClass(s.el, 'focus', zone === 'seasons' && i === seasonIndex);
      toggleClass(s.el, 'current', i === seasonIndex);
    });
    if (episodes) episodes.row.setActive(zone === 'episodes');
    setTransform(body, zone === 'buttons' ? 'translateY(0)' : 'translateY(' + (-SHIFT) + 'px)');
    toggleClass(el, 'shifted', zone !== 'buttons');
  }

  async function loadEpisodes(season) {
    const kids = await session.server.children(season.ratingKey);
    if (!alive) return;
    if (!episodes) {
      const row = new Row({
        kind: 'episode', caption: true, items: kids,
        onSelect: ep => playItem(ep, { offset: ep.viewOffset || 0 }),
      });
      episodesWrap.appendChild(row.el);
      episodes = { row, items: kids };
    } else {
      episodes.items = kids;
      episodes.row.setItems(kids);
    }
    // Land on the first unwatched episode.
    const next = kids.findIndex(k => !k.viewCount || k.viewOffset);
    episodes.row.focusIndex(next >= 0 ? next : 0);
    renderFocus();
  }

  async function load() {
    try {
      let key = item.ratingKey;
      let preferSeason = null;
      if (item.type === 'season') { preferSeason = item.ratingKey; key = item.parentRatingKey; }
      const full = await session.server.metadata(key);
      if (!alive || !full) return;
      item = full;
      renderHeader();
      if (isShowLike()) {
        seasons = (await session.server.children(item.ratingKey)).filter(s => s.type === 'season');
        if (!alive) return;
        const deckSeason = item.onDeck ? seasons.findIndex(s => s.ratingKey === item.onDeck.parentRatingKey) : -1;
        const pref = preferSeason ? seasons.findIndex(s => s.ratingKey === preferSeason) : -1;
        seasonIndex = pref >= 0 ? pref : (deckSeason >= 0 ? deckSeason : 0);
        renderSeasons();
        if (seasons[seasonIndex]) await loadEpisodes(seasons[seasonIndex]);
      }
      renderButtons();
      loadWatchlist();
      if (autoplay) {
        autoplay = false;
        const t = target();
        if (t) playItem(t, { offset: t.viewOffset || 0 });
      }
    } catch (e) {
      error('detail load failed', e);
      setText(summary, 'Couldn\'t load details.');
    }
  }

  async function loadWatchlist() {
    if (item.type !== 'movie' && item.type !== 'show') return;
    try {
      const on = await watchlist.has(item);
      if (!alive || on === onWatchlist) return;
      onWatchlist = on;
      renderButtons();
    } catch (e) {
      error('watchlist state failed', e);
    }
  }

  async function toggleWatchlist() {
    try {
      await watchlist.setOn(item, !onWatchlist);
      onWatchlist = !onWatchlist;
      if (alive) renderButtons();
    } catch (e) {
      error('watchlist toggle failed', e);
    }
  }

  async function toggleWatched() {
    const server = session.server;
    const watched = isShowLike() ? item.viewedLeafCount >= item.leafCount : !!item.viewCount;
    try {
      if (watched) await server.unscrobble(item.ratingKey);
      else await server.scrobble(item.ratingKey);
      server.invalidate();
      await load();
    } catch (e) {
      error('toggle watched failed', e);
    }
  }

  if (item.title) renderHeader();
  renderButtons();
  load();
  if (item.guid) loadWatchlist();

  function moveZone(dir) {
    const order = ['buttons'];
    if (seasons.length > 1) order.push('seasons');
    if (episodes) order.push('episodes');
    const i = order.indexOf(zone) + dir;
    if (i < 0 || i >= order.length) return;
    zone = order[i];
    renderFocus();
  }

  return {
    el,
    name: 'detail',
    onShow() {
      ambience.restore();
      // Back from the player: refresh resume points and watched state.
      if (shown) {
        session.server.invalidate();
        load();
      }
      shown = true;
    },
    onKey(action) {
      if (action === 'up') { moveZone(-1); return true; }
      if (action === 'down') { moveZone(1); return true; }
      if (action === 'play' || action === 'playpause') {
        const t = zone === 'episodes' ? episodes.row.current() : target();
        if (t) playItem(t, { offset: t.viewOffset || 0 });
        return true;
      }
      if (zone === 'buttons') {
        if (action === 'left') { buttonIndex = Math.max(0, buttonIndex - 1); renderFocus(); return true; }
        if (action === 'right') { buttonIndex = Math.min(buttons.length - 1, buttonIndex + 1); renderFocus(); return true; }
        if (action === 'enter' && buttons[buttonIndex]) { buttons[buttonIndex].run(); return true; }
      } else if (zone === 'seasons') {
        if (action === 'left' || action === 'right') {
          const next = seasonIndex + (action === 'right' ? 1 : -1);
          if (next >= 0 && next < seasons.length) {
            seasonIndex = next;
            renderFocus();
            loadEpisodes(seasons[seasonIndex]).catch(e => error('episodes failed', e));
          }
          return true;
        }
        if (action === 'enter') { moveZone(1); return true; }
      } else if (zone === 'episodes') {
        if (action === 'left') { episodes.row.move(-1); return true; }
        if (action === 'right') { episodes.row.move(1); return true; }
        if (action === 'enter') { episodes.row.select(); return true; }
        if (action === 'info') { router.push(DetailScreen(episodes.row.current())); return true; }
      }
      if (action === 'back' && zone !== 'buttons') { zone = 'buttons'; renderFocus(); return true; }
      return false;
    },
    destroy() { alive = false; },
  };
}
