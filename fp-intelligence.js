/* FirstPerson Adaptive Intelligence — motor no navegador (vertical slice do plano
   "FirstPerson Adaptive Intelligence Engine"): cena → evento → perfil → sugestão →
   impressão → feedback.

   - Catálogo semântico curado (vistas, andares, tipologias, entorno, seções do painel)
   - Eventos com UUID, deduplicação e tempo ativo (pausa em aba oculta/inatividade)
   - Perfil explicável: declarado × observado × confiança, com decaimento
   - Ranking determinístico (regras v1) com justificativa e log de decisões
   - Guia opcional: até 3 convites/sessão, cooldown, dispensa e desligamento
   - Missões por marcos únicos, favoritos com comparação, resumo e contexto no lead

   Sem dependências e sem LLM. Nada sai do navegador, exceto: (1) o resumo enviado
   junto com o pedido de contato, se a pessoa deixar marcado; (2) eventos para
   CFG.endpoint, que é null por padrão (ponto de ligação com o backend futuro). */

(function () {
  "use strict";

  const params = new URLSearchParams(location.search);
  const FAST = params.get("fpai") === "fast"; // testes: timers curtos

  const CFG = {
    endpoint: null, // ex.: "/api/events" — envelope do plano (seção 4.2)
    policy: "rules-v1",
    catalogVersion: "lemme-2026-10-v1",
    halfLifeDays: 7,
    heartbeatMs: FAST ? 1000 : 5000,
    idleMs: 30000,
    engagedEveryMs: FAST ? 3000 : 15000, // tempo ativo por crédito de engajamento
    maxEngagedPerTarget: 3,
    dedupMs: 3000,
    guide: {
      firstAfterMs: FAST ? 3000 : 40000,
      cooldownMs: FAST ? 4000 : 45000,
      maxPerSession: FAST ? 20 : 3,
      minSignals: FAST ? 1 : 3,
      quietMs: FAST ? 0 : 4000, // só aparece após alguns segundos sem interação
      autoHideMs: 16000,
    },
  };

  /* ─── Dimensões de preferência (5–8, editoriais) ─────────────────────────── */

  const DIMS = {
    vista: "Vista",
    area_externa: "Área externa",
    lazer: "Lazer",
    espaco: "Espaço",
    privacidade: "Privacidade",
    acabamento: "Acabamento",
    localizacao: "Localização",
    seguranca: "Segurança",
  };

  /* ─── Pesos de evento (hipóteses iniciais; calibrar com dados) ───────────── */

  const WEIGHTS = {
    scene_entered: 0.2,
    scene_engaged: 1,
    hotspot_opened: 1,
    unit_viewed: 1.5,
    typology_viewed: 1.2,
    surroundings_filtered: 1,
    section_viewed: 0.8,
    favorite_added: 3,
    comparison_opened: 2,
    recommendation_clicked: 1,
  };
  const NEG_WEIGHTS = { favorite_removed: 2, recommendation_dismissed: 0.5 };
  const PRIOR = 2; // suaviza afinidade com pouca evidência
  const TARGET_CAP = 4; // evidência máxima creditada por alvo × dimensão

  /* ─── Catálogo semântico (valores editoriais 0–1: revisar com o comercial) ── */
  // As 6 vistas são órbitas aéreas do edifício; os ids pool/garden/… são legados.

  const SCENE_META = {
    aerial: { title: "Vista 1 · Fachada e esquina", f: { vista: 0.5, localizacao: 0.5 } },
    pool: { title: "Vista 2 · Skyline de Curitiba", f: { vista: 0.9, localizacao: 0.3 } },
    garden: { title: "Vista 3 · Piscina e jardim", f: { lazer: 0.7, area_externa: 0.6 } },
    living: { title: "Vista 4 · Bairro Água Verde", f: { localizacao: 0.8, vista: 0.3 } },
    kitchen: { title: "Vista 5 · Rua e entorno", f: { localizacao: 0.6, area_externa: 0.3 } },
    room6: { title: "Vista 6 · Panorama da cidade", f: { vista: 1 } },
  };

  const UNIT_FEATURES = {
    cobertura: { vista: 1, area_externa: 0.9, privacidade: 0.9, espaco: 0.9, lazer: 0.6, acabamento: 0.7 },
    andar6: { vista: 0.8, area_externa: 0.7, espaco: 0.6 },
    andar5: { acabamento: 0.9, vista: 0.5, espaco: 0.4 },
    andar4: { acabamento: 0.9, privacidade: 0.7, espaco: 0.4 },
    andar3: { privacidade: 0.9, area_externa: 0.5, espaco: 0.4 },
    andar2: { lazer: 0.9, area_externa: 0.6, espaco: 0.4 },
    andar1: { area_externa: 1, espaco: 1, lazer: 0.6, privacidade: 0.6 },
    terreo: { seguranca: 1, lazer: 0.3 },
  };

  const TYPO_FEATURES = {
    tipo1: { espaco: 0.4, acabamento: 0.5 },
    tipo2: { espaco: 0.55, area_externa: 0.5, vista: 0.4 },
    tipo3: { espaco: 0.7 },
    tipo4: { espaco: 0.85, vista: 1, area_externa: 0.9, privacidade: 0.8 },
    tipo5: { espaco: 1, area_externa: 1, lazer: 0.5 },
  };

  const SURROUNDINGS = {
    educacao: { title: "Escolas no entorno", f: { localizacao: 0.9 } },
    saude: { title: "Saúde no entorno", f: { localizacao: 0.8, seguranca: 0.3 } },
    lazer: { title: "Parques e lazer no entorno", f: { localizacao: 0.7, lazer: 0.6, area_externa: 0.3 } },
    transporte: { title: "Mobilidade e acessos", f: { localizacao: 1 } },
  };

  const SECTIONS = {
    conceito: { title: "O conceito do Lemme", f: { acabamento: 0.4, espaco: 0.2 } },
    tipologias: { title: "As tipologias", f: { espaco: 0.8 } },
    diferenciais: { title: "Diferenciais do edifício", f: { acabamento: 0.7, seguranca: 0.6, lazer: 0.5 } },
    decorado: { title: "O apartamento decorado", f: { acabamento: 0.9 } },
    mobiliario: { title: "Mobiliário e design", f: { acabamento: 0.7 } },
    bairro: { title: "O bairro Água Verde", f: { localizacao: 1 } },
  };

  const HOTSPOTS = {
    PADARIA: { f: { localizacao: 0.8 } },
  };

  let CATALOG = null; // Map id → item

  function buildCatalog() {
    const items = new Map();
    const add = (it) => items.set(it.id, Object.assign({ available: true, catalog_version: CFG.catalogVersion }, it));

    Object.keys(SCENE_META).forEach((id) =>
      add({ id: "scene_" + id, kind: "scene", ref: id, title: SCENE_META[id].title, features: SCENE_META[id].f })
    );

    (window.FLOOR_DATA || []).forEach((fl) =>
      add({
        id: "unit_" + fl.id,
        kind: fl.id === "terreo" ? "common" : "unit",
        ref: fl.id,
        title: fl.id === "terreo" ? "Térreo · Lobby e áreas comuns" : `${fl.label} · ${fl.tipo}`,
        features: UNIT_FEATURES[fl.id] || {},
        facts: { area: fl.area, quartos: fl.quartos, banheiros: fl.banheiros, vagas: fl.vagas, suites: fl.suites, avail: fl.avail, label: fl.label, tipo: fl.tipo },
        // unidade indisponível nunca é recomendada (área comum é neutra)
        available: fl.id === "terreo" || fl.avail === "disponivel",
      })
    );

    const fp = window.FP_DATA || {};
    Object.keys(fp).forEach((k) =>
      add({ id: "typo_" + k, kind: "typology", ref: k, title: `Planta ${fp[k].label}`, features: TYPO_FEATURES[k] || {}, facts: { area: fp[k].area } })
    );

    Object.keys(SURROUNDINGS).forEach((k) =>
      add({ id: "surr_" + k, kind: "surroundings", ref: k, title: SURROUNDINGS[k].title, features: SURROUNDINGS[k].f })
    );

    Object.keys(SECTIONS).forEach((k) =>
      add({ id: "sec_" + k, kind: "section", ref: k, title: SECTIONS[k].title, features: SECTIONS[k].f })
    );

    Object.keys(HOTSPOTS).forEach((k) => add({ id: "poi_" + k, kind: "hotspot", ref: k, title: k, features: HOTSPOTS[k].f }));

    add({ id: "act_compare", kind: "compare", title: "Compare seus favoritos", features: {} });
    add({ id: "act_contact", kind: "contact", title: "Agende uma visita ao decorado", features: {} });
    add({ id: "act_question", kind: "question", title: "O que mais importa para você?", features: {} });
    return items;
  }

  /* ─── Estado (perfil por sessão; persistência local só com opt-in) ───────── */

  const KEY = "fpai.v1";

  function freshState() {
    return {
      v: 1,
      session_id: uuid(),
      started_at: Date.now(),
      evidence: [], // { d, w, t, target, ev } — w<0 = evidência negativa
      declared: { priorities: [], filters: null },
      favorites: [],
      visits: {}, // target → nº de aberturas válidas
      engaged: {}, // target → nº de créditos de engajamento
      active_ms: {}, // scene → ms ativos
      milestones: {},
      contact: false,
      guide: { on: true, shown: 0, last_at: 0, dismissed: [], asked: false, last_dim: null },
      decisions: [],
      remember: false,
    };
  }

  function loadState() {
    for (const store of [localStorage, sessionStorage]) {
      try {
        const raw = store.getItem(KEY);
        if (raw) {
          const s = JSON.parse(raw);
          if (s && s.v === 1) return Object.assign(freshState(), s);
        }
      } catch (_) {}
    }
    return freshState();
  }

  let S = loadState();

  function save() {
    const raw = JSON.stringify(S);
    try { sessionStorage.setItem(KEY, raw); } catch (_) {}
    try {
      if (S.remember) localStorage.setItem(KEY, raw);
      else localStorage.removeItem(KEY);
    } catch (_) {}
  }

  /* ─── Utilidades ─────────────────────────────────────────────────────────── */

  function uuid() {
    try { return crypto.randomUUID(); } catch (_) {
      return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
      });
    }
  }

  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const g = (name) => {
    // `let`/`const` globais dos outros scripts (currentScene, busy, touring)
    try { return Function("return typeof " + name + " !== 'undefined' ? " + name + " : undefined")(); } catch (_) { return undefined; }
  };

  const overlayOpen = () => (typeof window.anyOverlayOpen === "function" ? window.anyOverlayOpen() : false);

  /* ─── Ingestão de eventos ────────────────────────────────────────────────── */

  const pending = [];
  let ready = false;
  const lastSeen = new Map(); // dedup por nome+alvo
  let lastActivity = Date.now();

  function track(name, target, props) {
    const ev = {
      event_id: uuid(),
      schema_version: 1,
      session_id: S.session_id,
      name,
      target_id: target || null,
      occurred_at: new Date().toISOString(),
      properties: props || {},
    };
    if (!ready) { pending.push(ev); return; }
    ingest(ev);
  }

  function ingest(ev) {
    const key = ev.name + "|" + ev.target_id;
    const now = Date.parse(ev.occurred_at);
    // repetição rápida no mesmo alvo não infla (estados como filtro/prioridade sempre valem)
    if (ev.target_id) {
      if (now - (lastSeen.get(key) || 0) < CFG.dedupMs) return;
      lastSeen.set(key, now);
    }

    const item = ev.target_id ? CATALOG.get(ev.target_id) : null;

    switch (ev.name) {
      case "scene_entered":
        if (item) { activeScene = item.id; S.visits[item.id] = (S.visits[item.id] || 0) + 1; }
        // retornos automáticos à mesma vista não contam de novo como evidência
        if (S.visits[ev.target_id] > 1) break;
        credit(ev, item, WEIGHTS.scene_entered);
        break;
      case "scene_engaged":
        S.engaged[ev.target_id] = (S.engaged[ev.target_id] || 0) + 1;
        if (S.engaged[ev.target_id] <= CFG.maxEngagedPerTarget) credit(ev, item, WEIGHTS.scene_engaged);
        break;
      case "favorite_added":
        if (!S.favorites.includes(ev.target_id)) { S.favorites.push(ev.target_id); credit(ev, item, WEIGHTS.favorite_added); }
        break;
      case "favorite_removed":
        if (S.favorites.includes(ev.target_id)) {
          S.favorites = S.favorites.filter((x) => x !== ev.target_id);
          credit(ev, item, -NEG_WEIGHTS.favorite_removed);
        }
        break;
      case "recommendation_dismissed":
        if (item) { S.guide.dismissed.push(item.id); credit(ev, item, -NEG_WEIGHTS.recommendation_dismissed); }
        break;
      case "preference_answered":
        S.declared.priorities = (ev.properties.priorities || []).filter((d) => DIMS[d]);
        S.guide.asked = true;
        S.milestones.prioridades = true;
        break;
      case "filter_changed":
        S.declared.filters = ev.properties;
        break;
      case "contact_requested":
        S.contact = true;
        break;
      default:
        if (WEIGHTS[ev.name] != null && item) {
          S.visits[item.id] = (S.visits[item.id] || 0) + 1;
          credit(ev, item, WEIGHTS[ev.name]);
        }
    }

    updateMilestones(ev);
    sendRemote(ev);
    save();
    renderBadge();
    if (journeyOpen) renderJourney();
    if (ev.name === "unit_viewed" || ev.name.startsWith("favorite_")) syncFavButton();
  }

  function credit(ev, item, weight) {
    if (!item || !weight) return;
    const t = Date.parse(ev.occurred_at);
    Object.keys(item.features || {}).forEach((d) => {
      const rel = item.features[d];
      if (rel > 0) S.evidence.push({ d, w: weight * rel, t, target: item.id, ev: ev.name });
    });
    if (S.evidence.length > 400) S.evidence = S.evidence.slice(-400);
  }

  function sendRemote(ev) {
    if (!CFG.endpoint) return;
    try {
      const body = JSON.stringify(Object.assign({}, ev, { policy_version: CFG.policy, catalog_version: CFG.catalogVersion }));
      if (!(navigator.sendBeacon && navigator.sendBeacon(CFG.endpoint, body))) {
        fetch(CFG.endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: true }).catch(() => {});
      }
    } catch (_) {}
  }

  /* ─── Tempo ativo por vista (heartbeat) ──────────────────────────────────── */

  let activeScene = null;

  ["pointerdown", "pointermove", "keydown", "wheel", "touchstart"].forEach((t) =>
    window.addEventListener(t, () => { lastActivity = Date.now(); }, { passive: true })
  );

  function heartbeat() {
    const now = Date.now();
    const active = !document.hidden && document.hasFocus() && now - lastActivity < CFG.idleMs;
    if (active && activeScene && !g("busy") && !overlayOpen()) {
      const before = S.active_ms[activeScene] || 0;
      const after = before + CFG.heartbeatMs; // crédito limitado ao intervalo
      S.active_ms[activeScene] = after;
      if (Math.floor(after / CFG.engagedEveryMs) > Math.floor(before / CFG.engagedEveryMs)) {
        track("scene_engaged", activeScene, { active_ms: after });
      }
    }
    // convite sai da frente se um modal/painel abrir ou a câmera começar a mover
    if (cardEl && (overlayOpen() || g("busy") || journeyOpen)) hideCard();
    maybeSuggest();
  }

  /* ─── Perfil ─────────────────────────────────────────────────────────────── */

  function profile() {
    const now = Date.now();
    const halfLifeMs = CFG.halfLifeDays * 86400000;
    const pos = {}, neg = {}, targets = {}, perTarget = {};
    S.evidence.forEach((e) => {
      const decay = Math.exp((-Math.LN2 * (now - e.t)) / halfLifeMs);
      const w = e.w * decay;
      if (w >= 0) {
        const k = e.d + "|" + e.target;
        const room = TARGET_CAP - (perTarget[k] || 0);
        if (room <= 0) return;
        const c = Math.min(w, room);
        perTarget[k] = (perTarget[k] || 0) + c;
        pos[e.d] = (pos[e.d] || 0) + c;
        (targets[e.d] = targets[e.d] || new Set()).add(e.target);
      } else {
        neg[e.d] = (neg[e.d] || 0) - w;
      }
    });

    const observed = {}, confidence = {}, evidenceTargets = {};
    Object.keys(DIMS).forEach((d) => {
      const p = pos[d] || 0, n = neg[d] || 0;
      observed[d] = p / (PRIOR + p + n);
      const distinct = targets[d] ? targets[d].size : 0;
      evidenceTargets[d] = targets[d] ? Array.from(targets[d]) : [];
      const declared = S.declared.priorities.includes(d);
      // confiança: alvos independentes + concordância observação × declaração
      confidence[d] = declared && distinct >= 1 ? "alta" : declared ? "declarada" : distinct >= 3 && observed[d] >= 0.5 ? "alta" : distinct >= 2 ? "media" : distinct === 1 ? "baixa" : "nenhuma";
    });

    return { observed, confidence, evidenceTargets, stage: stage(evidenceTargets), declared: S.declared };
  }

  function stage(evidenceTargets) {
    if (S.contact) return "contact";
    const unitsViewed = Object.keys(S.visits).filter((k) => k.startsWith("unit_")).length;
    if (S.favorites.length >= 2 || unitsViewed >= 2 || S.milestones.comparar) return "comparison";
    const themes = Object.keys(evidenceTargets).filter((d) => evidenceTargets[d].length > 0).length;
    const distinct = Object.keys(S.visits).length;
    if (themes >= 2 && distinct >= 3) return "exploration";
    return "discovery";
  }

  const STAGE_LABEL = { discovery: "Descobrindo", exploration: "Explorando", comparison: "Comparando", contact: "Em contato" };

  function signalCount() {
    return S.evidence.filter((e) => e.ev !== "scene_entered").length;
  }

  /* ─── Missões (marcos únicos, nunca cliques brutos) ──────────────────────── */

  const MISSIONS = [
    { id: "vistas", label: "Percorra 3 vistas do edifício" },
    { id: "andar", label: "Abra os detalhes de um andar" },
    { id: "entorno", label: "Explore o entorno" },
    { id: "favorito", label: "Salve um andar favorito" },
    { id: "prioridades", label: "Conte o que mais importa para você" },
  ];

  function updateMilestones(ev) {
    const scenes = Object.keys(S.visits).filter((k) => k.startsWith("scene_")).length;
    if (scenes >= 3) S.milestones.vistas = true;
    if (ev.name === "unit_viewed") S.milestones.andar = true;
    if (ev.name === "surroundings_opened" || ev.name === "surroundings_filtered") S.milestones.entorno = true;
    if (ev.name === "favorite_added") S.milestones.favorito = true;
    if (ev.name === "comparison_opened") S.milestones.comparar = true;
  }

  const progress = () => MISSIONS.filter((m) => S.milestones[m.id]).length;

  /* ─── Política rules-v1: elegibilidade → ranking → justificativa ─────────── */

  const STAGE_FIT = {
    discovery: { scene: 1, surroundings: 0.8, section: 0.7, question: 0.9, typology: 0.4, unit: 0.3, common: 0.3 },
    exploration: { unit: 1, typology: 0.8, question: 0.8, surroundings: 0.6, section: 0.6, common: 0.4, scene: 0.4, contact: 0.2 },
    comparison: { compare: 1, contact: 0.8, unit: 0.7, typology: 0.5, section: 0.3, surroundings: 0.3, scene: 0.1 },
    contact: { unit: 0.5, typology: 0.4, section: 0.4, surroundings: 0.3 },
  };

  function matchesDeclaredFilters(item) {
    if (item.kind !== "unit") return true;
    if (typeof window.floorMatchesFilters !== "function") return true;
    const fl = (window.FLOOR_DATA || []).find((f) => f.id === item.ref);
    return fl ? window.floorMatchesFilters(fl) : true;
  }

  function eligible(item, prof) {
    if (!item.available) return false;
    if (S.guide.dismissed.includes(item.id)) return false;
    if (item.kind === "hotspot") return false; // POIs só alimentam o perfil
    if (!matchesDeclaredFilters(item)) return false; // filtros obrigatórios antes do ranking
    if (item.kind === "question") return !S.guide.asked && signalCount() >= CFG.guide.minSignals;
    if (item.kind === "compare") return S.favorites.length >= 2 && !S.milestones.comparar;
    if (item.kind === "contact") return !S.contact && prof.stage === "comparison";
    if (item.kind === "scene" && item.ref === g("currentScene")) return false;
    return (STAGE_FIT[prof.stage] || {})[item.kind] != null;
  }

  function affinityFor(item, prof) {
    const f = item.features || {};
    const den = Object.values(f).reduce((a, b) => a + b, 0) || 1;
    let sum = 0, best = null, bestC = 0;
    Object.keys(f).forEach((d) => {
      // prioridade declarada prevalece sobre sinais fracos
      const a = S.declared.priorities.includes(d) ? Math.max(prof.observed[d], 0.8) : prof.observed[d];
      const c = a * f[d];
      sum += c;
      if (c > bestC) { bestC = c; best = d; }
    });
    return { affinity: sum / den, topDim: best };
  }

  function rank(prof) {
    const rows = [];
    CATALOG.forEach((item) => {
      if (!eligible(item, prof)) return;
      const { affinity, topDim } = affinityFor(item, prof);
      const seen = (S.visits[item.id] || 0) > 0;
      const novelty = seen ? 0 : 1;
      const diversity = topDim && topDim === S.guide.last_dim ? 0 : 1;
      const fixedAff = item.kind === "compare" || item.kind === "contact" || item.kind === "question" ? 0.6 : affinity;
      const score =
        0.5 * fixedAff +
        0.2 * ((STAGE_FIT[prof.stage] || {})[item.kind] || 0) +
        0.15 * novelty +
        0.15 * diversity -
        (seen ? 0.3 : 0);
      rows.push({ id: item.id, score: Math.round(score * 10000) / 10000, topDim });
    });
    return rows.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
  }

  function reasonFor(item, topDim, prof) {
    if (item.kind === "question") return "Assim as próximas sugestões ficam do seu jeito.";
    if (item.kind === "compare") return `Você salvou ${S.favorites.length} andares como favoritos.`;
    if (item.kind === "contact") return "Você já comparou opções — o decorado mostra tudo ao vivo.";
    if (!topDim) return "Um bom próximo passo para conhecer o Lemme.";
    const label = DIMS[topDim].toLowerCase();
    if (S.declared.priorities.includes(topDim)) return `Você marcou ${label} como prioridade.`;
    const n = prof.evidenceTargets[topDim].length;
    if (n >= 2) return `Você explorou ${n} pontos ligados a ${label}.`;
    if (n === 1) return `Você demonstrou interesse em ${label}.`;
    return "Um bom próximo passo para conhecer o Lemme.";
  }

  function decide() {
    const prof = profile();
    const ranked = rank(prof);
    if (!ranked.length) return null;
    const top = ranked[0];
    const item = CATALOG.get(top.id);
    const decision = {
      id: uuid(),
      at: Date.now(),
      item_id: item.id,
      score: top.score,
      reason: reasonFor(item, top.topDim, prof),
      top_dim: top.topDim,
      stage: prof.stage,
      candidates: ranked.slice(0, 6),
      policy_version: CFG.policy,
    };
    S.decisions.push(decision);
    if (S.decisions.length > 50) S.decisions = S.decisions.slice(-50);
    return { decision, item };
  }

  /* ─── Execução das ações sugeridas ───────────────────────────────────────── */

  function whenIdle(cond, fn, tries = 80) {
    if (cond()) return fn();
    if (tries <= 0) return;
    setTimeout(() => whenIdle(cond, fn, tries - 1), 150);
  }

  function runAction(item) {
    switch (item.kind) {
      case "scene":
        if (typeof window.navigateTo === "function") window.navigateTo(item.ref);
        break;
      case "unit":
      case "common": {
        const open = () => {
          if (typeof window.floorOverlayAllowed === "function" && !window.floorOverlayAllowed()) window.toggleFloorOverlay();
          window.openFloorPanel(item.ref);
        };
        if (g("currentScene") !== "aerial") {
          window.navigateTo("aerial");
          whenIdle(() => g("currentScene") === "aerial" && !g("busy"), open);
        } else open();
        break;
      }
      case "typology": {
        const panel = document.getElementById("fp-panel");
        if (panel && !panel.classList.contains("open")) window.toggleFpPanel();
        const btn = document.querySelector('.fp-type-btn[data-fp="' + item.ref + '"]');
        if (btn) btn.click(); else if (window.loadFpData) window.loadFpData(item.ref);
        break;
      }
      case "surroundings":
        window.openMapModal();
        if (window.setMapFilter) window.setMapFilter(item.ref);
        break;
      case "section":
        window.openLemmePanel();
        setTimeout(() => window.lmGoTo && window.lmGoTo(item.ref), 350);
        break;
      case "compare":
        openJourney("favoritos");
        break;
      case "contact": {
        const btn = document.getElementById("cta-visit");
        if (btn) btn.click();
        break;
      }
    }
  }

  /* ─── Guia: convites discretos ───────────────────────────────────────────── */

  let cardEl = null, cardTimer = null, cardDecision = null;

  function canSuggest() {
    const G = CFG.guide, now = Date.now();
    if (!S.guide.on || cardEl) return false;
    if (S.guide.shown >= G.maxPerSession) return false;
    if (now - S.started_at < G.firstAfterMs) return false;
    if (now - S.guide.last_at < G.cooldownMs * (1 + S.guide.dismissed.length * 0.5)) return false;
    if (now - lastActivity < G.quietMs) return false; // não interrompe arrasto/leitura
    if (signalCount() < Math.min(2, G.minSignals)) return false;
    if (g("busy") || g("touring") || overlayOpen() || journeyOpen) return false;
    return true;
  }

  function maybeSuggest() {
    if (!canSuggest()) return;
    const res = decide();
    if (!res) return;
    showCard(res.item, res.decision);
  }

  function showCard(item, decision) {
    cardDecision = decision;
    cardEl = document.createElement("aside");
    cardEl.id = "fp-suggest";
    cardEl.setAttribute("role", "dialog");
    cardEl.setAttribute("aria-label", "Sugestão para você");

    if (item.kind === "question") {
      cardEl.innerHTML = `
        <div class="fps-head"><p class="fps-eyebrow">Seu percurso</p>
          <button class="fps-x" data-act="dismiss" aria-label="Fechar">${ICON.x}</button></div>
        <h3 class="fps-title">O que mais importa para você?</h3>
        <p class="fps-reason">${esc(decision.reason)} Escolha até 3.</p>
        <div class="fps-chips">${Object.keys(DIMS).map((d) =>
          `<button class="fps-chip" data-dim="${d}" aria-pressed="false">${DIMS[d]}</button>`).join("")}</div>
        <div class="fps-actions">
          <button class="fps-btn fps-btn--primary" data-act="save" disabled>Salvar</button>
          <button class="fps-btn" data-act="dismiss">Agora não</button>
        </div>`;
      const chips = cardEl.querySelectorAll(".fps-chip");
      const saveBtn = cardEl.querySelector('[data-act="save"]');
      chips.forEach((c) => c.addEventListener("click", () => {
        const on = c.getAttribute("aria-pressed") !== "true";
        const count = cardEl.querySelectorAll('.fps-chip[aria-pressed="true"]').length;
        if (on && count >= 3) return;
        c.setAttribute("aria-pressed", String(on));
        saveBtn.disabled = !cardEl.querySelector('.fps-chip[aria-pressed="true"]');
      }));
    } else {
      cardEl.innerHTML = `
        <div class="fps-head"><p class="fps-eyebrow">Sugestão para você</p>
          <button class="fps-x" data-act="dismiss" aria-label="Fechar">${ICON.x}</button></div>
        <h3 class="fps-title">${esc(item.title)}</h3>
        <p class="fps-reason">${esc(decision.reason)}</p>
        <div class="fps-actions">
          <button class="fps-btn fps-btn--primary" data-act="go">${esc(CTA_LABEL[item.kind] || "Ver agora")}</button>
          <button class="fps-btn" data-act="dismiss">Agora não</button>
        </div>
        <button class="fps-off" data-act="off">Desligar sugestões</button>`;
    }

    cardEl.addEventListener("click", (e) => {
      const act = e.target.closest("[data-act]")?.dataset.act;
      if (!act) return;
      if (act === "go") { track("recommendation_clicked", item.id, { decision_id: decision.id }); hideCard(); runAction(item); }
      if (act === "save") {
        const dims = Array.from(cardEl.querySelectorAll('.fps-chip[aria-pressed="true"]')).map((c) => c.dataset.dim);
        track("preference_answered", null, { priorities: dims, decision_id: decision.id });
        hideCard();
      }
      if (act === "dismiss") {
        if (item.kind === "question") { S.guide.asked = true; save(); }
        track("recommendation_dismissed", item.id, { decision_id: decision.id });
        hideCard();
      }
      if (act === "off") { setGuide(false); hideCard(); }
    });
    cardEl.addEventListener("keydown", (e) => { if (e.key === "Escape") cardEl.querySelector('[data-act="dismiss"]').click(); });

    document.body.appendChild(cardEl);
    requestAnimationFrame(() => cardEl && cardEl.classList.add("is-visible"));
    // impressão só quando o card está de fato visível
    S.guide.shown += 1;
    S.guide.last_at = Date.now();
    S.guide.last_dim = decision.top_dim;
    if (item.kind === "question") S.guide.asked = true; // pergunta uma vez só, mesmo se ignorada
    track("recommendation_impression", item.id, { decision_id: decision.id, score: decision.score, policy_version: CFG.policy });
    cardTimer = setTimeout(hideCard, CFG.guide.autoHideMs);
  }

  function hideCard() {
    clearTimeout(cardTimer);
    if (!cardEl) return;
    const el = cardEl;
    cardEl = null;
    el.classList.remove("is-visible");
    setTimeout(() => el.remove(), 250);
  }

  const CTA_LABEL = {
    scene: "Ir para a vista",
    unit: "Ver o andar",
    common: "Ver o térreo",
    typology: "Ver a planta",
    surroundings: "Abrir o entorno",
    section: "Ler agora",
    compare: "Comparar",
    contact: "Agendar visita",
  };

  function setGuide(on) {
    S.guide.on = on;
    save();
    if (!on) hideCard();
    if (journeyOpen) renderJourney();
  }

  /* ─── Ícones ─────────────────────────────────────────────────────────────── */

  const svg = (p, sw = 2) => `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
  const ICON = {
    spark: svg('<path d="M12 3l1.9 5.6L19.5 10l-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.4z"/><path d="M19 15l.7 2.1 2.1.7-2.1.7L19 20.6l-.7-2.1-2.1-.7 2.1-.7z"/>', 1.6),
    x: svg('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>'),
    check: svg('<polyline points="20 6 9 17 4 12"/>', 3),
    heart: svg('<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21l7.8-7.5 1-1.1a5.5 5.5 0 0 0 0-7.8z"/>', 1.8),
    arrow: svg('<line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>'),
  };

  /* ─── Botão do percurso na barra superior ────────────────────────────────── */

  let badgeEl = null;

  function mountTopButton() {
    const bar = document.getElementById("top-bar");
    if (!bar || document.getElementById("fp-journey-btn")) return;
    const btn = document.createElement("button");
    btn.id = "fp-journey-btn";
    btn.setAttribute("aria-label", "Seu percurso");
    btn.title = "Seu percurso";
    btn.innerHTML = ICON.spark + '<span class="fpj-badge" aria-hidden="true"></span>';
    btn.addEventListener("click", () => (journeyOpen ? closeJourney() : openJourney()));
    bar.appendChild(btn);
    badgeEl = btn.querySelector(".fpj-badge");
    renderBadge();
  }

  function renderBadge() {
    if (!badgeEl) return;
    badgeEl.textContent = progress() + "/" + MISSIONS.length;
  }

  /* ─── Painel "Seu percurso" ──────────────────────────────────────────────── */

  let journeyEl = null, journeyOpen = false;

  function openJourney(focus) {
    hideCard();
    if (!journeyEl) {
      journeyEl = document.createElement("section");
      journeyEl.id = "fp-journey";
      journeyEl.setAttribute("aria-label", "Seu percurso");
      document.body.appendChild(journeyEl);
      journeyEl.addEventListener("click", onJourneyClick);
      journeyEl.addEventListener("keydown", (e) => { if (e.key === "Escape") closeJourney(); });
    }
    journeyOpen = true;
    renderJourney();
    journeyEl.classList.add("is-open");
    document.getElementById("fp-journey-btn")?.setAttribute("aria-pressed", "true");
    if (focus === "favoritos") {
      if (S.favorites.length >= 2) track("comparison_opened", null, { units: S.favorites.slice() });
      setTimeout(() => journeyEl.querySelector("#fpj-favoritos")?.scrollIntoView({ block: "start", behavior: "smooth" }), 50);
    }
    track("journey_opened", null, {});
  }

  function closeJourney() {
    journeyOpen = false;
    journeyEl?.classList.remove("is-open");
    document.getElementById("fp-journey-btn")?.setAttribute("aria-pressed", "false");
  }

  function renderJourney() {
    if (!journeyEl) return;
    const prof = profile();
    const done = progress();
    const pct = Math.round((done / MISSIONS.length) * 100);

    const dimsSorted = Object.keys(DIMS)
      .filter((d) => prof.observed[d] > 0.05 || S.declared.priorities.includes(d))
      .sort((a, b) => prof.observed[b] - prof.observed[a])
      .slice(0, 5);

    const favs = S.favorites.map((id) => CATALOG.get(id)).filter(Boolean);
    const ranked = rank(prof).filter((r) => {
      const k = CATALOG.get(r.id).kind;
      return k !== "question";
    }).slice(0, 3);

    const confLabel = { alta: "confiança alta", media: "confiança média", baixa: "confiança baixa", declarada: "declarada por você", nenhuma: "" };

    journeyEl.innerHTML = `
      <header class="fpj-head">
        <div>
          <p class="fpj-eyebrow">FirstPerson · Seu percurso</p>
          <h2 class="fpj-title">${STAGE_LABEL[prof.stage]}</h2>
        </div>
        <button class="fpj-close" data-act="close" aria-label="Fechar">${ICON.x}</button>
      </header>
      <div class="fpj-body">
        <section class="fpj-block">
          <div class="fpj-row"><span class="fpj-label">Progresso</span><span class="fpj-meta">${done} de ${MISSIONS.length}</span></div>
          <div class="fpj-bar"><span style="width:${pct}%"></span></div>
          <ul class="fpj-missions">${MISSIONS.map((m) => `
            <li class="${S.milestones[m.id] ? "is-done" : ""}"><span class="fpj-tick">${S.milestones[m.id] ? ICON.check : ""}</span>${esc(m.label)}</li>`).join("")}
          </ul>
        </section>

        <section class="fpj-block">
          <div class="fpj-row"><span class="fpj-label">Suas prioridades</span><span class="fpj-meta">toque para ajustar</span></div>
          <div class="fpj-chips">${Object.keys(DIMS).map((d) => `
            <button class="fpj-chip" data-act="prio" data-dim="${d}" aria-pressed="${S.declared.priorities.includes(d)}">${DIMS[d]}</button>`).join("")}
          </div>
        </section>

        <section class="fpj-block">
          <div class="fpj-row"><span class="fpj-label">O que observamos</span><span class="fpj-meta">hipóteses, não certezas</span></div>
          ${dimsSorted.length ? `<ul class="fpj-affinity">${dimsSorted.map((d) => `
            <li>
              <div class="fpj-row"><strong>${DIMS[d]}</strong><span class="fpj-meta">${confLabel[prof.confidence[d]]}</span></div>
              <div class="fpj-bar fpj-bar--thin"><span style="width:${Math.round(Math.max(prof.observed[d], S.declared.priorities.includes(d) ? 0.08 : 0) * 100)}%"></span></div>
              ${prof.evidenceTargets[d].length ? `<p class="fpj-ev">${prof.evidenceTargets[d].slice(0, 3).map((id) => esc(shortTitle(id))).join(" · ")}</p>` : ""}
            </li>`).join("")}</ul>` : `<p class="fpj-empty">Explore as vistas, os andares e o entorno — o percurso se monta sozinho.</p>`}
        </section>

        <section class="fpj-block" id="fpj-favoritos">
          <div class="fpj-row"><span class="fpj-label">Favoritos</span><span class="fpj-meta">${favs.length ? favs.length + " salvos" : "nenhum ainda"}</span></div>
          ${favs.length ? compareTable(favs) : `<p class="fpj-empty">Use o ${ICON.heart} no painel de um andar para salvar e comparar.</p>`}
        </section>

        ${ranked.length ? `<section class="fpj-block">
          <div class="fpj-row"><span class="fpj-label">Sugerido para você</span></div>
          <ul class="fpj-recs">${ranked.map((r) => {
            const it = CATALOG.get(r.id);
            return `<li><button class="fpj-rec" data-act="rec" data-id="${it.id}">
              <span><strong>${esc(it.title)}</strong><em>${esc(reasonFor(it, r.topDim, prof))}</em></span>${ICON.arrow}</button></li>`;
          }).join("")}</ul>
        </section>` : ""}

        <section class="fpj-block fpj-settings">
          <label class="fpj-switch"><input type="checkbox" data-act="guide" ${S.guide.on ? "checked" : ""}/><span>Sugestões durante a visita</span></label>
          <label class="fpj-switch"><input type="checkbox" data-act="remember" ${S.remember ? "checked" : ""}/><span>Lembrar neste dispositivo</span></label>
          <button class="fpj-text" data-act="reset">Recomeçar percurso</button>
        </section>
      </div>
      <footer class="fpj-foot">
        <button class="fpj-primary" data-act="contact">Agendar visita com meu percurso</button>
      </footer>`;
  }

  function shortTitle(id) {
    const it = CATALOG.get(id);
    if (!it) return id;
    return it.kind === "unit" ? it.facts.label : it.title.replace(/^Vista (\d) · .*/, "Vista $1");
  }

  function compareTable(favs) {
    const status = { disponivel: "Disponível", reservado: "Reservado", vendido: "Vendido" };
    const rows = [
      ["Área", (f) => f.facts.area],
      ["Quartos", (f) => f.facts.quartos],
      ["Suítes", (f) => f.facts.suites],
      ["Vagas", (f) => f.facts.vagas],
      ["Status", (f) => status[f.facts.avail] || "—"],
    ];
    return `<div class="fpj-compare" style="--cols:${favs.length}">
      <div class="fpj-cell fpj-cell--h"></div>${favs.map((f) => `
      <div class="fpj-cell fpj-cell--h"><button class="fpj-unit" data-act="open-unit" data-id="${f.id}">${esc(f.facts.label)}</button></div>`).join("")}
      ${rows.map(([lbl, fn]) => `<div class="fpj-cell fpj-cell--k">${lbl}</div>${favs.map((f) => `<div class="fpj-cell">${esc(fn(f) ?? "—")}</div>`).join("")}`).join("")}
      <div class="fpj-cell fpj-cell--k fpj-cell--end"></div>${favs.map((f) => `
      <div class="fpj-cell fpj-cell--end"><button class="fpj-unfav" data-act="unfav" data-id="${f.id}" aria-label="Remover ${esc(f.facts.label)} dos favoritos">${ICON.x}<span>Remover</span></button></div>`).join("")}
    </div>`;
  }

  function onJourneyClick(e) {
    const el = e.target.closest("[data-act]");
    if (!el) return;
    const act = el.dataset.act;
    if (act === "close") closeJourney();
    if (act === "prio") {
      const d = el.dataset.dim;
      const set = new Set(S.declared.priorities);
      set.has(d) ? set.delete(d) : set.add(d);
      track("preference_answered", null, { priorities: Array.from(set), source: "journey" });
    }
    if (act === "rec") {
      const it = CATALOG.get(el.dataset.id);
      track("recommendation_clicked", it.id, { source: "journey" });
      closeJourney();
      runAction(it);
    }
    if (act === "open-unit") { closeJourney(); runAction(CATALOG.get(el.dataset.id)); }
    if (act === "unfav") track("favorite_removed", el.dataset.id, { source: "journey" });
    if (act === "guide") setGuide(el.checked);
    if (act === "remember") { S.remember = el.checked; save(); }
    if (act === "reset") {
      const remember = S.remember;
      S = freshState();
      S.remember = remember;
      save();
      renderBadge();
      renderJourney();
      syncFavButton();
    }
    if (act === "contact") { closeJourney(); document.getElementById("cta-visit")?.click(); }
  }

  /* ─── Favorito no painel do andar ────────────────────────────────────────── */

  let currentUnit = null;

  function mountFavButton() {
    const hero = document.getElementById("floor-panel-hero");
    if (!hero || document.getElementById("fl-fav-btn")) return;
    const btn = document.createElement("button");
    btn.id = "fl-fav-btn";
    btn.setAttribute("aria-pressed", "false");
    btn.innerHTML = ICON.heart + "<span>Salvar</span>";
    btn.addEventListener("click", () => {
      if (!currentUnit) return;
      track(S.favorites.includes(currentUnit) ? "favorite_removed" : "favorite_added", currentUnit, { source: "floor_panel" });
    });
    hero.appendChild(btn);
  }

  function syncFavButton() {
    const btn = document.getElementById("fl-fav-btn");
    if (!btn) return;
    const on = !!currentUnit && S.favorites.includes(currentUnit);
    btn.setAttribute("aria-pressed", String(on));
    btn.setAttribute("aria-label", on ? "Remover dos favoritos" : "Salvar nos favoritos");
    btn.querySelector("span").textContent = on ? "Salvo" : "Salvar";
    btn.hidden = !currentUnit || currentUnit === "unit_terreo";
  }

  /* ─── Lead: contexto do percurso (somente com autorização) ───────────────── */

  function mountLeadConsent() {
    const form = document.getElementById("lead-form");
    if (!form || document.getElementById("fp-lead-consent")) return;
    const label = document.createElement("label");
    label.className = "fp-lead-consent";
    label.innerHTML = '<input type="checkbox" id="fp-lead-consent" checked /> <span>Enviar meu percurso ao consultor (prioridades, interesses e favoritos)</span>';
    const submit = form.querySelector('button[type="submit"], button:not([type])');
    form.insertBefore(label, submit || null);
  }

  function leadContext() {
    const box = document.getElementById("fp-lead-consent");
    if (box && !box.checked) return {};
    const prof = profile();
    const interesses = Object.keys(DIMS)
      .filter((d) => prof.observed[d] > 0.15)
      .sort((a, b) => prof.observed[b] - prof.observed[a])
      .slice(0, 4)
      .map((d) => `${DIMS[d]} (${prof.confidence[d]})`);
    return {
      fp_stage: prof.stage,
      fp_prioridades: S.declared.priorities.map((d) => DIMS[d]),
      fp_interesses_observados: interesses,
      fp_favoritos: S.favorites.map((id) => CATALOG.get(id)?.facts?.label).filter(Boolean),
      fp_policy: CFG.policy,
      fp_session: S.session_id,
    };
  }

  /* ─── Inicialização ──────────────────────────────────────────────────────── */

  function init() {
    CATALOG = buildCatalog();
    ready = true;
    pending.splice(0).forEach(ingest);
    mountTopButton();
    mountFavButton();
    mountLeadConsent();
    setInterval(heartbeat, CFG.heartbeatMs);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) lastActivity = Date.now(); });
  }

  window.FPAI = {
    track(name, target, props) {
      if (name === "unit_viewed") { currentUnit = target; }
      track(name, target, props);
      if (name === "unit_viewed") syncFavButton();
    },
    leadContext,
    openJourney,
    closeJourney,
    debug() {
      return { state: JSON.parse(JSON.stringify(S)), profile: profile(), ranking: CATALOG ? rank(profile()) : [], config: CFG };
    },
    suggestNow() {
      const res = CATALOG && decide();
      if (res) { hideCard(); showCard(res.item, res.decision); }
      return res && res.decision;
    },
  };

  if (document.readyState === "complete") init();
  else window.addEventListener("load", init);
})();
