(() => {
  const LEVELS = ['N5','N4','N3','N2','N1'];
  const STATES = [
    {id:'mastered',label:'Mastered',desc:'Instant meaning recall',color:'#2f9d69'},
    {id:'solid',label:'Solid',desc:'Know it well',color:'#3e8fbb'},
    {id:'familiar',label:'Familiar',desc:'Recognize it',color:'#547fc0'},
    {id:'hazy',label:'Hazy',desc:'Meaning is shaky',color:'#8f69bf'},
    {id:'partial',label:'Partial',desc:'Know part of it',color:'#d29232'},
    {id:'guessing',label:'Guessing',desc:'Think I know it',color:'#e06d2c'},
    {id:'unknown',label:'Unknown',desc:'No recall',color:'#d83b3b'},
    {id:'sticky',label:'Sticky Trouble',desc:'Keeps slipping',color:'#8f2d42'},
  ];
  const FILTER_STATES = [{id:'new',label:'New',desc:'Not studied yet',color:'#b9b9b5'}, ...STATES];
  const cards = Array.isArray(window.VOCAB_CARDS) ? window.VOCAB_CARDS : [];
  const $ = id => document.getElementById(id);
  const PROGRESS_KEY='vocab-recall-progress-v1';
  const SETTINGS_KEY='vocab-recall-settings-v1';
  const homeView=$('homeView'), studyView=$('studyView'), finishView=$('finishView');

  let progress = loadJSON(PROGRESS_KEY, {});
  let settings = loadJSON(SETTINGS_KEY, {
    levels:['N5'],
    states:['new','solid','familiar','hazy','partial','guessing','unknown','sticky'],
    batch:'20',
    shuffle:true
  });
  settings.levels=(settings.levels||['N5']).filter(x=>LEVELS.includes(x));
  if(!settings.levels.length) settings.levels=['N5'];
  settings.states=(settings.states||['new']).filter(x=>FILTER_STATES.some(s=>s.id===x));
  if(!settings.states.length) settings.states=['new'];
  settings.batch=String(settings.batch||'20');
  settings.shuffle=settings.shuffle!==false;

  let deck=[], index=0, current=null, rated=false;
  let sessionCounts=Object.fromEntries(STATES.map(s=>[s.id,0]));
  let confirmAction=null;

  function loadJSON(key,fallback){ try{return JSON.parse(localStorage.getItem(key)) ?? fallback}catch{return fallback} }
  function saveProgress(){ localStorage.setItem(PROGRESS_KEY,JSON.stringify(progress)); }
  function saveSettings(){ localStorage.setItem(SETTINGS_KEY,JSON.stringify(settings)); }
  function stateFor(card){ return progress[card.id]?.state || 'new'; }
  function cardsForLevels(){ return cards.filter(c=>settings.levels.includes(c.level)); }
  function selectedCards(){ return cardsForLevels().filter(c=>settings.states.includes(stateFor(c))); }
  function shuffle(a){ a=[...a]; for(let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; } return a; }
  function escapeHtml(s){ return String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

  function showView(name){
    [homeView,studyView,finishView].forEach(v=>v.classList.remove('active'));
    if(name==='home'){ homeView.classList.add('active'); renderHome(); }
    if(name==='study'){ studyView.classList.add('active'); }
    if(name==='finish'){ finishView.classList.add('active'); }
    window.scrollTo(0,0);
  }

  function renderLevels(){
    const grid=$('levelGrid'); grid.innerHTML='';
    const counts=Object.fromEntries(LEVELS.map(l=>[l,cards.filter(c=>c.level===l).length]));
    LEVELS.forEach(level=>{
      const selected=settings.levels.includes(level);
      const b=document.createElement('button'); b.className='level-card'+(selected?' selected':'');
      b.innerHTML=`<span class="level-name">${level}</span><span class="level-count">${counts[level].toLocaleString()}</span>`;
      b.onclick=()=>{
        if(selected && settings.levels.length===1) return;
        settings.levels=selected?settings.levels.filter(x=>x!==level):[...settings.levels,level].sort((a,b)=>LEVELS.indexOf(a)-LEVELS.indexOf(b));
        saveSettings(); renderHome();
      };
      grid.appendChild(b);
    });
    $('toggleAllLevels').textContent=settings.levels.length===LEVELS.length?'Clear':'Select all';
  }

  function renderStates(){
    const grid=$('stateGrid'); grid.innerHTML='';
    const pool=cardsForLevels();
    FILTER_STATES.forEach(s=>{
      const selected=settings.states.includes(s.id);
      const count=pool.filter(c=>stateFor(c)===s.id).length;
      const b=document.createElement('button'); b.className=`state-card state-${s.id}`+(selected?' selected':'');
      b.innerHTML=`<span class="state-dot" style="background:${s.color}"></span><span class="state-copy"><b>${s.label}</b><small>${s.desc}</small></span><span class="state-count">${count.toLocaleString()}</span>`;
      b.onclick=()=>{
        if(selected && settings.states.length===1) return;
        settings.states=selected?settings.states.filter(x=>x!==s.id):[...settings.states,s.id];
        saveSettings(); renderHome();
      };
      grid.appendChild(b);
    });
    $('toggleAllStates').textContent=settings.states.length===FILTER_STATES.length?'Clear':'Select all';
  }

  function renderBatch(){
    document.querySelectorAll('[data-batch]').forEach(b=>b.classList.toggle('selected',b.dataset.batch===settings.batch));
    $('shuffleToggle').checked=!!settings.shuffle;
  }

  function renderDeckSummary(){
    const matches=selectedCards(); const n=matches.length;
    const limit=settings.batch==='all'?n:Math.min(Number(settings.batch),n);
    $('startBtn').disabled=!n;
    $('startBtn').textContent=n?`Start ${limit.toLocaleString()} word${limit===1?'':'s'}`:'No words match this filter';
    $('deckSummary').textContent=`${settings.levels.join(' + ')} · ${n.toLocaleString()} matching words`;
  }

  function countState(level,state){ return cards.filter(c=>(!level||c.level===level)&&stateFor(c)===state).length; }
  function renderMemoryMap(){
    $('overallStats').innerHTML=STATES.map(s=>`<div class="stat-box stat-${s.id}"><span class="stat-num">${countState(null,s.id).toLocaleString()}</span><span class="stat-label">${s.label}</span></div>`).join('');
    $('levelStats').innerHTML=LEVELS.map(level=>{
      const levelCards=cards.filter(c=>c.level===level); const total=levelCards.length;
      const stateCounts=Object.fromEntries(STATES.map(s=>[s.id,levelCards.filter(c=>stateFor(c)===s.id).length]));
      const rated=Object.values(stateCounts).reduce((a,b)=>a+b,0); const pct=total?Math.round(rated/total*100):0;
      const bars=STATES.map(s=>`<span class="bar-${s.id}" style="width:${total?stateCounts[s.id]/total*100:0}%"></span>`).join('');
      return `<div class="level-stat"><div class="level-stat-top"><b>${level}</b><span>${rated.toLocaleString()}/${total.toLocaleString()} rated</span></div><div class="memory-bar">${bars}</div><div class="level-stat-bottom"><span>${pct}% mapped</span><span>${total.toLocaleString()} words</span></div></div>`;
    }).join('');
  }

  function renderHome(){ renderLevels(); renderStates(); renderBatch(); renderDeckSummary(); renderMemoryMap(); }

  function startSession(){
    let pool=selectedCards(); if(settings.shuffle) pool=shuffle(pool);
    if(settings.batch!=='all') pool=pool.slice(0,Number(settings.batch));
    if(!pool.length) return;
    deck=pool; index=0; sessionCounts=Object.fromEntries(STATES.map(s=>[s.id,0]));
    showView('study'); renderCard();
  }

  function renderCard(){
    if(index>=deck.length){ finishSession(); return; }
    current=deck[index]; rated=false;
    $('cardLevel').textContent=current.level;
    $('word').textContent=current.word;
    $('reading').textContent=current.reading || current.word;
    $('prompt').classList.remove('hidden'); $('answer').classList.add('hidden'); $('nextBtn').classList.add('hidden');
    $('meanings').innerHTML=(current.meanings||[]).map(x=>`<div>${escapeHtml(x)}</div>`).join('');
    const ex=current.example||null;
    $('exampleBlock').classList.toggle('hidden',!ex);
    $('exampleJa').textContent=ex?.ja||''; $('exampleEn').textContent=ex?.en||'';
    $('studyLevels').textContent=settings.levels.join(' + ');
    $('studyCount').textContent=`${index+1} / ${deck.length}`;
    $('progressFill').style.width=`${index/deck.length*100}%`;
    renderStudyStates(); window.scrollTo(0,0);
  }

  function renderStudyStates(){
    const grid=$('studyStateGrid'); grid.innerHTML='';
    STATES.forEach(s=>{
      const b=document.createElement('button'); b.className='study-state-btn';
      b.innerHTML=`<span class="state-dot" style="background:${s.color}"></span><b>${s.label}</b>`;
      b.onclick=()=>rateCurrent(s.id); grid.appendChild(b);
    });
  }

  function rateCurrent(state){
    if(rated) return; rated=true;
    const prev=progress[current.id]||{};
    progress[current.id]={...prev,state,lastSeen:Date.now(),level:current.level,word:current.word,reading:current.reading};
    saveProgress(); sessionCounts[state]=(sessionCounts[state]||0)+1;
    $('prompt').classList.add('hidden'); $('answer').classList.remove('hidden'); $('studyStateGrid').innerHTML=''; $('nextBtn').classList.remove('hidden');
    setTimeout(()=>$('answer').scrollIntoView({behavior:'smooth',block:'nearest'}),30);
  }

  function finishSession(){
    showView('finish'); const total=Object.values(sessionCounts).reduce((a,b)=>a+b,0);
    $('finishText').textContent=`You mapped ${total.toLocaleString()} vocabulary words.`;
    $('finishStats').innerHTML=STATES.map(s=>`<div class="finish-mini stat-${s.id}"><b>${sessionCounts[s.id]||0}</b>${s.label}</div>`).join('');
  }

  function askLeave(){
    if(!studyView.classList.contains('active')) return false;
    $('confirmBackdrop').classList.remove('hidden'); confirmAction=()=>showView('home'); return true;
  }

  window.handleAndroidBack=()=>{
    if(!$('confirmBackdrop').classList.contains('hidden')){ $('confirmBackdrop').classList.add('hidden'); confirmAction=null; return true; }
    if(studyView.classList.contains('active')) return askLeave();
    if(finishView.classList.contains('active')){ showView('home'); return true; }
    return false;
  };

  $('toggleAllLevels').onclick=()=>{ settings.levels=settings.levels.length===LEVELS.length?['N5']:[...LEVELS]; saveSettings(); renderHome(); };
  $('toggleAllStates').onclick=()=>{ settings.states=settings.states.length===FILTER_STATES.length?['new']:FILTER_STATES.map(s=>s.id); saveSettings(); renderHome(); };
  document.querySelectorAll('[data-batch]').forEach(b=>b.onclick=()=>{settings.batch=b.dataset.batch;saveSettings();renderHome();});
  $('shuffleToggle').onchange=e=>{settings.shuffle=e.target.checked;saveSettings();};
  $('startBtn').onclick=startSession;
  $('nextBtn').onclick=()=>{index++;renderCard();};
  $('finishHome').onclick=()=>showView('home');
  $('resetBtn').onclick=()=>{
    $('confirmTitle').textContent='Reset all vocabulary memory?'; $('confirmText').textContent='This clears all vocabulary ratings on this device.'; $('confirmOk').textContent='Reset';
    confirmAction=()=>{progress={};saveProgress();renderHome();}; $('confirmBackdrop').classList.remove('hidden');
  };
  $('confirmCancel').onclick=()=>{$('confirmBackdrop').classList.add('hidden');confirmAction=null;$('confirmTitle').textContent='Leave this session?';$('confirmText').textContent='Ratings already completed are saved.';$('confirmOk').textContent='Leave';};
  $('confirmOk').onclick=()=>{const fn=confirmAction;$('confirmBackdrop').classList.add('hidden');confirmAction=null;$('confirmTitle').textContent='Leave this session?';$('confirmText').textContent='Ratings already completed are saved.';$('confirmOk').textContent='Leave';if(fn)fn();};

  renderHome();
})();
