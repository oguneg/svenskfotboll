(() => {
  'use strict';

  const TZ = 'Europe/Stockholm';
  const SWEDEN = [[55.2, 10.9], [69.1, 24.2]];
  const MAIN_STORE_KEY = 'fotbollskartan:filters:v4'; // shared with the match map (gender)
  const DIVISIONS = { 4: 'Division 2', 5: 'Division 3', 6: 'Division 4', 7: 'Division 5', 8: 'Division 6', 9: 'Division 7', 10: 'Division 8' };
  const TIER_NAMES = {
    2: { 1: 'Allsvenskan', 2: 'Superettan', 3: 'Ettan', ...DIVISIONS },
    3: { 1: 'Damallsvenskan', 2: 'Elitettan', 3: 'Division 1', ...DIVISIONS },
  };
  // Crest size (px at zoom 8) and the zoom a club first appears at, by tier. Clubs without a
  // senior league team (youth only, or out of season) are "tier 99".
  const SIZE = { 1: 58, 2: 48, 3: 41, 4: 35, 5: 31, 6: 28, 7: 25, 8: 23, 9: 21, 10: 21, 99: 18 };
  const FIRST_ZOOM = { 1: 0, 2: 5, 3: 6, 4: 7, 5: 8, 6: 8, 7: 9, 8: 9, 9: 10, 10: 10, 99: 11 };
  const zoomScale = (z) => Math.max(0.48, Math.min(1.3, 0.48 + (z - 4) * 0.1));

  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const fold = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
  };
  const fmtTime = new Intl.DateTimeFormat('sv-SE', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
  const fmtDay = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' });

  let gender = store.get(MAIN_STORE_KEY, {}).gender === 3 ? 3 : 2;
  let clubs = [];
  let ranked = []; // clubs for the current gender, most important first
  const shown = new Map(); // club id -> marker currently on the map
  let matchesPromise = null;

  // ---------- map ----------
  const map = L.map('map', { zoomControl: true, minZoom: 4 }).fitBounds(SWEDEN);
  map.zoomControl.setPosition('bottomright');
  map.attributionControl.setPrefix(false);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);
  const layer = L.layerGroup().addTo(map);

  // Opened while hidden, the map measures 0×0; frame Sweden once it has a real size.
  let framed = map.getSize().x > 0;
  new ResizeObserver(() => {
    map.invalidateSize();
    if (framed || map.getSize().x === 0) return;
    framed = true;
    map.fitBounds(SWEDEN);
    layout();
  }).observe(document.getElementById('map'));

  // ---------- data ----------
  async function load() {
    const res = await fetch('data/clubs.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const side = (s) => (s ? { tier: s[0], league: s[1], ll: L.latLng(s[2], s[3]), approx: !!s[4], venue: s[5] } : null);
    clubs = data.clubs.map(([id, name, men, women]) => ({ id, name, key: fold(name), men: side(men), women: side(women) }));
    setGender(gender);
  }

  function sideOf(c, g = gender) {
    return g === 3 ? c.women : c.men;
  }

  function setGender(g) {
    gender = g;
    for (const b of $('#gender').children) b.setAttribute('aria-pressed', String(Number(b.dataset.v) === g));
    const main = store.get(MAIN_STORE_KEY, {});
    store.set(MAIN_STORE_KEY, { ...main, gender: g });
    ranked = clubs
      .filter((c) => sideOf(c))
      .map((c) => ({ c, s: sideOf(c), tier: sideOf(c).tier || 99 }))
      .sort((a, b) => a.tier - b.tier || a.c.name.localeCompare(b.c.name, 'sv'));
    const tiered = ranked.filter((r) => r.tier < 99).length;
    $('#clubSummary').textContent = `${ranked.length.toLocaleString('en')} ${g === 3 ? 'women’s' : 'men’s'} clubs · ${tiered.toLocaleString('en')} with a senior league team`;
    for (const m of shown.values()) layer.removeLayer(m);
    shown.clear();
    map.closePopup();
    layout();
  }

  // ---------- layout: biggest clubs first, nothing may cover a more important crest ----------
  function layout() {
    if (!ranked.length || map.getSize().x === 0) return;
    const z = map.getZoom();
    const scale = zoomScale(z);
    const bounds = map.getBounds().pad(0.15);
    const CELL = 48;
    const grid = new Map();
    const placed = new Map(); // id -> { r, point, size }

    const cellsAround = (p, r) => {
      const out = [];
      for (let x = Math.floor((p.x - r) / CELL); x <= Math.floor((p.x + r) / CELL); x++) {
        for (let y = Math.floor((p.y - r) / CELL); y <= Math.floor((p.y + r) / CELL); y++) out.push(`${x},${y}`);
      }
      return out;
    };
    const fits = (p, r) => cellsAround(p, r).every((k) => !(grid.get(k) || []).some((o) => o.p.distanceTo(p) < o.r + r));
    const occupy = (p, r) => {
      for (const k of cellsAround(p, r)) {
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push({ p, r });
      }
    };

    for (const { c, s, tier } of ranked) {
      if (z < FIRST_ZOOM[tier] || !bounds.contains(s.ll)) continue;
      const size = Math.round(SIZE[tier] * scale);
      // Crests are roughly round, so a little overlap at the corners is fine; the top two tiers
      // may overlap more so that crowded cities keep all of their big clubs.
      const r = size * (tier <= 2 ? 0.36 : 0.46);
      const home = map.latLngToContainerPoint(s.ll);
      let at = fits(home, r) ? home : null;
      // Top-two-tier clubs never disappear: nudge them slightly, or overlap (higher tier on top).
      if (!at && tier <= 2) {
        for (let i = 0; i < 8 && !at; i++) {
          const p = home.add([Math.cos((i * Math.PI) / 4) * size * 0.7, Math.sin((i * Math.PI) / 4) * size * 0.7]);
          if (fits(p, r)) at = p;
        }
        at ||= home;
      }
      if (!at) continue;
      occupy(at, r);
      placed.set(c.id, { at, size, tier, c, s });
    }

    // Sync markers with the new placement.
    for (const [id, marker] of shown) {
      if (!placed.has(id)) {
        layer.removeLayer(marker);
        shown.delete(id);
      }
    }
    for (const [id, p] of placed) {
      const ll = map.containerPointToLatLng(p.at);
      const icon = () => L.divIcon({
        className: `club-marker t${p.tier}`,
        html: `<img src="crests/${id}.png" alt="" draggable="false">`,
        iconSize: [p.size, p.size],
      });
      let marker = shown.get(id);
      if (!marker) {
        marker = L.marker(ll, { icon: icon(), keyboard: true, title: p.c.name, riseOnHover: true, zIndexOffset: (100 - p.tier) * 10 });
        marker.options.sizeKey = p.size;
        marker.on('click', () => openClub(p.c));
        layer.addLayer(marker);
        shown.set(id, marker);
        continue;
      }
      marker.setLatLng(ll);
      if (marker.options.sizeKey !== p.size) {
        marker.options.sizeKey = p.size;
        marker.setIcon(icon()); // zoom changed the crest size
      }
    }
  }
  map.on('moveend', layout);

  // ---------- club popup ----------
  function tierBadge(tier, g) {
    if (!tier) return '';
    const name = TIER_NAMES[g === 3 ? 3 : 2][tier] || 'lower division';
    return `<span class="tier t${Math.min(tier, 9)}" title="Tier ${tier}: ${name}">T${tier}</span>`;
  }

  function sideLine(label, s, g) {
    if (!s) return '';
    const league = s.tier ? `${tierBadge(s.tier, g)}${esc(s.league)}` : '<span class="muted">No senior league team this season</span>';
    return `<div class="club-line"><span class="k">${label}</span><span>${league}</span></div>`;
  }

  function openClub(c) {
    const s = sideOf(c) || c.men || c.women;
    const html = `<div class="pop club-pop">
      <div class="club-head"><img src="crests/${c.id}.png" alt=""><div><h3>${esc(c.name)}</h3>
      <div class="sub"><span>${esc(s.venue)}${s.approx ? ' (approx.)' : ''}</span></div></div></div>
      ${sideLine('Men', c.men, 2)}${sideLine('Women', c.women, 3)}
      <div class="club-games" id="clubGames"><span class="muted">Loading home games…</span></div>
      <div class="sub"><a href="./?q=${encodeURIComponent(c.name)}">Show on the match map ↗</a>
      <a href="https://www.google.com/maps/dir/?api=1&destination=${s.ll.lat},${s.ll.lng}" target="_blank" rel="noopener">Directions ↗</a></div>
    </div>`;
    const marker = shown.get(c.id);
    // Keep the popup clear of the floating search card when the map pans to show it.
    const barBottom = $('.club-bar').getBoundingClientRect().bottom;
    L.popup({
      maxWidth: 340,
      autoPanPaddingTopLeft: [16, barBottom + 12],
      autoPanPaddingBottomRight: [16, 40],
      offset: [0, -((marker?.options.sizeKey || 30) / 2) + 4],
    })
      .setLatLng(marker ? marker.getLatLng() : s.ll)
      .setContent(html)
      .openOn(map);
    fillGames(c);
  }

  // Upcoming home games come from the match data, loaded on first use.
  async function fillGames(c) {
    matchesPromise ||= fetch('data/matches.json', { cache: 'no-cache' }).then((r) => r.json());
    let data;
    try {
      data = await matchesPromise;
    } catch {
      return;
    }
    const el = document.getElementById('clubGames');
    if (!el) return;
    const now = Date.now() / 1000;
    const games = data.matches
      .filter((m) => m[8] === c.id && m[1] + 6600 > now)
      .filter((m) => { const g = data.comps[m[6]][1]; return g === gender || g === 4; })
      .sort((a, b) => a[1] - b[1])
      .slice(0, 5);
    if (!games.length) {
      el.innerHTML = '<span class="muted">No home games in the next two weeks.</span>';
      return;
    }
    el.innerHTML = '<div class="d">Next home games</div><ol>' + games.map((m) => {
      const comp = data.comps[m[6]];
      const when = m[3] ? `${fmtDay.format(new Date(m[1] * 1000))} · TBD` : `${fmtDay.format(new Date(m[1] * 1000))} · ${fmtTime.format(new Date(m[1] * 1000))}`;
      const tier = typeof comp[6] === 'number' ? tierBadge(comp[6], comp[1]) : '';
      return `<li><span class="w">${when}</span><span class="f">${esc(m[4])} – ${esc(m[5])}</span><span class="c">${tier}${esc(comp[0])}</span></li>`;
    }).join('') + '</ol>';
  }

  // ---------- search ----------
  const input = $('#clubSearch');
  const results = $('#clubResults');
  function showResults() {
    const q = fold(input.value.trim());
    if (q.length < 2) {
      results.hidden = true;
      return;
    }
    const hits = ranked.filter((r) => r.c.key.includes(q)).slice(0, 8);
    results.innerHTML = hits.length
      ? hits.map((r) => `<li><button data-id="${r.c.id}"><img src="crests/${r.c.id}.png" alt="">${esc(r.c.name)}${tierBadge(r.s.tier, gender)}</button></li>`).join('')
      : '<li class="muted">No club by that name</li>';
    results.hidden = false;
  }
  input.addEventListener('input', showResults);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') results.querySelector('button')?.click();
    if (e.key === 'Escape') results.hidden = true;
  });
  results.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const club = clubs.find((c) => c.id === Number(b.dataset.id));
    const s = club && sideOf(club);
    if (!s) return;
    results.hidden = true;
    input.blur();
    map.once('moveend', () => setTimeout(() => openClub(club), 50));
    map.flyTo(s.ll, Math.max(map.getZoom(), 12), { duration: 0.8 });
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.club-search')) results.hidden = true;
  });

  $('#gender').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b && Number(b.dataset.v) !== gender) setGender(Number(b.dataset.v));
  });

  load().catch((err) => {
    console.error(err);
    $('#clubSummary').textContent = 'Could not load clubs. Try again later.';
  });
})();
