(() => {
  'use strict';

  const TZ = 'Europe/Stockholm';
  const PLAYING_SECS = 110 * 60; // how long after kickoff a match counts as being played
  const PAGE = 150;
  const SWEDEN = [[55.2, 10.9], [69.1, 24.2]];
  const RANK = { live: 0, soon: 1, today: 2, later: 3, past: 4 };
  const DIVISIONS = { 4: 'Division 2', 5: 'Division 3', 6: 'Division 4', 7: 'Division 5', 8: 'Division 6', 9: 'Division 7', 10: 'Division 8' };
  const TIER_NAMES = {
    2: { 1: 'Allsvenskan', 2: 'Superettan', 3: 'Ettan', ...DIVISIONS },
    3: { 1: 'Damallsvenskan', 2: 'Elitettan', 3: 'Division 1', ...DIVISIONS },
  };
  const CUP = 10; // filter keys: 10 Svenska Cupen, 11 reserves, 12 national team, 0 no tier
  const RESERVES = 11;
  const NATIONAL = 12;
  // Gender 4 is the federation's "mixed" (walking football, a few friendlies): shown in both modes.
  const tierNames = (gender) => TIER_NAMES[gender === 3 ? 3 : 2];
  const compKey = (c) => (c.tier === 'C' ? CUP : c.tier === 'R' ? RESERVES : c.tier ? Math.min(c.tier, 9) : 0);
  const tierKey = (m) => (m.nt ? NATIONAL : compKey(m.comp));
  // Marker ranking: national team first, then tiers 1-8, then Svenska Cupen.
  const markerRank = (m) => (m.nt ? 0 : m.comp.tier === 'C' ? 50 : typeof m.comp.tier === 'number' ? m.comp.tier : 99);
  // Club crests are published with the site (see scripts/lib/crests.mjs); id 0 = no crest.
  const crestUrl = (id) => `crests/${id}.png`;
  const crestImg = (id) => (id ? `<img class="crest" src="${crestUrl(id)}" alt="" loading="lazy">` : '');
  const matchUrl = (id) => `https://www.svenskfotboll.se/go-to/?fmid=${id}`;

  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
  };

  const fmtTime = new Intl.DateTimeFormat('sv-SE', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
  const fmtDayLong = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' });
  const fmtStamp = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const fmtYmd = new Intl.DateTimeFormat('sv-SE', { timeZone: TZ }); // YYYY-MM-DD
  const ymd = (d) => fmtYmd.format(d);
  const nowSec = () => Math.floor(Date.now() / 1000);
  // Matches without a kickoff time sort after the timed ones on their day.
  const sortTime = (m) => (m.tbd ? m.t + 86_000 : m.t);

  // Tier chips: 1-8, 9 = "9+", Svenska Cupen, reserves, 0 = no tier (youth, kids, veterans, friendlies, other cups).
  const ALL_TIERS = [1, 2, 3, 4, 5, 6, 7, 8, 9, NATIONAL, CUP, RESERVES, 0];
  const STORE_KEY = 'fotbollskartan:filters:v4';
  const PERSISTED = ['gender', 'cats', 'tiers', 'level', 'age', 'approx', 'finished', 'listMode'];
  const DEFAULTS = {
    day: null, gender: 2, cats: [4, 3, 2, 5], tiers: ALL_TIERS, level: 'all', age: '', q: '', approx: true,
    finished: false, now: false, listMode: 'view', sort: 'time',
  };
  const state = { ...DEFAULTS, ...pick(store.get(STORE_KEY, {}), PERSISTED) };
  if (!Array.isArray(state.tiers)) state.tiers = ALL_TIERS;
  if (state.gender !== 3) state.gender = 2;

  let data = null;
  let matches = [];
  let sites = [];
  let me = null; // [lat, lon] once the visitor shares their location
  let shown = PAGE;
  let visible = []; // filtered matches, recomputed on every render
  let markerBySite = new Map();

  function pick(obj, keys) {
    return Object.fromEntries(keys.filter((k) => k in obj).map((k) => [k, obj[k]]));
  }

  // ---------- map ----------
  const map = L.map('map', { zoomControl: true, worldCopyJump: false, minZoom: 4 }).fitBounds(SWEDEN);
  map.zoomControl.setPosition('bottomright');
  map.attributionControl.setPrefix(false); // drop Leaflet's own credit; the OSM credit below stays (required)

  // A page opened while hidden (background tab, collapsed pane) measures the map as 0×0 and
  // frames Sweden wrongly. Re-measure on every size change and redo the first framing once.
  let framed = map.getSize().x > 0;
  new ResizeObserver(() => {
    map.invalidateSize();
    if (framed || map.getSize().x === 0) return;
    framed = true;
    if (me) zoomToNearby();
    else map.fitBounds(SWEDEN);
  }).observe(document.getElementById('map'));
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);

  const clusters = L.markerClusterGroup({
    showCoverageOnHover: false,
    // Group generously when zoomed out; at city level keep venues (and their crests) apart.
    maxClusterRadius: (zoom) => (zoom <= 8 ? 55 : zoom <= 10 ? 40 : 26),
    disableClusteringAtZoom: 15,
    spiderfyOnMaxZoom: true,
    chunkedLoading: true,
    iconCreateFunction(cluster) {
      let count = 0;
      let best = 'past';
      let tier = 99;
      for (const m of cluster.getAllChildMarkers()) {
        count += m.options.count;
        if (RANK[m.options.bucket] < RANK[best]) best = m.options.bucket;
        if (m.options.tier < tier) tier = m.options.tier;
      }
      return L.divIcon({
        html: `<div class="cluster-icon ${best}${tier === 0 ? ' national' : ''}">${count > 999 ? Math.round(count / 100) / 10 + 'k' : count}${cornerTier(tier)}</div>`,
        className: 'cluster',
        iconSize: [40, 40],
      });
    },
  });
  map.addLayer(clusters);

  let meLayer = null;

  // ---------- data ----------
  async function load() {
    const res = await fetch('data/matches.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();

    const comps = data.comps.map(([name, gender, cat, national, age, , tier]) => ({ name, gender, cat, national: !!national, age, tier }));
    const siteByKey = new Map();
    const venues = data.venues.map(([name, lat, lon, approx]) => {
      const v = { name, lat, lon, approx: !!approx, site: null };
      if (lat != null) {
        const key = `${lat.toFixed(4)},${lon.toFixed(4)}`;
        if (!siteByKey.has(key)) siteByKey.set(key, { lat, lon, approx: true, names: new Set(), matches: [] });
        v.site = siteByKey.get(key);
        v.site.names.add(name);
        if (!approx) v.site.approx = false;
      }
      return v;
    });
    matches = data.matches.map(([id, t, status, tbd, home, away, ci, vi, hl, al, nt]) => {
      const venue = venues[vi];
      const comp = comps[ci];
      const m = {
        id, t, status, tbd: !!tbd, home, away, comp, venue, hl, al, nt: !!nt,
        day: ymd(new Date(t * 1000)),
        search: `${home} ${away} ${comp.name} ${venue.name}`.toLowerCase(),
      };
      if (venue.site) venue.site.matches.push(m);
      return m;
    });
    sites = [...siteByKey.values()];
    for (const s of sites) s.title = siteTitle([...s.names]);

    // Start on the first day that still has matches to go (late evening that's tomorrow).
    const now = nowSec();
    const today = ymd(new Date());
    const upcoming = data.days.filter((d) => d >= today);
    state.day = upcoming.find((d) => matches.some((m) => m.day === d && !m.tbd && passes(m, now, { ignoreDay: true }))) || upcoming[0] || 'all';
    $('#updated').textContent = `Last update ${fmtStamp.format(new Date(data.generated))}.`;
    buildAgeOptions();
    syncControls();
    render();
    autoLocate();
  }

  // Common prefix of the pitch names ("Hagby IP 1", "Hagby IP 3" -> "Hagby IP").
  function siteTitle(names) {
    if (names.length === 1) return names[0] || 'Unnamed venue';
    let p = names[0];
    for (const n of names) while (!n.startsWith(p)) p = p.slice(0, -1);
    p = p.replace(/[\s,/(\-:]+[A-Za-z0-9]?$/, '').replace(/[\s,/(\-:]+$/, '');
    return p.length >= 4 ? p : names[0];
  }

  // ---------- filtering ----------
  function isFinished(m, now) {
    return m.status === 4 || (!m.tbd && m.t + PLAYING_SECS < now);
  }

  function bucket(m, now, today) {
    if (m.status === 3 || isFinished(m, now)) return 'past';
    if (m.tbd || m.status === 2) return m.day === today ? 'today' : 'later';
    if (m.t <= now) return 'live';
    if (m.t - now <= 3 * 3600) return 'soon';
    return m.day === today ? 'today' : 'later';
  }

  function passes(m, now, { ignoreDay = false } = {}) {
    const c = m.comp;
    if (c.gender !== state.gender && c.gender !== 4) return false;
    if (!state.cats.includes(c.cat)) return false;
    if (state.level === 'national' && !c.national) return false;
    if (state.level === 'district' && c.national) return false;
    if (state.tiers.length < ALL_TIERS.length && !state.tiers.includes(tierKey(m))) return false;
    if (state.age && c.age !== Number(state.age)) return false;
    if (!state.approx && m.venue.approx) return false;
    if (state.q && !state.q.split(/\s+/).every((w) => m.search.includes(w))) return false;
    if (state.now) {
      return !m.tbd && m.status !== 3 && m.status !== 2 && m.status !== 4 && m.t - 3600 <= now && m.t + PLAYING_SECS >= now;
    }
    if (!state.finished && isFinished(m, now)) return false;
    if (!ignoreDay && state.day !== 'all' && m.day !== state.day) return false;
    return true;
  }

  // ---------- render ----------
  function render({ fit = false } = {}) {
    const now = nowSec();
    const today = ymd(new Date());
    visible = matches.filter((m) => passes(m, now));

    // markers
    const bySite = new Map();
    for (const m of visible) {
      const s = m.venue.site;
      if (!s) continue;
      if (!bySite.has(s)) bySite.set(s, []);
      bySite.get(s).push(m);
    }
    const markers = [];
    markerBySite = new Map();
    for (const [site, ms] of bySite) {
      let best = 'past';
      let tier = 99;
      let top = null; // the match the marker represents: highest tier, then soonest
      for (const m of ms) {
        const b = bucket(m, now, today);
        if (RANK[b] < RANK[best]) best = b;
        const r = markerRank(m);
        if (!top || r < tier || (r === tier && sortTime(m) < sortTime(top))) {
          tier = r;
          top = m;
        }
      }
      const national = tier === 0;
      // Senior league, national-team and Svenska Cupen venues show the home club's crest; the
      // ring keeps the timing colour and the match count moves to a small bubble.
      const crest = tier <= 10 || tier === 50 ? top.hl : 0;
      const classes = `site-icon ${best}${site.approx ? ' approx' : ''}${national ? ' national' : ''}${crest ? ' crest' : ''}`;
      const inner = crest ? `<img src="${crestUrl(crest)}" alt="">${ms.length > 1 ? `<b class="count">${ms.length}</b>` : ''}` : ms.length;
      const marker = L.marker([site.lat, site.lon], {
        icon: L.divIcon({
          html: `<div class="${classes}">${inner}${cornerTier(tier)}</div>`,
          className: 'site',
          iconSize: crest || national ? [38, 38] : [30, 30],
        }),
        zIndexOffset: national ? 1000 : 0,
        count: ms.length,
        bucket: best,
        tier,
        title: site.title,
        keyboard: true,
      });
      marker.bindPopup(() => popupHtml(site, ms, now, today), { maxWidth: 340, autoPanPadding: [20, 60] });
      markers.push(marker);
      markerBySite.set(site, marker);
    }
    clusters.clearLayers();
    clusters.addLayers(markers);

    renderDays(now);
    renderSummary(bySite.size);
    shown = PAGE;
    renderList();
    updateFilterBadge();
    if (fit) fitToVisible(bySite);
  }

  function fitToVisible(bySite) {
    const pts = [...bySite.keys()].map((s) => [s.lat, s.lon]);
    if (pts.length) map.fitBounds(L.latLngBounds(pts).pad(0.1), { maxZoom: 13 });
  }

  function renderDays(now) {
    const counts = new Map();
    let total = 0;
    for (const m of matches) {
      if (!passes(m, now, { ignoreDay: true })) continue;
      counts.set(m.day, (counts.get(m.day) || 0) + 1);
      total++;
    }
    const today = ymd(new Date());
    const tomorrow = ymd(new Date(Date.now() + 86_400_000));
    const label = (d) => {
      if (d === today) return 'Today';
      if (d === tomorrow) return 'Tomorrow';
      const [y, mo, da] = d.split('-').map(Number);
      return new Date(Date.UTC(y, mo - 1, da, 12)).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', timeZone: 'UTC' });
    };
    const html = [`<button data-v="all" aria-pressed="${state.day === 'all' && !state.now}">All week <small>${total}</small></button>`];
    for (const d of data.days) {
      if (d < today) continue;
      html.push(`<button data-v="${d}" aria-pressed="${state.day === d && !state.now}">${label(d)} <small>${counts.get(d) || 0}</small></button>`);
    }
    $('#days').innerHTML = html.join('');
  }

  function renderSummary(siteCount) {
    const n = visible.length;
    const who = state.gender === 3 ? 'women’s & girls’' : 'men’s & boys’';
    let text = `${n.toLocaleString('en')} ${who} match${n === 1 ? '' : 'es'} at ${siteCount.toLocaleString('en')} venue${siteCount === 1 ? '' : 's'}`;
    if (state.now) text += ' playing now or within the hour';
    else if (state.day !== 'all') text += ` · ${dayName(state.day)}`;
    if (me) {
      const nearest = nearestDistance();
      if (nearest != null) text += ` · nearest ${fmtKm(nearest)}`;
    }
    $('#summary').textContent = text;
    sizePeek();
  }

  function dayName(d) {
    const today = ymd(new Date());
    if (d === today) return 'today';
    if (d === ymd(new Date(Date.now() + 86_400_000))) return 'tomorrow';
    const [y, mo, da] = d.split('-').map(Number);
    return fmtDayLong.format(new Date(Date.UTC(y, mo - 1, da, 12)));
  }

  function nearestDistance() {
    let best = null;
    for (const m of visible) {
      if (!m.venue.site) continue;
      const d = distKm(me, [m.venue.site.lat, m.venue.site.lon]);
      if (best == null || d < best) best = d;
    }
    return best;
  }

  function listItems() {
    let items = visible;
    if (state.listMode === 'view') {
      const b = map.getBounds();
      items = items.filter((m) => m.venue.site && b.contains([m.venue.site.lat, m.venue.site.lon]));
    }
    const withDist = items.map((m) => ({ m, d: me && m.venue.site ? distKm(me, [m.venue.site.lat, m.venue.site.lon]) : null }));
    if (state.sort === 'dist' && me) {
      withDist.sort((a, b) => (a.d ?? 1e9) - (b.d ?? 1e9) || sortTime(a.m) - sortTime(b.m));
    } else {
      withDist.sort((a, b) => sortTime(a.m) - sortTime(b.m) || (a.d ?? 1e9) - (b.d ?? 1e9));
    }
    return withDist;
  }

  function renderList() {
    const items = listItems();
    const list = $('#list');
    if (!items.length) {
      const hint = state.listMode === 'view' && visible.length
        ? 'No matches in this part of the map. Zoom out or switch to “All”.'
        : 'No matches for these filters.';
      list.innerHTML = `<li class="empty">${hint}</li>`;
      $('#more').hidden = true;
      return;
    }
    const now = nowSec();
    const today = ymd(new Date());
    const out = [];
    let lastDay = null;
    for (const { m, d } of items.slice(0, shown)) {
      if (state.sort === 'time' && m.day !== lastDay) {
        out.push(`<li class="day-head">${esc(dayName(m.day))}</li>`);
        lastDay = m.day;
      }
      const b = bucket(m, now, today);
      const tags = statusTags(m, b);
      out.push(`<li class="match${m.venue.site ? '' : ' nolocation'}${m.nt ? ' national' : ''}" tabindex="0" data-id="${m.id}">
        <span class="time">${m.tbd ? 'TBD' : fmtTime.format(new Date(m.t * 1000))}</span>
        <span class="teams">${crestImg(m.hl)}${esc(m.home)} <span>–</span> ${crestImg(m.al)}${esc(m.away)}${tags}</span>
        <span class="dist">${d != null ? fmtKm(d) : ''}</span>
        <span class="meta">${state.sort === 'dist' ? esc(dayName(m.day)) + ' · ' : ''}${tierBadge(m)}${esc(m.comp.name)} · ${m.venue.name ? esc(m.venue.name) : 'Venue not listed'}${m.venue.site ? '' : ' (not on map)'}</span>
      </li>`);
    }
    list.innerHTML = out.join('');
    $('#more').hidden = items.length <= shown;
    $('#more').textContent = `Show more (${(items.length - shown).toLocaleString('en')} left)`;
  }

  function statusTags(m, b) {
    let t = '';
    if (b === 'live' && !m.tbd) t += '<span class="tag live">LIVE</span>';
    if (m.status === 3) t += '<span class="tag off">Cancelled</span>';
    else if (m.status === 2) t += '<span class="tag off">Postponed/TBD</span>';
    else if (m.status === 4) t += '<span class="tag done">Played</span>';
    if (m.venue.approx) t += '<span class="tag approx" title="Placed at the town, not the exact pitch">≈ location</span>';
    return t;
  }

  function popupHtml(site, ms, now, today) {
    ms = [...ms].sort((a, b) => sortTime(a) - sortTime(b));
    const multiple = site.names.size > 1;
    const out = [`<div class="pop"><h3>${esc(site.title)}</h3><div class="sub">`];
    out.push(`<span>${ms.length} match${ms.length === 1 ? '' : 'es'}</span>`);
    if (me) out.push(`<span>${fmtKm(distKm(me, [site.lat, site.lon]))} away</span>`);
    out.push(`<a href="https://www.google.com/maps/dir/?api=1&destination=${site.lat},${site.lon}" target="_blank" rel="noopener">Directions ↗</a></div>`);
    if (site.approx) {
      out.push('<div class="note">Approximate location. This pitch isn’t named on OpenStreetMap, so it’s placed at a football ground in the club’s town.</div>');
    }
    out.push('<ol>');
    let lastDay = null;
    for (const m of ms) {
      if (m.day !== lastDay) {
        out.push(`<li class="d">${esc(dayName(m.day))}</li>`);
        lastDay = m.day;
      }
      const b = bucket(m, now, today);
      const team = (name, crest) => `<span>${crestImg(crest)}${esc(name)}</span>`;
      out.push(`<li class="m${m.nt ? ' national' : ''}"><span class="t">${m.tbd ? 'TBD' : fmtTime.format(new Date(m.t * 1000))}</span>
        <span class="tm">${team(m.home, m.hl)}${team(m.away, m.al)}</span>
        <span class="c">${statusTags({ ...m, venue: { approx: false } }, b)} ${tierBadge(m)}${esc(m.comp.name)}${multiple && m.venue.name !== site.title ? ` · ${esc(m.venue.name)}` : ''} · <a href="${matchUrl(m.id)}" target="_blank" rel="noopener">Match page ↗</a></span></li>`);
    }
    out.push('</ol></div>');
    return out.join('');
  }

  // ---------- helpers ----------
  function tierBadge(m) {
    if (m.nt) return '<span class="tier tn" title="Sweden national team">SWE</span>';
    const comp = m.comp;
    if (comp.tier === 'C') return '<span class="tier tc" title="Svenska Cupen">C</span>';
    if (comp.tier === 'R') return '<span class="tier tr" title="Reserve / B-team / development league">R</span>';
    if (!comp.tier) return '';
    const name = tierNames(comp.gender)[comp.tier] || 'lower division';
    return `<span class="tier t${Math.min(comp.tier, 9)}" title="Tier ${comp.tier}: ${name}">T${comp.tier}</span>`;
  }

  // Small corner badge on a marker: the highest senior tier played there, else C for Svenska Cupen.
  function cornerTier(tier) {
    if (tier === 0) return '<span class="corner tier tn">SWE</span>';
    if (tier <= 10) return `<span class="corner tier t${Math.min(tier, 9)}">${tier}</span>`;
    return tier === 50 ? '<span class="corner tier tc">C</span>' : '';
  }

  // Tier chip and legend tooltips name only the selected gender's leagues.
  function syncTierLabels() {
    const names = tierNames(state.gender);
    for (const b of $('#tiers').querySelectorAll('button')) {
      const v = Number(b.dataset.v);
      if (v >= 1 && v <= 8) b.title = `Tier ${v} · ${names[v]}`;
    }
    $('#tierLegend').title = `Highest senior tier played at a venue: 1 = ${names[1]}, 2 = ${names[2]}, 3 = ${names[3]} … 8 = ${names[8]}, 9+ = ${names[9]} and below. C = Svenska Cupen, SWE = Sweden national team.`;
  }

  function distKm(a, b) {
    const r = Math.PI / 180;
    const h = Math.sin(((b[0] - a[0]) * r) / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(((b[1] - a[1]) * r) / 2) ** 2;
    return 12742 * Math.asin(Math.sqrt(h));
  }
  const fmtKm = (d) => (d < 1 ? `${Math.round(d * 1000 / 50) * 50} m` : d < 10 ? `${d.toFixed(1)} km` : `${Math.round(d)} km`);

  let toastTimer;
  function toast(msg, ms = 3500) {
    const el = $('#toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), ms);
  }

  function buildAgeOptions() {
    const ages = [...new Set(data.comps.filter((c) => c[1] === state.gender).map((c) => c[4]).filter((a) => a != null))]
      .sort((a, b) => b - a);
    const letter = state.gender === 3 ? 'F' : 'P';
    $('#age').innerHTML = '<option value="">Any age</option>' + ages.map((a) => `<option value="${a}">${letter}${a} · ${a} years</option>`).join('');
    if (state.age && !ages.includes(Number(state.age))) state.age = '';
  }

  function syncControls() {
    for (const b of $('#gender').children) b.setAttribute('aria-pressed', String(Number(b.dataset.v) === state.gender));
    for (const b of $('#cats').children) b.setAttribute('aria-pressed', String(state.cats.includes(Number(b.dataset.v))));
    for (const b of $('#tiers').querySelectorAll('button')) b.setAttribute('aria-pressed', String(state.tiers.includes(Number(b.dataset.v))));
    syncTierLabels();
    for (const b of $('#listMode').children) b.setAttribute('aria-pressed', String(b.dataset.v === state.listMode));
    for (const b of $('#sortMode').children) b.setAttribute('aria-pressed', String(b.dataset.v === state.sort));
    $('#level').value = state.level;
    $('#age').value = state.age;
    $('#q').value = state.q;
    $('#approx').checked = state.approx;
    $('#finished').checked = state.finished;
    $('#now').setAttribute('aria-pressed', String(state.now));
  }

  function updateFilterBadge() {
    let n = 0;
    if (state.cats.length < DEFAULTS.cats.length) n++;
    if (state.tiers.length < ALL_TIERS.length) n++;
    if (state.level !== 'all') n++;
    if (state.age) n++;
    if (state.q) n++;
    if (!state.approx) n++;
    if (state.finished) n++;
    const el = $('#filterCount');
    el.hidden = !n;
    el.textContent = n;
  }

  function changed(opts) {
    if (!data) return;
    store.set(STORE_KEY, pick(state, PERSISTED));
    syncControls();
    render(opts);
  }

  // ---------- geolocation ----------
  function locate({ quiet = false } = {}) {
    if (!('geolocation' in navigator)) {
      if (!quiet) toast('Your browser cannot share its location.');
      return;
    }
    const btn = $('#locate');
    btn.disabled = true;
    btn.querySelector('span').textContent = 'Locating…';
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        btn.disabled = false;
        btn.querySelector('span').textContent = 'Near me';
        me = [pos.coords.latitude, pos.coords.longitude];
        if (meLayer) meLayer.remove();
        meLayer = L.layerGroup([
          L.circle(me, { radius: Math.min(pos.coords.accuracy, 2000), color: '#2f7cf6', weight: 1, fillOpacity: 0.08, interactive: false }),
          L.marker(me, { icon: L.divIcon({ className: '', html: '<div class="me-dot"></div>', iconSize: [16, 16] }), interactive: false, keyboard: false }),
        ]).addTo(map);
        $('#sortMode [data-v="dist"]').disabled = false;
        $('#sortMode [data-v="dist"]').removeAttribute('title');
        state.sort = 'dist';
        state.listMode = 'view';
        syncControls();
        zoomToNearby();
        render();
      },
      (err) => {
        btn.disabled = false;
        btn.querySelector('span').textContent = 'Near me';
        if (!quiet) toast(err.code === 1 ? 'Location access was blocked. Allow it in your browser to see nearby matches.' : 'Could not get your location right now.');
      },
      { enableHighAccuracy: false, timeout: 12000, maximumAge: 300000 },
    );
  }

  // Zoom so the nearest ~15 venues with matches (under current filters) are in view.
  function zoomToNearby() {
    const now = nowSec();
    const ds = [];
    const seen = new Set();
    for (const m of matches) {
      const s = m.venue.site;
      if (!s || seen.has(s) || !passes(m, now)) continue;
      seen.add(s);
      ds.push(distKm(me, [s.lat, s.lon]));
    }
    ds.sort((a, b) => a - b);
    const radiusKm = Math.min(Math.max(ds[Math.min(14, ds.length - 1)] || 5, 2), 60);
    map.fitBounds(L.latLng(me).toBounds(radiusKm * 2000), { maxZoom: 15 });
  }

  async function autoLocate() {
    try {
      const p = await navigator.permissions?.query({ name: 'geolocation' });
      if (p?.state === 'granted') locate({ quiet: true });
    } catch { /* permissions API missing */ }
  }

  // ---------- events ----------
  $('#days').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    state.day = b.dataset.v;
    state.now = false;
    changed();
  });
  $('#gender').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    state.gender = Number(b.dataset.v);
    buildAgeOptions();
    changed();
  });
  // Chip groups start with everything shown. The first click picks just that chip, later clicks
  // add or remove chips, and removing the last one shows everything again.
  function pickChip(selected, all, v) {
    if (selected.length === all.length) return [v];
    const next = selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v];
    return next.length ? next : all;
  }
  $('#cats').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    state.cats = pickChip(state.cats, DEFAULTS.cats, Number(b.dataset.v));
    changed();
  });
  $('#tiers').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    state.tiers = pickChip(state.tiers, ALL_TIERS, Number(b.dataset.v));
    changed();
  });
  $('#tiersAll').addEventListener('click', () => { state.tiers = ALL_TIERS; changed(); });
  $('#level').addEventListener('change', (e) => { state.level = e.target.value; changed(); });
  $('#age').addEventListener('change', (e) => { state.age = e.target.value; changed(); });
  $('#approx').addEventListener('change', (e) => { state.approx = e.target.checked; changed(); });
  $('#finished').addEventListener('change', (e) => { state.finished = e.target.checked; changed(); });
  let qTimer;
  $('#q').addEventListener('input', (e) => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => {
      state.q = e.target.value.trim().toLowerCase();
      changed({ fit: state.q.length >= 3 }); // searching for a team or venue: show where it plays
    }, 250);
  });
  $('#reset').addEventListener('click', () => {
    Object.assign(state, { ...DEFAULTS, day: state.day, gender: state.gender, sort: me ? 'dist' : 'time' });
    changed();
  });
  $('#now').addEventListener('click', () => {
    state.now = !state.now;
    changed();
    if (state.now && !visible.length) toast('Nothing is being played right now with these filters.');
  });
  $('#locate').addEventListener('click', () => locate());
  $('#listMode').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    state.listMode = b.dataset.v;
    store.set(STORE_KEY, pick(state, PERSISTED));
    syncControls();
    shown = PAGE;
    renderList();
  });
  $('#sortMode').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    state.sort = b.dataset.v;
    syncControls();
    shown = PAGE;
    renderList();
  });
  $('#more').addEventListener('click', () => { shown += PAGE; renderList(); });

  function openMatch(li) {
    const m = matches.find((x) => x.id === Number(li.dataset.id));
    if (!m?.venue.site) return;
    const marker = markerBySite.get(m.venue.site);
    if (!marker) return;
    setSheet(false);
    clusters.zoomToShowLayer(marker, () => marker.openPopup());
  }
  $('#list').addEventListener('click', (e) => {
    if (e.target.closest('a')) return;
    const li = e.target.closest('.match');
    if (li) openMatch(li);
  });
  $('#list').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.classList.contains('match')) openMatch(e.target);
  });

  let listTimer;
  map.on('moveend', () => {
    if (state.listMode !== 'view' || !data) return;
    clearTimeout(listTimer);
    listTimer = setTimeout(() => { shown = PAGE; renderList(); }, 120);
  });

  // mobile bottom sheet
  const panel = $('#panel');
  function setSheet(open) {
    panel.classList.toggle('open', open);
    $('#sheetHandle').setAttribute('aria-expanded', String(open));
  }
  $('#sheetHandle').addEventListener('click', () => setSheet(!panel.classList.contains('open')));
  $('#summary').addEventListener('click', () => setSheet(!panel.classList.contains('open')));
  $('#filtersToggle').addEventListener('click', () => {
    const f = $('#filters');
    const open = !f.classList.contains('open');
    f.classList.toggle('open', open);
    $('#filtersToggle').setAttribute('aria-expanded', String(open));
    if (open) setSheet(true);
  });
  function sizePeek() {
    const h = document.querySelector('.brand').offsetHeight + 8;
    document.documentElement.style.setProperty('--peek', `${h}px`);
  }
  window.addEventListener('resize', sizePeek);
  sizePeek();

  // Keep "playing now" colours honest while the page stays open (but never yank an open popup).
  let popupOpen = false;
  map.on('popupopen', () => (popupOpen = true));
  map.on('popupclose', () => (popupOpen = false));
  setInterval(() => {
    if (document.visibilityState === 'visible' && data && !popupOpen) render();
  }, 5 * 60 * 1000);

  load().catch((err) => {
    console.error(err);
    $('#summary').textContent = 'Could not load match data. Try again later.';
  });
})();
