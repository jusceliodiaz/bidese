const stage       = document.getElementById('stage');
const mainVideo   = document.getElementById('main-video');
const seqCanvas   = document.getElementById('seq-canvas');
const poiLayer    = document.getElementById('poi-layer');
const trackEl     = document.getElementById('track');
const loaderEl    = document.getElementById('loader');
const debugHud    = document.getElementById('debug-hud');
const debugCoords = document.getElementById('debug-coords');

// alpha:false — cheaper GPU compositing; no transparency needed on the canvas
const ctx = seqCanvas.getContext('2d', { alpha: false });

// Touch/mobile detection — covers iOS, Android and stylus-only devices
const MOBILE = window.matchMedia('(hover: none)').matches || window.innerWidth < 768;

// LRU cap: max number of decoded sequences held in memory at once
const MAX_SEQ = 3;
let _w = innerWidth, _h = innerHeight, lastFrame = null;

const LEAD = {
  whatsapp:      "5541988163938",
  project:       "Bidesse",
  endpoint:      "/api/leads",
};

let currentScene = 'aerial';
let busy         = false;
let navGen       = 0;
let poiTimer     = null;
let tourTimer    = null;
let touring      = false;
let mode         = "day"; // reserved for day/night toggle
const cache      = new Map();
const videoBlobs = new Map();

// ─── Drag-swipe (navegação por arrasto entre cenas) ──────────────────────────
// Parallax de mouse removido: desalinhava o overlay de andares (imgToScreen()
// assume o canvas/vídeo renderizados sem transform).

const SWIPE_MIN_PX   = 32;    // distância mínima de arrasto para trocar de cena
const DRAG_DIR       = -1;    // 1 | -1 → sentido do swipe

let swiping = false, swipeStartX = 0, swipeFired = false;

function trySwipeNav(clientX) {
  if (swipeFired || busy) return;
  const dx = (clientX - swipeStartX) * DRAG_DIR;
  if (Math.abs(dx) < SWIPE_MIN_PX) return;
  const ids = CONFIG.timeline.map(t => t.id);
  const idx = ids.indexOf(currentScene);
  const nextIdx = dx < 0 ? idx + 1 : idx - 1;
  if (nextIdx < 0 || nextIdx >= ids.length) return;
  swipeFired = true;
  navigateTo(ids[nextIdx]);
}

stage.addEventListener('pointerdown', e => {
  if (e.target.closest('.poi')) return;
  swiping = true;
  swipeFired = false;
  swipeStartX = e.clientX;
  stage.setPointerCapture(e.pointerId);
  stage.classList.add('dragging');
});

stage.addEventListener('pointermove', e => {
  if (!swiping) return;
  trySwipeNav(e.clientX);
});

const endSwipe = e => {
  if (!swiping) return;
  swiping = false;
  stage.classList.remove('dragging');
  trySwipeNav(e.clientX);
};
stage.addEventListener('pointerup', endSwipe);
stage.addEventListener('pointercancel', endSwipe);

// ─── Analytics ───────────────────────────────────────────────────────────────

function sessionId() {
  let s = sessionStorage.getItem('sid');
  if (!s) { s = crypto.randomUUID(); sessionStorage.setItem('sid', s); }
  return s;
}

function track(event, props = {}) {
  const payload = {
    event, ...props,
    slug:    CONFIG?.slug,
    ts:      Date.now(),
    session: sessionId(),
    device:  MOBILE ? 'mobile' : 'desktop',
  };
  if (window.gtag) gtag('event', event, props);
  try { navigator.sendBeacon?.('/api/track', JSON.stringify(payload)); } catch(_) {}
}

let dwellStart = Date.now();
let dwellScene = 'aerial';

function markDwell(newScene) {
  track('dwell', { scene: dwellScene, ms: Date.now() - dwellStart });
  dwellScene = newScene;
  dwellStart = Date.now();
}

window.addEventListener('pagehide', () => markDwell(dwellScene));

// ─── Init ─────────────────────────────────────────────────────────────────────

window.addEventListener('load', () => {
  resizeCanvas();
  buildTrack();
  const initial = sceneFromHash();
  startScene(initial);
  // Kick off preload for the second scene's neighbors so the second transition is also instant
  const ids = CONFIG.timeline.map(t => t.id);
  const idx = ids.indexOf(initial);
  const next = ids[idx + 1];
  if (next) Object.values(CONFIG.transitions[next] || {}).filter(Boolean).forEach(id => preload(id));
  initCTA();
  initPoiCard();
  initBotPopup();
  initDayNight();
});

// Smart resize: ignores address-bar height jitter on mobile (< 120px height delta)
window.addEventListener('resize', () => {
  if (innerWidth === _w && Math.abs(innerHeight - _h) < 120) return;
  _w = innerWidth; _h = innerHeight;
  resizeCanvas();
  if (lastFrame) drawCover(lastFrame);
});

