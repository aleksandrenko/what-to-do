(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const bigBtn = $('#bigBtn');
  const bigBtnFace = $('#bigBtnFace');
  const INTERESTS = window.INTERESTS;
  const ACTIVITIES = window.ACTIVITIES;
  const INTEREST = Object.fromEntries(INTERESTS.map(([id, emoji, label]) => [id, { emoji, label }]));
  const BUDGET_MAX = { free: 0, cheap: 1, any: 3 };
  const MIN_INTERESTS = 3;

  // ---------- Storage (profile + what the app learned; stays on this device) ----------

  const STORE_KEY = 'what-to-do.v1';
  const fresh = () => ({
    interests: [], budget: 'any', name: '', place: null,
    learn: { tags: {}, acts: {} }, recent: [], friends: [],
  });

  function load() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORE_KEY));
      if (saved && typeof saved === 'object') {
        const s = { ...fresh(), ...saved };
        s.learn = { tags: {}, acts: {}, ...s.learn };
        return s;
      }
    } catch { /* storage unavailable: start fresh */ }
    return fresh();
  }

  let state = load();
  const save = () => {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch { /* ignore */ }
  };

  // ---------- Small DOM helper (no innerHTML: names can come from invite links) ----------

  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) {
      if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
  }

  const label = (tag) => INTEREST[tag]?.label.toLowerCase() ?? tag;
  const joinWords = (words) => words.length < 2 ? words.join('')
    : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

  // ---------- Invite links: ?from=Name&likes=a,b,c&idea=activityId ----------

  let invitedIdea = null;

  function readInvite() {
    const p = new URLSearchParams(location.search);
    const likes = (p.get('likes') || '').split(',').filter((t) => INTEREST[t]);
    if (likes.length) {
      const name = (p.get('from') || 'A friend').slice(0, 24).trim() || 'A friend';
      state.friends = state.friends.filter((f) => f.name !== name);
      state.friends.push({ name, tags: likes });
      const idea = ACTIVITIES.find((x) => x.id === p.get('idea'));
      if (idea) invitedIdea = idea;
      save();
      const note = $('#inviteNote');
      note.textContent = idea
        ? `👋 ${name} invited you: ${idea.emoji} ${idea.title}. Pick your interests so you can plan together.`
        : `👋 ${name} invited you. Pick your interests so you can plan together.`;
      note.hidden = false;
    }
    if (location.search) history.replaceState(null, '', location.pathname);
  }

  // ---------- Location + weather (Open-Meteo, free, no key) ----------

  async function fetchJSON(url) {
    const res = await fetch(url, { signal: AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  const WEATHER = [
    [[0], '☀️', 'clear'], [[1], '🌤️', 'mostly clear'], [[2], '⛅', 'partly cloudy'],
    [[3], '☁️', 'overcast'], [[45, 48], '🌫️', 'foggy'],
    [[51, 53, 55, 56, 57], '🌦️', 'drizzle'], [[61, 63, 65, 66, 67, 80, 81, 82], '🌧️', 'rain'],
    [[71, 73, 75, 77, 85, 86], '🌨️', 'snow'], [[95, 96, 99], '⛈️', 'thunderstorm'],
  ];
  const describe = (code) => {
    const hit = WEATHER.find(([codes]) => codes.includes(code));
    return hit ? { icon: hit[1], text: hit[2] } : { icon: '🌡️', text: '' };
  };

  let weather = null;
  let weatherPromise = null;

  function refreshWeather(force) {
    if (!state.place) { weather = null; renderPill(); return Promise.resolve(); }
    if (!force && weather && Date.now() - weather.at < 20 * 60e3) return Promise.resolve();
    if (weatherPromise) return weatherPromise;
    const { lat, lon } = state.place;
    const q = `latitude=${lat}&longitude=${lon}`;
    weatherPromise = Promise.all([
      fetchJSON(`https://api.open-meteo.com/v1/forecast?${q}&current=temperature_2m,precipitation,weather_code,wind_speed_10m,is_day&timezone=auto&forecast_days=1`),
      fetchJSON(`https://air-quality-api.open-meteo.com/v1/air-quality?${q}&current=european_aqi`).catch(() => null),
    ]).then(([w, air]) => {
      const c = w.current;
      weather = {
        at: Date.now(),
        temp: c.temperature_2m,
        code: c.weather_code,
        wet: c.precipitation > 0.1 || c.weather_code >= 51,
        clear: c.weather_code <= 1,
        windy: c.wind_speed_10m > 40,
        isDay: c.is_day === 1,
        aqi: air?.current?.european_aqi ?? null,
      };
    }).catch(() => { weather = null; })
      .finally(() => { weatherPromise = null; renderPill(); });
    return weatherPromise;
  }

  function renderPill() {
    const pill = $('#weatherPill');
    if (!state.place) { pill.textContent = '📍 Set location'; return; }
    const place = state.place.name || 'Your location';
    if (!weather) { pill.textContent = `📍 ${place}`; return; }
    pill.textContent = `${describe(weather.code).icon} ${Math.round(weather.temp)}°C · ${place}`;
  }

  // ---------- Matching: hard filters, then a score with reasons ----------

  function context() {
    const hour = new Date().getHours();
    const time = hour >= 5 && hour < 11 ? 'morning'
      : hour >= 11 && hour < 17 ? 'afternoon'
      : hour >= 17 && hour < 22 ? 'evening' : 'night';
    return {
      time,
      w: weather,
      daylight: weather ? weather.isDay : hour >= 7 && hour < 19,
    };
  }

  function evaluate(act, ctx, relaxed) {
    const { w } = ctx;
    const solo = state.friends.length === 0;

    // Hard filters: things that don't make sense right now
    if (!relaxed && !act.times.includes(ctx.time)) return null;
    if (!relaxed && act.price > BUDGET_MAX[state.budget]) return null;
    if (!solo && act.group === 'solo') return null;
    if (act.where === 'outdoor') {
      if (act.daylight && !ctx.daylight) return null;
      if (act.clear && (!w || !w.clear)) return null;
      if (w) {
        if (act.dry && w.wet) return null;
        if (act.temp && (w.temp < act.temp[0] || w.temp > act.temp[1])) return null;
      }
    }

    let score = 0;
    const why = []; // [priority, text]

    // Your interests
    const mine = act.tags.filter((t) => state.interests.includes(t));
    score += mine.length * 3;
    if (mine.length) why.push([10, `You're into ${joinWords(mine.slice(0, 2).map(label))}`]);
    else score -= 1.5;

    // What the app learned from your 👍 / 🔄
    for (const t of act.tags) score += clamp(state.learn.tags[t] || 0, -3, 3);
    const past = state.learn.acts[act.id];
    if (past) {
      score += clamp(past.like * 1.5 - past.skip * 0.75, -4, 4);
      if (past.like > past.skip) why.push([5, 'You liked this before']);
    }

    // Friends: favour what you have in common
    if (!solo) {
      for (const f of state.friends) {
        const shared = act.tags.filter((t) => f.tags.includes(t));
        score += shared.length * 2;
        if (shared.length) why.push([9, `${f.name} likes ${label(shared[0])} too`]);
      }
      if (act.group === 'group') score += 1.5;
    } else if (act.group === 'group') {
      score -= 0.5;
      why.push([2, 'Better with friends. Tap Invite.']);
    }

    // Weather
    if (w) {
      const t = Math.round(w.temp);
      if (act.where === 'outdoor') {
        if (w.aqi != null && w.aqi > 80) score -= 2.5;
        else if (w.temp >= 15 && w.temp <= 27 && !w.windy) {
          score += 2.5;
          why.push([8, `${t}°C and dry. Great time to be outside.`]);
        } else if (act.temp && act.temp[1] <= 5) {
          score += 2;
          why.push([8, `${t}°C. Proper winter weather.`]);
        }
        if (act.clear) { score += 2; why.push([8, 'Clear skies tonight']); }
      }
      if (act.where === 'indoor') {
        if (w.wet) { score += 2; why.push([8, `It's ${describe(w.code).text} out, so something indoors`]); }
        else if (w.temp < 3) { score += 2; why.push([8, `Only ${t}°C. Stay warm inside.`]); }
        else if (w.temp > 32) { score += 2; why.push([8, `${t}°C. Stay cool inside.`]); }
        else if (w.aqi != null && w.aqi > 80) { score += 1.5; why.push([7, 'Air quality is poor today']); }
      }
      if (act.mood === 'cold' && w.temp < 8) { score += 1.5; why.push([6, 'Perfect for a cold day']); }
      if (act.mood === 'wet' && w.wet) { score += 1.5; why.push([6, 'Perfect for a rainy day']); }
    }

    why.push([1, `Fits ${ctx.time === 'night' ? 'a late night' : `the ${ctx.time}`}`]);

    // Don't repeat yourself
    const seen = state.recent.indexOf(act.id);
    if (seen >= 0) score -= Math.max(1, 8 - seen);

    // A little surprise
    score += Math.random() * 2;

    why.sort((a, b) => b[0] - a[0]);
    return { act, score, why: [...new Set(why.map((x) => x[1]))].slice(0, 3) };
  }

  function suggest() {
    const ctx = context();
    let pool = ACTIVITIES.map((a) => evaluate(a, ctx, false)).filter(Boolean);
    if (pool.length < 3) pool = ACTIVITIES.map((a) => evaluate(a, ctx, true)).filter(Boolean);
    pool.sort((a, b) => b.score - a.score);
    const top = pool.slice(0, 4);
    const weights = top.map((x) => Math.exp((x.score - top[0].score) / 1.5));
    let r = Math.random() * weights.reduce((s, x) => s + x, 0);
    for (let i = 0; i < top.length; i++) {
      r -= weights[i];
      if (r <= 0) return top[i];
    }
    return top[0];
  }

  function remember(id) {
    state.recent = [id, ...state.recent.filter((x) => x !== id)].slice(0, 12);
    save();
  }

  function learn(act, liked) {
    const rec = state.learn.acts[act.id] || { like: 0, skip: 0 };
    if (liked) rec.like++; else rec.skip++;
    state.learn.acts[act.id] = rec;
    for (const t of act.tags) {
      state.learn.tags[t] = clamp((state.learn.tags[t] || 0) + (liked ? 0.6 : -0.15), -3, 3);
    }
    save();
  }

  // ---------- Home: the button and the card ----------

  let current = null;

  function mapsUrl(act) {
    const near = state.place?.name ? ` in ${state.place.name}` : ' near me';
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(act.query + near)}`;
  }

  const priceLabel = (p) => (p === 0 ? 'Free' : '€'.repeat(p));
  const durationLabel = (m) => (m < 60 ? `${m} min` : m >= 300 ? 'Most of the day' : `${Math.round(m / 30) / 2} h`);
  const whereLabel = { indoor: 'Indoors', outdoor: 'Outdoors', any: 'Indoors or out' };

  function renderCard(pick) {
    const { act, why } = pick;
    const card = h('article', { class: 'card' },
      h('div', { class: 'card-emoji', 'aria-hidden': 'true' }, act.emoji),
      h('h2', { class: 'card-title' }, act.title),
      h('p', { class: 'card-tip' }, act.tip),
      h('ul', { class: 'card-meta' },
        h('li', null, `⏱ ${durationLabel(act.mins)}`),
        h('li', null, priceLabel(act.price)),
        h('li', null, whereLabel[act.where])),
      h('ul', { class: 'card-why', 'aria-label': 'Why this' }, why.map((w) => h('li', null, w))),
      h('div', { class: 'card-actions' },
        h('button', { class: 'btn primary', type: 'button', onclick: onGo }, act.query ? "👍 Let's go" : '👍 Do it'),
        h('button', { class: 'btn', type: 'button', onclick: onAgain }, '🔄 Something else'),
        h('button', { class: 'btn', type: 'button', onclick: onInvite }, '👥 Invite')),
    );
    $('#stage').replaceChildren(card);
  }

  function renderButton() {
    $('#stage').replaceChildren(bigBtn);
  }

  const SHUFFLE = ACTIVITIES.map((a) => a.emoji);
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  async function spin() {
    const face = bigBtnFace;
    const btn = bigBtn;
    btn.disabled = true;
    btn.classList.add('spinning');
    const weatherReady = refreshWeather();
    if (!reducedMotion) {
      const end = Date.now() + 750;
      while (Date.now() < end) {
        face.textContent = SHUFFLE[Math.floor(Math.random() * SHUFFLE.length)];
        await new Promise((r) => setTimeout(r, 70));
      }
    }
    await weatherReady;
    btn.classList.remove('spinning');
    btn.disabled = false;
    face.replaceChildren('What', h('br'), 'to do?');
    showNext();
  }

  function showNext() {
    current = suggest();
    remember(current.act.id);
    renderCard(current);
  }

  function onGo() {
    learn(current.act, true);
    if (current.act.query) window.open(mapsUrl(current.act), '_blank', 'noopener');
    toast('Have fun! 🎉');
  }

  function onAgain() {
    learn(current.act, false);
    refreshWeather().then(showNext);
  }

  async function onInvite() {
    const p = new URLSearchParams({ likes: state.interests.join(','), idea: current.act.id });
    if (state.name) p.set('from', state.name);
    const url = `${location.origin}${location.pathname}?${p}`;
    const text = `What about ${current.act.emoji} ${current.act.title}? Join me:`;
    try {
      if (navigator.share) {
        await navigator.share({ title: 'What to do?', text, url });
        return;
      }
    } catch (e) {
      if (e && e.name === 'AbortError') return;
    }
    try {
      await navigator.clipboard.writeText(`${text} ${url}`);
      toast('Invite link copied. Send it to a friend.');
    } catch {
      prompt('Copy this invite link:', url);
    }
  }

  function renderFriends() {
    const bar = $('#friendsBar');
    if (!state.friends.length) { bar.hidden = true; return; }
    bar.replaceChildren(
      h('span', null, `👥 With ${joinWords(state.friends.map((f) => f.name))}: ideas you'll all enjoy`),
      h('button', {
        class: 'link', type: 'button',
        onclick: () => { state.friends = []; save(); renderFriends(); toast('Back to solo mode'); },
      }, 'Go solo'),
    );
    bar.hidden = false;
  }

  // ---------- Setup / settings ----------

  function renderSetup() {
    const chips = $('#interestChips');
    chips.replaceChildren(...INTERESTS.map(([id, emoji, text]) => {
      const on = state.interests.includes(id);
      return h('button', {
        type: 'button', class: 'chip', 'aria-pressed': String(on),
        onclick: (e) => {
          const set = new Set(state.interests);
          if (set.has(id)) set.delete(id); else set.add(id);
          state.interests = INTERESTS.map(([i]) => i).filter((i) => set.has(i));
          e.currentTarget.setAttribute('aria-pressed', String(set.has(id)));
          save();
          updateDone();
        },
      }, `${emoji} ${text}`);
    }));
    for (const b of document.querySelectorAll('#budgetSeg button')) {
      b.setAttribute('aria-checked', String(b.dataset.budget === state.budget));
    }
    $('#nameInput').value = state.name;
    $('#placeStatus').textContent = state.place ? `📍 ${state.place.name || 'Your location'}` : 'No location set. Suggestions will ignore the weather.';
    $('#resetBtn').hidden = !Object.keys(state.learn.acts).length;
    updateDone();
  }

  function updateDone() {
    const left = MIN_INTERESTS - state.interests.length;
    const done = $('#doneBtn');
    done.disabled = left > 0;
    done.textContent = left > 0 ? `Pick ${left} more` : 'Done';
  }

  function setPlace(place) {
    state.place = place;
    save();
    weather = null;
    $('#placeStatus').textContent = `📍 ${place.name || 'Your location'}`;
    refreshWeather(true);
  }

  function useGeolocation() {
    const status = $('#placeStatus');
    if (!navigator.geolocation) { status.textContent = 'Location is not available in this browser. Type a city instead.'; return; }
    status.textContent = 'Finding you…';
    navigator.geolocation.getCurrentPosition(async (pos) => {
      const lat = +pos.coords.latitude.toFixed(3);
      const lon = +pos.coords.longitude.toFixed(3);
      let name = '';
      try {
        const r = await fetchJSON(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`);
        name = r.city || r.locality || '';
      } catch { /* the name is only cosmetic */ }
      setPlace({ lat, lon, name });
    }, () => {
      status.textContent = "Couldn't get your location. Type a city instead.";
    }, { timeout: 10000, maximumAge: 30 * 60e3 });
  }

  async function findCity(e) {
    e.preventDefault();
    const q = $('#cityInput').value.trim();
    if (!q) return;
    const status = $('#placeStatus');
    status.textContent = 'Searching…';
    try {
      const r = await fetchJSON(`https://geocoding-api.open-meteo.com/v1/search?count=1&language=en&name=${encodeURIComponent(q)}`);
      const hit = r.results?.[0];
      if (!hit) { status.textContent = `Couldn't find "${q}".`; return; }
      setPlace({ lat: hit.latitude, lon: hit.longitude, name: hit.name });
      $('#cityInput').value = '';
    } catch {
      status.textContent = 'Search failed. Check your connection.';
    }
  }

  // ---------- Views ----------

  function show(view) {
    $('#setup').hidden = view !== 'setup';
    $('#home').hidden = view !== 'home';
    if (view === 'setup') renderSetup();
    if (view === 'home') { renderFriends(); renderButton(); }
  }

  function init() {
    readInvite();
    renderPill();

    bigBtn.addEventListener('click', spin);
    $('#settingsBtn').addEventListener('click', () => show('setup'));
    $('#weatherPill').addEventListener('click', () => show('setup'));
    $('#geoBtn').addEventListener('click', useGeolocation);
    $('#cityForm').addEventListener('submit', findCity);
    $('#nameInput').addEventListener('input', (e) => { state.name = e.target.value.trim().slice(0, 24); save(); });
    $('#budgetSeg').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-budget]');
      if (!b) return;
      state.budget = b.dataset.budget;
      save();
      renderSetup();
    });
    $('#resetBtn').addEventListener('click', () => {
      state.learn = { tags: {}, acts: {} };
      state.recent = [];
      save();
      renderSetup();
      toast('Learning reset');
    });
    $('#doneBtn').addEventListener('click', () => {
      $('#inviteNote').hidden = true;
      show('home');
      if (invitedIdea) {
        const pick = evaluate(invitedIdea, context(), true) || { act: invitedIdea, why: [] };
        invitedIdea = null;
        current = pick;
        remember(pick.act.id);
        renderCard(pick);
      }
    });

    refreshWeather();
    show(state.interests.length >= MIN_INTERESTS && !invitedIdea && $('#inviteNote').hidden ? 'home' : 'setup');
  }

  init();
})();
