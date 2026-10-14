// Account, server and diagnostics.
import { DEV, VERSION } from '../config.js';
import { h, toggleClass, setTransform } from '../util/dom.js';
import { session, signOut, useServer, hiddenSections, setSectionHidden } from '../session.js';
import * as store from '../util/store.js';
import { getServers, connect } from '../plex/auth.js';
import { setHud, hudEnabled } from '../ui/hud.js';
import * as router from '../router.js';
import { ServerPicker } from './login.js';
import { error } from '../util/log.js';
import { useAmbience, setLegacyGradients, legacyGradients } from '../ui/backdrop.js';

export function SettingsScreen() {
  const el = h('div', 'screen settings');
  const ambience = useAmbience();
  h('h1', 'settings-title', el).textContent = 'Settings';
  // The list scrolls inside a clip once libraries push it past the screen.
  const list = h('div', 'settings-list', el);
  const track = h('div', 'settings-track', list);
  const foot = h('div', 'settings-foot', el);
  foot.textContent = 'SamSUCKS ' + VERSION + (DEV ? ' (dev)' : '') + ' · ' + (session.server ? session.server.uri.replace(/X-Plex-Token=.*/, '') : '');

  let index = 0;
  let items = [];
  let scroll = 0;
  const cache = store.get('homeCache');
  let sections = (cache && session.server && cache.server === session.server.id && cache.sections) || [];

  function build() {
    track.innerHTML = '';
    items = [
      { label: 'Server', value: session.server ? session.server.name : '—', run: switchServer },
      { label: 'Signed in as', value: session.user ? session.user.title : '—', run: doSignOut, action: 'Sign out' },
      { label: 'Performance overlay', value: hudEnabled() ? 'On' : 'Off', run: () => { setHud(!hudEnabled()); build(); } },
      // For before/after recordings: brings back the full-screen gradients that took ~2s per repaint.
      { label: 'Demo: original slow renderer', value: legacyGradients() ? 'On' : 'Off', run: () => { setLegacyGradients(!legacyGradients()); build(); } },
    ];
    const hidden = hiddenSections();
    sections.forEach(sec => {
      const isHidden = hidden.indexOf(sec.key) >= 0;
      items.push({
        label: sec.title, value: isHidden ? 'Hidden' : 'Shown', section: true,
        run: () => { setSectionHidden(sec.key, !isHidden); build(); },
      });
    });
    let headed = false;
    items.forEach(it => {
      if (it.section && !headed) {
        headed = true;
        h('div', 'settings-heading', track).textContent = 'Libraries in the top bar';
      }
      it.el = h('div', 'setting', track);
      h('span', 'setting-label', it.el).textContent = it.label;
      h('span', 'setting-value', it.el).textContent = it.value + (it.action ? '  ·  ' + it.action : '');
    });
    render();
  }

  function render() {
    items.forEach((it, i) => toggleClass(it.el, 'focus', i === index));
    // Keep the focused row on screen, with a row of context above and below.
    const it = items[index];
    const viewH = list.offsetHeight;
    if (!it || !viewH) return;
    const margin = 110;
    const top = it.el.offsetTop;
    const bottom = top + it.el.offsetHeight;
    if (top - margin < scroll) scroll = top - margin;
    else if (bottom + margin > scroll + viewH) scroll = bottom + margin - viewH;
    scroll = Math.max(0, Math.min(Math.max(0, track.offsetHeight - viewH), scroll));
    setTransform(track, 'translateY(' + (-scroll) + 'px)');
  }

  async function loadSections() {
    if (!session.server) return;
    try {
      const fresh = await session.server.sections();
      const key = s => s.map(x => x.key + x.title).join('|');
      if (key(fresh) !== key(sections)) { sections = fresh; build(); }
    } catch (e) {
      error('settings: sections failed', e);
    }
  }

  async function switchServer() {
    try {
      const servers = await getServers(session.token);
      if (servers.length === 1) {
        const uri = await connect(servers[0]);
        useServer(servers[0], uri);
        restart();
        return;
      }
      router.push(ServerPicker({ servers, onDone: restart }));
    } catch (e) {
      error('server list failed', e);
    }
  }

  function doSignOut() {
    signOut();
    restart();
  }

  function restart() {
    // Rebuild from scratch: app.js decides between login and home.
    window.dispatchEvent(new Event('samsucks:restart'));
  }

  build();
  loadSections();

  return {
    el,
    name: 'settings',
    onShow() { ambience.restore(); render(); },
    onKey(action) {
      if (action === 'up') { index = Math.max(0, index - 1); render(); return true; }
      if (action === 'down') { index = Math.min(items.length - 1, index + 1); render(); return true; }
      if (action === 'enter') { items[index].run(); return true; }
      return false;
    },
  };
}