function resizeCanvas() {
  const dpr = MOBILE ? 1 : Math.min(window.devicePixelRatio || 1, 2);
  seqCanvas.width        = innerWidth  * dpr;
  seqCanvas.height       = innerHeight * dpr;
  seqCanvas.style.width  = innerWidth  + 'px';
  seqCanvas.style.height = innerHeight + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

// ─── Deep link ────────────────────────────────────────────────────────────────

function sceneFromHash() {
  const id = new URLSearchParams(location.hash.slice(1)).get('scene');
  return CONFIG.scenes[id] ? id : 'aerial';
}

function syncHash(sceneId) {
  history.replaceState(null, '', `#scene=${sceneId}`);
}

// ─── Video source ─────────────────────────────────────────────────────────────

function videoSrc(scene) {
  let v = scene.video;
  if (v && (v.day || v.night)) v = v[mode] || v.day;
  if (!v) return null;
  if (typeof v === 'string') return v;
  const safari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
  return (MOBILE || safari) ? (v.mp4 || v.webm) : (v.webm || v.mp4);
}

// ─── Video preload ────────────────────────────────────────────────────────────

const loadOne = (src) => {
  if (!src || videoBlobs.has(src)) return Promise.resolve();
  return fetch(src)
    .then(r => r.blob())
    .then(blob => { videoBlobs.set(src, URL.createObjectURL(blob)); })
    .catch(() => {});
};

function preloadNeighbors(sceneId) {
  const want = new Set([videoSrc(CONFIG.scenes[sceneId])]);
  Object.keys(CONFIG.transitions[sceneId] || {})
    .forEach(d => want.add(videoSrc(CONFIG.scenes[d])));
  [...want].filter(Boolean).forEach(loadOne);
}

function preloadAllVideos() {
  const srcs = [...new Set(
    Object.values(CONFIG.scenes).map(s => videoSrc(s)).filter(Boolean)
  )];
  const firstSrc = videoSrc(CONFIG.scenes['aerial']);
  const rest = srcs.filter(s => s !== firstSrc);
  const chain = firstSrc ? loadOne(firstSrc) : Promise.resolve();
  chain.then(() => Promise.all(rest.map(loadOne)));
}

// ─── Poster ───────────────────────────────────────────────────────────────────

function showPoster(src, cb) {
  seqCanvas.classList.add('active');
  const img = new Image();
  img.onload  = () => { drawCover(img); cb?.(); };
  img.onerror = () => cb?.();
  img.src = src;
}

// ─── Scene ────────────────────────────────────────────────────────────────────

function startScene(sceneId) {
  const scene = CONFIG.scenes[sceneId];
  if (!scene) return;

  markDwell(sceneId);
  currentScene = sceneId;
  setActive(sceneId);
  syncHash(sceneId);
  renderPOIs(scene.pois);

  // Always preload adjacent sequences in the background, regardless of scene type
  Object.values(CONFIG.transitions[sceneId] || {}).filter(Boolean).forEach(id => preload(id));

  // Cover image mode — draw to canvas and keep it visible
  if (scene.cover) {
    showPoster(MOBILE && scene.cover_m ? scene.cover_m : scene.cover);
    return;
  }

  // Video mode (fallback)

  const src = videoSrc(scene);
  if (!src) { seqCanvas.classList.remove('active'); return; }

  const gen = navGen;
  mainVideo.src  = videoBlobs.get(src) || src;
  mainVideo.loop = true;
  mainVideo.load();

  const onReady = () => {
    if (gen !== navGen) return;
    let faded = false;
    const doFade = () => {
      if (faded || gen !== navGen) return;
      faded = true;
      fadeCanvas();
    };
    mainVideo.addEventListener('playing',    doFade, { once: true });
    mainVideo.addEventListener('timeupdate', doFade, { once: true });
    mainVideo.play().catch(doFade);
    setTimeout(doFade, 500);
  };

  if (mainVideo.readyState >= 3) {
    onReady();
  } else {
    const evt = MOBILE ? 'loadeddata' : 'canplay';
    mainVideo.addEventListener(evt, onReady, { once: true });
    setTimeout(onReady, MOBILE ? 3000 : 5000);
  }
}

function fadeCanvas() {
  seqCanvas.style.transition = 'opacity 300ms ease';
  seqCanvas.style.opacity    = '0';
  setTimeout(() => {
    seqCanvas.classList.remove('active');
    seqCanvas.style.opacity    = '';
    seqCanvas.style.transition = '';
  }, 300);
}

// ─── Navigation ───────────────────────────────────────────────────────────────

async function navigateTo(targetId) {
  if (busy || targetId === currentScene) return;

  // Build path: direct transition or chain through timeline
  const ids      = CONFIG.timeline.map(t => t.id);
  const fromIdx  = ids.indexOf(currentScene);
  const toIdx    = ids.indexOf(targetId);
  const direct   = CONFIG.transitions?.[currentScene]?.[targetId];

  let path;
  if (direct) {
    path = [currentScene, targetId];
  } else if (fromIdx !== -1 && toIdx !== -1) {
    const step = fromIdx < toIdx ? 1 : -1;
    path = [];
    for (let i = fromIdx; step > 0 ? i <= toIdx : i >= toIdx; i += step) path.push(ids[i]);
  } else {
    return;
  }

  busy = true;
  const gen = ++navGen;

  try {
    hidePOIs();
    // Overlays da Vista 1 (andares + barra dia/noite) somem na hora ao sair
    // dela, sem esperar a sequência de transição terminar
    if (typeof setFloorOverlayVisible === 'function') setFloorOverlayVisible(false);
    setDayNightVisible(false);
    for (let i = 0; i < path.length - 1; i++) {
      const seqId = CONFIG.transitions?.[path[i]]?.[path[i + 1]];
      if (!seqId) { startScene(path[i + 1]); continue; }

      const frames = await loadWithLoader(seqId);
      if (gen !== navGen) return;

      const seq = CONFIG.sequences[seqId];
      const fps = (seq.fps || 30) / (MOBILE ? 2 : 1);
      await playSequence(frames, seq.reverse === true, gen, fps);
      if (gen !== navGen) return;

      startScene(path[i + 1]);
    }
  } catch (err) {
    if (gen === navGen) {
      console.error('Sequence error:', err);
      seqCanvas.classList.remove('active');
    }
  } finally {
    if (gen === navGen) {
      setTimeout(() => { if (gen === navGen) busy = false; }, 350);
    }
  }
}

function loadWithLoader(seqId) {
  const p     = preload(seqId);
  const timer = setTimeout(() => loaderEl.classList.add('visible'), 400);
  return p.finally(() => { clearTimeout(timer); loaderEl.classList.remove('visible'); });
}

// ─── Preloading (LRU + img.decode) ────────────────────────────────────────────

function rememberSeq(seqId, promise) {
  cache.set(seqId, promise);
  // Evict the oldest entry when over the LRU cap
  if (cache.size > MAX_SEQ) {
    const oldest = cache.keys().next().value;
    if (oldest !== seqId) cache.delete(oldest);
  }
}

function preload(seqId) {
  if (cache.has(seqId)) return cache.get(seqId);

  // Mobile resolution is handled per-frame below via seq.folder_m
  const seq = CONFIG.sequences[seqId];

  const step    = MOBILE ? 2 : 1; // skip every other frame on mobile
  const indices = [];
  for (let i = seq.from; i <= seq.to; i += step) indices.push(i);

  const frames  = new Array(indices.length);
  let loaded    = 0;
  let failed    = false;
  // 8 concurrent on mobile balances speed vs connection saturation; desktop loads all at once
  const SLOTS   = MOBILE ? 8 : indices.length;
  let nextLoad  = 0;

  const promise = new Promise((resolve, reject) => {
    const loadNext = () => {
      if (nextLoad >= indices.length) return;
      const slot = nextLoad++;
      const num  = String(indices[slot]).padStart(seq.pad, '0');
      const img  = new Image();
      const folder = MOBILE && seq.folder_m ? seq.folder_m : seq.folder;
      img.src = `${folder}${seq.prefix}${num}.${seq.ext}`;

      img.onload = () => {
        // Pre-decode eliminates stutter on the first drawImage call
        const ready = img.decode ? img.decode().catch(() => {}) : Promise.resolve();
        ready.then(() => {
          frames[slot] = img;
          loadNext();
          if (++loaded === indices.length) resolve(frames);
        });
      };
      img.onerror = () => {
        if (!failed) { failed = true; cache.delete(seqId); reject(new Error(`Failed to load: ${img.src}`)); }
      };
    };
    for (let k = 0; k < Math.min(SLOTS, indices.length); k++) loadNext();
  });

  rememberSeq(seqId, promise);
  return promise;
}

// ─── Playback (real-time throttle, handles 120Hz ProMotion) ───────────────────

function playSequence(frames, reverse = false, gen, fps = 30) {
  return new Promise(resolve => {
    seqCanvas.classList.add('active');
    let index = reverse ? frames.length - 1 : 0;
    let last  = 0;
    const step = 1000 / fps;

    const dir = reverse ? -1 : 1;

    function loop(now) {
      if (gen !== navGen) return resolve();
      if (last === 0) last = now;
      // Consume all elapsed frames in one tick so playback honors fps on any refresh rate
      while (now - last >= step) {
        last += step;
        index += dir;
        if (reverse ? index < 0 : index >= frames.length) {
          if (frames[reverse ? 0 : frames.length - 1]) drawCover(frames[reverse ? 0 : frames.length - 1]);
          return resolve();
        }
      }
      if (frames[index]) drawCover(frames[index]);
      requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);
  });
}

function drawCover(img) {
  const cw    = innerWidth;
  const ch    = innerHeight;
  const scale = Math.max(cw / img.naturalWidth, ch / img.naturalHeight);
  const dw    = Math.round(img.naturalWidth  * scale);
  const dh    = Math.round(img.naturalHeight * scale);
  const dx    = Math.round((cw - dw) / 2);
  const dy    = Math.round((ch - dh) / 2);
  // Sem clearRect: o cover-fit acima sempre preenche o canvas inteiro, e o
  // clear+draw em sequência causa flicker de double-buffering no Chrome
  // (o compositor chega a apresentar o frame limpo por um instante).
  ctx.drawImage(img, dx, dy, dw, dh);
  lastFrame = img;
}

// ─── Barra dia/noite (Vista 1) ──────────────────────────────────────────────
// Escrubbing: arrasta o handle e o frame correspondente da sequência
// "aerial-daynight" é desenhado direto, sem autoplay por fps.

let dnFrames = null;
let dnLoading = null;
let dnDragging = false;
let dnT = 0; // 0 = dia (COVER_B1), 1 = noite
let dnDayFrame = null; // COVER_B1 pré-carregado — t=0 sempre mostra ele, não noite_00

(function preloadDnDayFrame() {
  const img = new Image();
  img.onload = () => { dnDayFrame = img; };
  img.src = 'images/bidesse/COVER_B1.jpg';
})();

function setDayNightVisible(visible) {
  const el = document.getElementById('dn-slider');
  if (!el) return;
  el.classList.toggle('show', visible);
  if (visible) {
    dnEnsureFrames(); // preload em background pra já estar pronto no 1º arrasto
  } else if (dnT !== 0) {
    // volta pro dia ao sair da Vista 1, pra não "vazar" a noite pras outras cenas.
    // Só reseta o estado visual do handle — NÃO chama dnRender()/drawCover()
    // aqui: estamos saindo da cena, quem chamou isso (navigateTo) já cuida
    // de esconder o overlay e desenhar a cena seguinte.
    dnT = 0;
    const handle = document.getElementById('dn-handle');
    const track  = document.getElementById('dn-track');
    if (handle) handle.style.left = '0%';
    if (track) track.style.setProperty('--dn-t', '0%');
  }
}

// Overlay dos andares só faz sentido em cima do cover de dia (t=0) — some
// na hora ao mexer no slider, volta na hora ao soltar exatamente no dia.
function dnSyncFloorOverlay() {
  if (typeof setFloorOverlayVisible !== 'function') return;
  const svg = document.getElementById('floor-svg');
  const allow = typeof floorOverlayAllowed === 'function' ? floorOverlayAllowed() : true;
  const shouldShow = dnT === 0 && allow;
  const isShown = !!(svg && svg.classList.contains('visible'));
  if (shouldShow !== isShown) setFloorOverlayVisible(shouldShow);
}

function dnRender() {
  const handle = document.getElementById('dn-handle');
  const track  = document.getElementById('dn-track');
  if (handle) handle.style.left = (dnT * 100).toFixed(2) + '%';
  if (track) track.style.setProperty('--dn-t', (dnT * 100).toFixed(2) + '%');
  dnSyncFloorOverlay();
  if (dnT === 0) {
    if (dnDayFrame || lastFrame) drawCover(dnDayFrame || lastFrame);
    return;
  }
  if (dnFrames && dnFrames.length) {
    const idx = Math.round(dnT * (dnFrames.length - 1));
    if (dnFrames[idx]) drawCover(dnFrames[idx]);
  }
}

function dnEnsureFrames() {
  if (dnFrames || dnLoading) return dnLoading;
  dnLoading = preload('aerial-daynight').then(frames => {
    dnFrames = frames;
    dnRender();
  }).catch(() => {});
  return dnLoading;
}

// dnSetFromClientX só agenda o cálculo pro próximo frame (rAF) — evita
// recalcular/redesenhar o canvas a cada pointermove (dispara dezenas de
// vezes por segundo e travava o arraste).
let dnPendingClientX = null;
let dnRafPending = false;

function dnSetFromClientX(clientX) {
  dnPendingClientX = clientX;
  if (dnRafPending) return;
  dnRafPending = true;
  requestAnimationFrame(dnFlush);
}

function dnFlush() {
  dnRafPending = false;
  if (dnPendingClientX == null) return;
  const track = document.getElementById('dn-track');
  if (!track) return;
  const r = track.getBoundingClientRect();
  dnT = Math.max(0, Math.min(1, (dnPendingClientX - r.left) / r.width));
  dnRender();
}

function initDayNight() {
  const el = document.getElementById('dn-slider');
  if (!el) return;

  el.addEventListener('pointerdown', e => {
    e.stopPropagation();
    dnDragging = true;
    el.setPointerCapture(e.pointerId);
    dnEnsureFrames();
    dnSetFromClientX(e.clientX);
  });
  el.addEventListener('pointermove', e => {
    if (!dnDragging) return;
    e.stopPropagation();
    dnSetFromClientX(e.clientX);
  });
  const endDrag = e => {
    if (!dnDragging) return;
    dnDragging = false;
    e.stopPropagation();
  };
  el.addEventListener('pointerup', endDrag);
  el.addEventListener('pointercancel', endDrag);
}

// ─── POIs ─────────────────────────────────────────────────────────────────────

const SVG_CAR_POI  = `<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M18.92 6C18.72 5.42 18.16 5 17.5 5h-11c-.66 0-1.21.42-1.42 1L3 12v8c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-1h12v1c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-8l-2.08-6zM6.5 16c-.83 0-1.5-.67-1.5-1.5S5.67 13 6.5 13s1.5.67 1.5 1.5S7.33 16 6.5 16zm11 0c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zM5 11l1.5-4.5h11L19 11H5z"/></svg>`;
const SVG_WALK_POI = `<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M13.5 5.5c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm-3.6 13.9l1-4.4 2.1 2v6h2v-7.5l-2.1-2 .6-3c1.3 1.5 3.3 2.5 5.5 2.5v-2c-1.9 0-3.5-1-4.3-2.4l-1-1.6c-.4-.6-1-1-1.7-1-.3 0-.5.1-.8.1L7.3 6.8v4.7h2V8.1l1.8-.7-1.6 8.1-4.9-1-.4 2 7 1.4z"/></svg>`;
const SVG_GLOBE    = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>`;

let poiCardEl = null;

function initPoiCard() {
  poiCardEl = document.getElementById('poi-card');
  if (!poiCardEl) return;
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closePoiCard(); });
}

function showPoiCard(poi, dotEl) {
  if (!poiCardEl) return;
  track('poi_card_open', { scene: currentScene, label: poi.label });

  const catText = poi.subcategory ? `${poi.category} · ${poi.subcategory}` : poi.category;

  if (poi.type === 'card-simple') {
    poiCardEl.className = 'poi-card--simple';
    poiCardEl.innerHTML = `
      <button class="poi-card-close" aria-label="Fechar">
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="1" y1="1" x2="9" y2="9"/><line x1="9" y1="1" x2="1" y2="9"/></svg>
      </button>
      <div class="poi-card-body">
        ${poi.accent ? `<div class="poi-card-dot" style="background:${poi.accent}"></div>` : ''}
        <div class="poi-card-cat">${catText}</div>
        <div class="poi-card-title">${poi.title}</div>
        <p class="poi-card-desc">${poi.description}</p>
        ${(poi.car != null || poi.walk != null) ? `
        <div class="poi-card-times">
          ${poi.car  != null ? `<span>${SVG_CAR_POI}  ${poi.car} min</span>` : ''}
          ${poi.walk != null ? `<span>${SVG_WALK_POI} ${poi.walk} min</span>` : ''}
        </div>` : ''}
      </div>`;
  } else if (poi.type === 'card-complex') {
    poiCardEl.className = 'poi-card--complex';
    poiCardEl.innerHTML = `
      <button class="poi-card-close" aria-label="Fechar">
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="1" y1="1" x2="9" y2="9"/><line x1="9" y1="1" x2="1" y2="9"/></svg>
      </button>
      ${poi.image ? `<img class="poi-card-img" src="${poi.image}" alt="${poi.title}" loading="lazy">` : ''}
      <div class="poi-card-body">
        <div class="poi-card-cat">${catText}</div>
        <div class="poi-card-title">${poi.title}</div>
        <p class="poi-card-desc">${poi.description}</p>
        ${poi.pano360 ? `<button class="poi-card-360" onclick="openPanoModal('${poi.pano360}','${poi.title}')">${SVG_GLOBE} VIEW 360°</button>` : ''}
      </div>`;
  }

  poiCardEl.querySelector('.poi-card-close').addEventListener('click', closePoiCard);

  // Positioning: appear near the dot, clamped to viewport
  const rect = dotEl.getBoundingClientRect();
  const cardW = MOBILE ? window.innerWidth - 32 : 280;
  const cardH = poi.type === 'card-complex' ? 380 : 260;
  const margin = 16;

  let left = rect.left + rect.width / 2 - cardW / 2;
  let top  = rect.top - cardH - 14;

  // If not enough space above, put below
  if (top < margin) top = rect.bottom + 14;
  // Clamp horizontally
  left = Math.max(margin, Math.min(left, window.innerWidth - cardW - margin));
  // Clamp vertically
  top  = Math.max(margin + 80, Math.min(top, window.innerHeight - cardH - margin));

  poiCardEl.style.left   = left + 'px';
  poiCardEl.style.top    = top + 'px';
  poiCardEl.style.width  = cardW + 'px';

  requestAnimationFrame(() => poiCardEl.classList.add('open'));
}

function closePoiCard() {
  if (!poiCardEl) return;
  poiCardEl.classList.remove('open');
}

function renderPOIs(pois = []) {
  poiLayer.innerHTML = '';
  closePoiCard();
  pois.forEach((poi, i) => {
    const el = document.createElement('div');
    el.className = 'poi';
    el.style.left = poi.x + '%';
    el.style.top  = poi.y + '%';
    el.style.animationDelay = (i * 80) + 'ms';
    el.innerHTML = `<div class="poi-btn"></div>
                    <div class="poi-name">${poi.label}</div>`;

    const dotEl = el.querySelector('.poi-btn');

    const act = () => {
      if (poi.type === 'card-simple' || poi.type === 'card-complex') {
        showPoiCard(poi, dotEl);
      } else if (poi.type === 'nav' && poi.target) {
        track('poi_nav', { from: currentScene, to: poi.target });
        navigateTo(poi.target);
      } else if (poi.type === 'info' && poi.info) {
        track('poi_info', { scene: currentScene, label: poi.label });
        openInfo(poi.info);
      } else if (poi.target) {
        navigateTo(poi.target);
      }
    };

    el.addEventListener('click', act);
    el.addEventListener('touchstart', e => { e.preventDefault(); act(); }, { passive: false });
    poiLayer.appendChild(el);
  });
}

function hidePOIs() {
  clearTimeout(poiTimer);
  poiLayer.classList.add('out');
  poiTimer = setTimeout(() => { poiLayer.innerHTML = ''; poiLayer.classList.remove('out'); }, 300);
}

function openInfo(info) {
  let panel = document.getElementById('info-panel');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'info-panel';
    document.body.appendChild(panel);
    panel.addEventListener('click', e => {
      if (e.target === panel || e.target.dataset.close) panel.classList.remove('open');
    });
  }
  panel.innerHTML = `
    <div id="info-card">
      <button data-close aria-label="Close">&times;</button>
      ${info.image ? `<img src="${info.image}" alt="">` : ''}
      <h3>${info.title}</h3>
      ${info.area ? `<span class="info-area">${info.area}</span>` : ''}
      <ul>${(info.items || []).map(t => `<li>${t}</li>`).join('')}</ul>
    </div>`;
  requestAnimationFrame(() => panel.classList.add('open'));
}

// ─── Track (nav dock) ─────────────────────────────────────────────────────────

function buildTrack() {
  const ids = CONFIG.timeline.map(t => t.id);
  trackEl.innerHTML = `
    <button class="t-arrow" id="t-prev" aria-label="Previous">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="15 18 9 12 15 6"/>
      </svg>
    </button>
    <div class="t-divider"></div>
    <span id="track-label">SHOT 1 OF ${ids.length}</span>
    <div class="t-divider"></div>
    <button class="t-arrow" id="t-next" aria-label="Next">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="9 18 15 12 9 6"/>
      </svg>
    </button>`;
  document.getElementById('t-prev').addEventListener('click', () => {
    const idx = ids.indexOf(currentScene);
    if (idx > 0) navigateTo(ids[idx - 1]);
  });
  document.getElementById('t-next').addEventListener('click', () => {
    const idx = ids.indexOf(currentScene);
    if (idx < ids.length - 1) navigateTo(ids[idx + 1]);
  });
  trackEl.classList.add('show');
}

function setActive(id) {
  const ids = CONFIG.timeline.map(t => t.id);
  const idx = ids.indexOf(id);
  const label = document.getElementById('track-label');
  if (label) label.textContent = `SHOT ${idx + 1} OF ${ids.length}`;
  // Scene tag: mostra o label da cena atual (elemento já existente no HTML)
  const tag = document.getElementById('scene-tag');
  if (tag) {
    const item = CONFIG.timeline[idx];
    tag.textContent = item ? item.label : '';
  }
  const prev = document.getElementById('t-prev');
  const next = document.getElementById('t-next');
  if (prev) prev.disabled = idx === 0;
  if (next) next.disabled = idx === ids.length - 1;
  // floor overlay: ativo apenas na Vista 1 (aerial / COVER_B1) e se o
  // usuário não desligou pelo botão do dock
  if (typeof setFloorOverlayVisible === 'function') {
    const allow = typeof floorOverlayAllowed === 'function' ? floorOverlayAllowed() : true;
    setFloorOverlayVisible(id === 'aerial' && allow);
  }
  setDayNightVisible(id === 'aerial');
}

// ─── Auto-tour ────────────────────────────────────────────────────────────────

function startTour() {
  if (touring) return;
  touring = true;
  document.body.classList.add('touring');
  track('tour_start', {});

  const ids = CONFIG.timeline.map(t => t.id);
  let dir = 1;

  const step = async () => {
    if (!touring) return;
    const curIdx = ids.indexOf(currentScene);
    let nextIdx  = curIdx + dir;
    if (nextIdx >= ids.length) { dir = -1; nextIdx = curIdx + dir; }
    if (nextIdx < 0)           { dir =  1; nextIdx = curIdx + dir; }
    if (nextIdx < 0 || nextIdx >= ids.length) return;
    await navigateTo(ids[nextIdx]);
    if (!touring) return;
    tourTimer = setTimeout(step, 3000);
  };

  tourTimer = setTimeout(step, 3000);
  const btn = document.getElementById('cta-tour');
  if (btn) {
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg><span>Stop</span>';
    btn.classList.add('active');
    btn.onclick = stopTour;
  }
}

function stopTour() {
  touring = false;
  clearTimeout(tourTimer);
  document.body.classList.remove('touring');
  const btn = document.getElementById('cta-tour');
  if (btn) {
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg><span>Tour</span>';
    btn.classList.remove('active');
    btn.onclick = startTour;
  }
}

// Any user interaction stops an in-progress tour
['pointerdown', 'keydown'].forEach(ev =>
  document.addEventListener(ev, () => { if (touring) stopTour(); }, { passive: true })
);

// ─── Keyboard navigation (← →) ───────────────────────────────────────────────

function anyOverlayOpen() {
  const openCls = id => document.getElementById(id)?.classList.contains('open');
  const leadOpen = (() => { const m = document.getElementById('lead-modal'); return m && !m.hidden; })();
  return openCls('map-modal') || openCls('pano-modal') || openCls('floor-panel') || openCls('lemme-panel') || leadOpen;
}

document.addEventListener('keydown', e => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  // Não interfere com campos de texto nem com modais abertos
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
  if (anyOverlayOpen()) return;
  const ids = CONFIG.timeline.map(x => x.id);
  const idx = ids.indexOf(currentScene);
  if (e.key === 'ArrowLeft'  && idx > 0)              navigateTo(ids[idx - 1]);
  if (e.key === 'ArrowRight' && idx < ids.length - 1) navigateTo(ids[idx + 1]);
});

// ─── Drag livre + tilt 3D reutilizável (modais que abrem centralizados) ───────
// Desktop only — mobile fica simples (sem drag/tilt). Retorna reset(), que
// zera posição/rotação e reinicia a entrada (fade + scale); chamar a cada open().

function initDragTiltCard(card, handle) {
  if (!card || MOBILE) return () => {};

  const TILT_MAX  = 2.5;  // amplitude do tilt (deg)
  const TILT_DAMP = 0.07; // suavização do tilt
  const INTRO_MS  = 260;  // duração da entrada (fade + scale)

  let posX = 0, posY = 0, dragBaseX = 0, dragBaseY = 0;
  let dragging = false, dragStartX = 0, dragStartY = 0;
  let targetRX = 0, targetRY = 0, curRX = 0, curRY = 0;
  let introT0 = 0;

  const easeOutCubic = t => 1 - Math.pow(1 - t, 3);

  function apply() {
    const introT = Math.min(1, (performance.now() - introT0) / INTRO_MS);
    const eased  = easeOutCubic(introT);
    const scale  = 0.97 + 0.03 * eased;
    card.style.opacity = eased.toFixed(3);
    card.style.transform =
      `translate3d(${posX}px, ${posY}px, 0) perspective(700px) rotateX(${curRX.toFixed(2)}deg) rotateY(${curRY.toFixed(2)}deg) scale(${scale.toFixed(3)})`;
  }

  function tick() {
    curRX += (targetRX - curRX) * TILT_DAMP;
    curRY += (targetRY - curRY) * TILT_DAMP;
    apply();
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  card.addEventListener('pointermove', e => {
    const r = card.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width;
    const py = (e.clientY - r.top) / r.height;
    targetRY = (px - 0.5) * 2 * TILT_MAX;
    targetRX = -(py - 0.5) * 2 * TILT_MAX;
    if (!dragging) return;
    posX = dragBaseX + (e.clientX - dragStartX);
    posY = dragBaseY + (e.clientY - dragStartY);
  });
  card.addEventListener('pointerleave', () => {
    if (dragging) return;
    targetRX = 0;
    targetRY = 0;
  });
  (handle || card).addEventListener('pointerdown', e => {
    if (e.target.closest('input, select, textarea, button, a')) return;
    dragging = true;
    dragBaseX = posX;
    dragBaseY = posY;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    card.classList.add('dragging');
    card.setPointerCapture(e.pointerId);
  });
  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    card.classList.remove('dragging');
  };
  card.addEventListener('pointerup', endDrag);
  card.addEventListener('pointercancel', endDrag);

  return () => {
    posX = 0; posY = 0; curRX = 0; curRY = 0; targetRX = 0; targetRY = 0;
    introT0 = performance.now();
    apply();
  };
}

window.resetMapModalCard = initDragTiltCard(
  document.getElementById('map-modal-box'),
  document.getElementById('map-modal-header'),
);

// ─── CTA + Lead modal ─────────────────────────────────────────────────────────

function initCTA() {
  const wa = document.getElementById('cta-whats');
  if (wa) {
    wa.href = `https://wa.me/${LEAD.whatsapp}?text=` +
      encodeURIComponent(`Hi! I saw the ${LEAD.project} experience and would like to know more.`);
    wa.addEventListener('click', () => track('cta_whatsapp', { scene: currentScene }));
  }

  const modal = document.getElementById('lead-modal');
  if (!modal) return;

  const resetLeadCard = initDragTiltCard(document.getElementById('lead-card'));
  const visitBtn = document.getElementById('cta-visit');

  const open  = () => {
    modal.hidden = false;
    resetLeadCard();
    if (visitBtn) visitBtn.classList.add('active');
    track('lead_open', { scene: currentScene });
  };
  const close = () => {
    modal.hidden = true;
    if (visitBtn) visitBtn.classList.remove('active');
  };

  if (visitBtn) visitBtn.addEventListener('click', open);

  const closeBtn = document.getElementById('lead-close');
  if (closeBtn) closeBtn.addEventListener('click', close);

  modal.addEventListener('click', e => { if (e.target === modal) close(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !modal.hidden) close(); });

  const form = document.getElementById('lead-form');
  if (form) {
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(e.target));
      data.project = LEAD.project;
      data.scene   = currentScene;
      try {
        await fetch(LEAD.endpoint, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify(data),
        });
      } catch (_) {}
      track('lead_submit', data);
      e.target.hidden = true;
      const ok = document.getElementById('lead-ok');
      if (ok) ok.hidden = false;
    });
  }
}

