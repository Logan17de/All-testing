(() => {
  const LEVELS = ['N5','N4','N3','N2','N1'];
  const MEMORY_STATES = [
    { id: 'unseen', label: 'Not studied', short: 'New', description: 'Never rated yet', icon: '•' },
    { id: 'easy', label: 'Easy', short: 'Easy', description: 'Well known', icon: '✓' },
    { id: 'medium', label: 'Medium', short: 'Medium', description: 'Almost remembering', icon: '≈' },
    { id: 'hard', label: 'Little hard', short: 'Hard', description: 'Seen it, but don’t know', icon: '?' },
    { id: 'none', label: 'No idea', short: 'No idea', description: 'I don’t know what it is', icon: '×' },
  ];
  const cards = Array.isArray(window.KANJI_CARDS) ? window.KANJI_CARDS : [];
  const counts = Object.fromEntries(LEVELS.map(l => [l, cards.filter(c => c.level === l).length]));
  const STORAGE_KEY = 'kanji-recall-progress-v2';
  const LEGACY_STORAGE_KEY = 'kanji-recall-progress-v1';
  const SETTINGS_KEY = 'kanji-recall-settings-v2';
  const LEGACY_SETTINGS_KEY = 'kanji-recall-settings-v1';

  const $ = (id) => document.getElementById(id);
  const homeView = $('homeView');
  const studyView = $('studyView');
  const finishView = $('finishView');
  const backBtn = $('backBtn');
  const headerSub = $('headerSub');

  let progress = loadProgress();
  let settings = loadSettings();
  let deck = [];
  let index = 0;
  let current = null;
  let sessionRatings = { easy: 0, medium: 0, hard: 0, none: 0 };
  let sessionWeakCards = [];
  let ratingRecorded = false;
  let deferredInstallPrompt = null;

  function readJSON(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  }

  function loadProgress() {
    const currentData = readJSON(STORAGE_KEY, null);
    if (currentData) return currentData;
    const legacy = readJSON(LEGACY_STORAGE_KEY, {});
    const migrated = {};
    Object.entries(legacy).forEach(([kanji, item]) => {
      const rating = item?.result === 'known' ? 'easy' : item?.result === 'learning' ? 'hard' : null;
      if (!rating) return;
      migrated[kanji] = { ...item, rating, lastRating: rating };
    });
    if (Object.keys(migrated).length) localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated));
    return migrated;
  }

  function loadSettings() {
    const currentData = readJSON(SETTINGS_KEY, null);
    if (currentData) {
      const levels = currentData.levels?.filter(l => LEVELS.includes(l)) || ['N5'];
      const states = currentData.states?.filter(s => MEMORY_STATES.some(m => m.id === s)) || MEMORY_STATES.map(s => s.id);
      return { levels: levels.length ? levels : ['N5'], states: states.length ? states : ['unseen','medium','hard','none'], shuffle: currentData.shuffle !== false };
    }
    const legacy = readJSON(LEGACY_SETTINGS_KEY, {});
    return {
      levels: legacy.levels?.filter(l => LEVELS.includes(l))?.length ? legacy.levels.filter(l => LEVELS.includes(l)) : ['N5'],
      states: ['unseen','medium','hard','none'],
      shuffle: legacy.shuffle !== false,
    };
  }

  function saveProgress() { localStorage.setItem(STORAGE_KEY, JSON.stringify(progress)); }
  function saveSettings() { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); }
  function ratingFor(card) { return progress[card.kanji]?.rating || progress[card.kanji]?.lastRating || 'unseen'; }
  function stateMeta(id) { return MEMORY_STATES.find(s => s.id === id) || MEMORY_STATES[0]; }

  function showView(name) {
    [homeView, studyView, finishView].forEach(v => v.classList.remove('active'));
    if (name === 'home') {
      homeView.classList.add('active');
      backBtn.classList.add('hidden');
      headerSub.textContent = 'JLPT N5 → N1';
      renderHome();
    } else if (name === 'study') {
      studyView.classList.add('active');
      backBtn.classList.remove('hidden');
      headerSub.textContent = settings.levels.join(' + ');
    } else {
      finishView.classList.add('active');
      backBtn.classList.remove('hidden');
      headerSub.textContent = 'Session complete';
    }
    window.scrollTo({ top: 0, behavior: 'instant' });
  }

  function renderLevelGrid() {
    const grid = $('levelGrid');
    grid.innerHTML = '';
    LEVELS.forEach(level => {
      const selected = settings.levels.includes(level);
      const btn = document.createElement('button');
      btn.className = 'level-card' + (selected ? ' selected' : '');
      btn.setAttribute('aria-pressed', String(selected));
      btn.innerHTML = `<span class="level-name">${level}</span><span class="level-count"><span class="level-dot"></span>${counts[level]} kanji</span>`;
      btn.addEventListener('click', () => {
        settings.levels = selected
          ? settings.levels.filter(l => l !== level)
          : [...settings.levels, level].sort((a, b) => LEVELS.indexOf(a) - LEVELS.indexOf(b));
        saveSettings();
        renderHome();
      });
      grid.appendChild(btn);
    });
    $('toggleAllBtn').textContent = settings.levels.length === LEVELS.length ? 'Clear' : 'Select all';
  }

  function renderStateGrid() {
    const grid = $('stateGrid');
    grid.innerHTML = '';
    MEMORY_STATES.forEach(state => {
      const selected = settings.states.includes(state.id);
      const count = selectedCards().filter(c => ratingFor(c) === state.id).length;
      const btn = document.createElement('button');
      btn.className = `state-card state-${state.id}` + (selected ? ' selected' : '');
      btn.setAttribute('aria-pressed', String(selected));
      btn.innerHTML = `
        <span class="state-icon">${state.icon}</span>
        <span class="state-copy"><b>${state.label}</b><small>${state.description}</small></span>
        <span class="state-count">${count}</span>`;
      btn.addEventListener('click', () => {
        settings.states = selected ? settings.states.filter(s => s !== state.id) : [...settings.states, state.id];
        saveSettings();
        renderHome();
      });
      grid.appendChild(btn);
    });
    $('toggleAllStatesBtn').textContent = settings.states.length === MEMORY_STATES.length ? 'Clear' : 'Select all';
  }

  function selectedCards() { return cards.filter(c => settings.levels.includes(c.level)); }
  function cardsForSelection() { return selectedCards().filter(c => settings.states.includes(ratingFor(c))); }

  function renderDeckSummary() {
    const matching = cardsForSelection();
    const start = $('startBtn');
    const levelsText = settings.levels.length ? settings.levels.join(' + ') : 'No levels';
    const stateText = settings.states.length === MEMORY_STATES.length
      ? 'all memory states'
      : settings.states.map(id => stateMeta(id).label).join(' + ') || 'no memory states';
    start.disabled = !settings.levels.length || !settings.states.length || !matching.length;
    start.textContent = matching.length ? `Study ${matching.length.toLocaleString()} cards` : 'No cards match this filter';
    $('deckSummary').textContent = `${levelsText} • ${stateText} • ${matching.length.toLocaleString()} cards`;
  }

  function countState(stateId, level = null) {
    return cards.filter(c => (!level || c.level === level) && ratingFor(c) === stateId).length;
  }

  function renderProgress() {
    const totalRated = cards.filter(c => ratingFor(c) !== 'unseen').length;
    $('overallStats').innerHTML = MEMORY_STATES.slice(1).map(state => `
      <div class="stat-box stat-${state.id}">
        <span class="stat-num">${countState(state.id)}</span>
        <span class="stat-label">${state.label}</span>
      </div>`).join('') + `
      <div class="stat-box stat-seen"><span class="stat-num">${totalRated}</span><span class="stat-label">Rated</span></div>`;

    $('levelStats').innerHTML = LEVELS.map(level => {
      const levelCards = cards.filter(c => c.level === level);
      const easy = countState('easy', level);
      const medium = countState('medium', level);
      const hard = countState('hard', level);
      const none = countState('none', level);
      const rated = easy + medium + hard + none;
      const pct = levelCards.length ? Math.round(rated / levelCards.length * 100) : 0;
      return `<div class="level-stat-row">
        <div class="level-stat-top"><b>${level}</b><span>${rated}/${levelCards.length} rated</span></div>
        <div class="memory-bar" aria-label="${level} memory distribution">
          <span class="bar-easy" style="width:${levelCards.length ? easy / levelCards.length * 100 : 0}%"></span>
          <span class="bar-medium" style="width:${levelCards.length ? medium / levelCards.length * 100 : 0}%"></span>
          <span class="bar-hard" style="width:${levelCards.length ? hard / levelCards.length * 100 : 0}%"></span>
          <span class="bar-none" style="width:${levelCards.length ? none / levelCards.length * 100 : 0}%"></span>
        </div>
        <div class="level-stat-bottom"><span>${pct}% mapped</span><span>✓ ${easy} · ≈ ${medium} · ? ${hard} · × ${none}</span></div>
      </div>`;
    }).join('');
  }

  function renderHome() {
    renderLevelGrid();
    renderStateGrid();
    $('shuffleToggle').checked = !!settings.shuffle;
    renderDeckSummary();
    renderProgress();
  }

  function shuffleArray(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function startSession(customDeck = null) {
    let base = customDeck ? [...customDeck] : cardsForSelection();
    if (!base.length) return;
    if (!customDeck && settings.shuffle) base = shuffleArray(base);
    deck = base;
    index = 0;
    sessionRatings = { easy: 0, medium: 0, hard: 0, none: 0 };
    sessionWeakCards = [];
    showView('study');
    renderCard();
  }

  function renderCard() {
    if (index >= deck.length) return finishSession();
    current = deck[index];
    ratingRecorded = false;
    $('flashcard').classList.remove('revealed');
    $('reveal').classList.add('hidden');
    $('ratingActions').classList.remove('hidden');
    $('nextBtn').classList.add('hidden');
    $('kanji').textContent = current.kanji;
    $('cardLevel').textContent = current.level;
    $('meaning').textContent = current.meaning;
    $('breakdown').textContent = current.breakdown;
    $('memory').textContent = current.memory;
    $('logic').textContent = current.logic;
    $('exampleWord').textContent = current.word;
    $('exampleReading').textContent = current.reading;
    $('exampleMeaning').textContent = current.wordMeaning;
    $('sessionLevels').textContent = settings.levels.join(' + ');
    $('sessionCount').textContent = `${index + 1} / ${deck.length}`;
    $('sessionProgress').style.width = `${(index / deck.length) * 100}%`;

    const oldState = ratingFor(current);
    const badge = $('currentStateBadge');
    if (oldState === 'unseen') {
      badge.classList.add('hidden');
    } else {
      badge.className = `current-state-badge badge-${oldState}`;
      badge.textContent = `Last: ${stateMeta(oldState).label}`;
    }
    window.scrollTo({ top: 0, behavior: 'instant' });
  }

  function recordRating(rating) {
    const prev = progress[current.kanji] || { seen: 0, counts: {} };
    const countsByRating = { ...(prev.counts || {}) };
    countsByRating[rating] = (countsByRating[rating] || 0) + 1;
    progress[current.kanji] = {
      ...prev,
      rating,
      lastRating: rating,
      seen: (prev.seen || 0) + 1,
      counts: countsByRating,
      lastSeen: Date.now(),
      level: current.level,
    };
    saveProgress();
    sessionRatings[rating]++;
    if (rating === 'hard' || rating === 'none') sessionWeakCards.push(current);
  }

  function rateCard(rating) {
    if (ratingRecorded) return;
    ratingRecorded = true;
    recordRating(rating);
    if (rating === 'easy') {
      index++;
      renderCard();
      return;
    }
    $('flashcard').classList.add('revealed');
    $('reveal').classList.remove('hidden');
    $('ratingActions').classList.add('hidden');
    $('nextBtn').classList.remove('hidden');
    $('nextBtn').textContent = rating === 'medium' ? 'Got it — next card →' : 'Study it — next card →';
    setTimeout(() => $('reveal').scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 80);
  }

  function nextAfterReveal() { index++; renderCard(); }

  function finishSession() {
    $('sessionProgress').style.width = '100%';
    showView('finish');
    const total = Object.values(sessionRatings).reduce((a, b) => a + b, 0);
    $('finishMessage').textContent = `You rated ${total.toLocaleString()} kanji from ${settings.levels.join(' + ')}.`;
    $('finishStats').innerHTML = MEMORY_STATES.slice(1).map(state => `
      <div class="finish-stat finish-${state.id}"><strong>${sessionRatings[state.id]}</strong><span>${state.label}</span></div>`).join('');
    $('studyWeakBtn').classList.toggle('hidden', sessionWeakCards.length === 0);
    $('studyWeakBtn').textContent = sessionWeakCards.length
      ? `Practice ${sessionWeakCards.length} Little hard + No idea`
      : 'No weak cards in this session 🎉';
  }

  $('toggleAllBtn').addEventListener('click', () => {
    settings.levels = settings.levels.length === LEVELS.length ? [] : [...LEVELS];
    saveSettings(); renderHome();
  });

  $('toggleAllStatesBtn').addEventListener('click', () => {
    settings.states = settings.states.length === MEMORY_STATES.length ? [] : MEMORY_STATES.map(s => s.id);
    saveSettings(); renderHome();
  });

  $('shuffleToggle').addEventListener('change', e => {
    settings.shuffle = e.target.checked;
    saveSettings(); renderDeckSummary();
  });

  $('startBtn').addEventListener('click', () => startSession());
  document.querySelectorAll('[data-rating]').forEach(btn => btn.addEventListener('click', () => rateCard(btn.dataset.rating)));
  $('nextBtn').addEventListener('click', nextAfterReveal);
  $('finishHomeBtn').addEventListener('click', () => showView('home'));
  $('studyWeakBtn').addEventListener('click', () => startSession(settings.shuffle ? shuffleArray(sessionWeakCards) : sessionWeakCards));

  backBtn.addEventListener('click', () => {
    if (studyView.classList.contains('active') && index > 0 && !confirm('Leave this study session? Your ratings are already saved.')) return;
    showView('home');
  });

  $('resetBtn').addEventListener('click', () => {
    if (!confirm('Reset all Easy / Medium / Little hard / No idea ratings on this device?')) return;
    progress = {};
    saveProgress();
    renderHome();
  });

  const isNativeAndroid = /KanjiRecallNative/.test(navigator.userAgent);
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  if (isStandalone || isNativeAndroid) $('installBtn').classList.add('hidden');

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
  });

  function openInstallSheet() {
    if (isIOS && !deferredInstallPrompt) {
      $('installHelp').innerHTML = 'On iPhone/iPad: tap <b>Share</b> in Safari, then choose <b>Add to Home Screen</b>.';
      $('installActionBtn').classList.add('hidden');
    } else {
      $('installHelp').textContent = 'Install it to your home screen for a full-screen, offline flashcard app.';
      $('installActionBtn').classList.remove('hidden');
    }
    $('installSheet').classList.remove('hidden');
  }

  $('installBtn').addEventListener('click', openInstallSheet);
  $('closeInstallBtn').addEventListener('click', () => $('installSheet').classList.add('hidden'));
  $('installSheet').addEventListener('click', e => { if (e.target === $('installSheet')) $('installSheet').classList.add('hidden'); });
  $('installActionBtn').addEventListener('click', async () => {
    if (!deferredInstallPrompt) {
      $('installHelp').textContent = 'Open your browser menu and choose “Install app” or “Add to Home screen”.';
      return;
    }
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    $('installSheet').classList.add('hidden');
  });

  if (!isNativeAndroid && 'serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
  }

  renderHome();
})();