// ─── Debug mode (press D) ─────────────────────────────────────────────────────

let debugOn = false;
document.addEventListener('keydown', e => {
  if (e.key.toLowerCase() !== 'd') return;
  debugOn = !debugOn;
  debugHud.hidden = !debugOn;
  document.body.style.cursor = debugOn ? 'crosshair' : '';
});
document.addEventListener('click', e => {
  if (!debugOn) return;
  const x   = (e.clientX / innerWidth  * 100).toFixed(1);
  const y   = (e.clientY / innerHeight * 100).toFixed(1);
  const txt = `x: ${x}, y: ${y}`;
  debugCoords.textContent = txt;
  console.log(txt);
  navigator.clipboard?.writeText(txt);
});

// ─── Bot popup ────────────────────────────────────────────────────────────────

function initBotPopup() {
  const popup = document.getElementById('bot-popup');
  const box = document.getElementById('bot-popup-box');
  const waBtn = document.getElementById('bot-wa');
  const closeBtn = popup?.querySelector('.bot-close');
  if (!popup) return;

  if (waBtn) {
    waBtn.href = `https://wa.me/${LEAD.whatsapp}?text=` +
      encodeURIComponent(`Olá! Vi o tour do ${LEAD.project} e gostaria de falar com um corretor.`);
  }

  const resetBotCard = initDragTiltCard(box, box?.querySelector('.bot-header'));

  let hideTimer;

  // Guard ampliado: bot não deve aparecer sobre NENHUM modal/drawer aberto
  // (mapa, panorama 360°, formulário de lead ou painel de andar)
  function isMapOpen() {
    return anyOverlayOpen();
  }

  function show() {
    if (isMapOpen()) return;
    popup.classList.add('bot-show');
    resetBotCard();
    track('bot_popup_show', { scene: currentScene });
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hide, 30000);
    const b = document.getElementById('cta-bot');
    if (b) b.classList.add('active');
  }

  function hide() {
    popup.classList.remove('bot-show');
    clearTimeout(hideTimer);
    setTimeout(() => { popup.style.display = ''; }, 400);
    const b = document.getElementById('cta-bot');
    if (b) b.classList.remove('active');
  }

  if (closeBtn) closeBtn.addEventListener('click', () => { hide(); track('bot_popup_close', {}); });
  if (waBtn)    waBtn.addEventListener('click', () => { hide(); track('bot_whatsapp', { scene: currentScene }); });

  // Clique manual no botão do dock sempre pode abrir o popup
  const ctaBot = document.getElementById('cta-bot');
  if (ctaBot) ctaBot.addEventListener('click', e => {
    e.stopPropagation();
    show();
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hide, 30000);
  });

  // Aparece 1x, 6s após o carregamento da sessão — sem ciclo automático
  // depois disso; só reabre se o visitante clicar no botão do dock.
  setTimeout(show, 6000);
}
