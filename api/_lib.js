// Utilitários compartilhados das funções /api (Vercel Node, sem dependências).
// O prefixo "_" impede o Vercel de publicar este arquivo como rota.
// Segredos só via process.env — nunca enviados ao navegador nem escritos em log.

const env = (k) => (process.env[k] || "").trim();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PII_KEYS = /^(nome|name|email|e-mail|whatsapp|telefone|phone|mobile|cpf|endereco|address)$/i;

/* ─── Requisição ─────────────────────────────────────────────────────────── */

function allowedOrigin(req) {
  const origin = req.headers.origin || "";
  const list = env("ALLOWED_ORIGINS").split(",").map((s) => s.trim()).filter(Boolean);
  // mesma origem do deploy (inclui URLs de preview do Vercel)
  const host = req.headers["x-forwarded-host"] || req.headers.host || "";
  if (origin && host && origin === "https://" + host) return origin;
  return list.includes(origin) ? origin : null;
}

// Aplica CORS restrito; responde preflight; bloqueia métodos e origens não permitidos.
function guard(req, res, methods = ["POST"]) {
  const origin = allowedOrigin(req);
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", methods.concat("OPTIONS").join(", "));
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.method === "OPTIONS") { res.status(origin ? 204 : 403).end(); return false; }
  if (!methods.includes(req.method)) { res.status(405).json({ ok: false, error: "method_not_allowed" }); return false; }
  if (!origin) { res.status(403).json({ ok: false, error: "origin_not_allowed" }); return false; }
  return true;
}

// Corpo JSON com limite de tamanho (sendBeacon chega como text/plain).
function body(req, maxBytes) {
  let raw = req.body;
  if (raw == null) return null;
  if (typeof raw !== "string") raw = Buffer.isBuffer(raw) ? raw.toString("utf8") : JSON.stringify(raw);
  if (Buffer.byteLength(raw, "utf8") > maxBytes) return { __tooLarge: true };
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? v : null;
  } catch (_) {
    return null;
  }
}

function clientIp(req) {
  return String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").split(",")[0].trim();
}

// Rate limit por IP em memória da instância (best effort: instâncias frias zeram).
const buckets = new Map();
function rateLimited(key, limit, windowMs) {
  const now = Date.now();
  const b = buckets.get(key) || { n: 0, reset: now + windowMs };
  if (now > b.reset) { b.n = 0; b.reset = now + windowMs; }
  b.n += 1;
  buckets.set(key, b);
  if (buckets.size > 5000) buckets.clear();
  return b.n > limit;
}

/* ─── Saneamento ─────────────────────────────────────────────────────────── */

const str = (v, max) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max) : "");
const strList = (v, maxItems, maxLen) => (Array.isArray(v) ? v.map((x) => str(x, maxLen)).filter(Boolean).slice(0, maxItems) : []);

// Remove chaves com dados pessoais e limita profundidade/tamanho de propriedades.
function scrub(obj, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 2) return {};
  const out = {};
  Object.keys(obj).slice(0, 30).forEach((k) => {
    if (PII_KEYS.test(k)) return;
    const v = obj[k];
    if (v == null || typeof v === "number" || typeof v === "boolean") out[k] = v;
    else if (typeof v === "string") out[k] = v.slice(0, 200);
    else if (Array.isArray(v)) out[k] = v.slice(0, 20).map((x) => (typeof x === "object" ? scrub(x, depth + 1) : x));
    else if (typeof v === "object") out[k] = scrub(v, depth + 1);
  });
  return out;
}

/* ─── Supabase (REST, chave secreta do servidor) ─────────────────────────── */

function supabaseReady() {
  return !!(env("SUPABASE_URL") && env("SUPABASE_SECRET_KEY"));
}

async function supabase(path, { method = "POST", body: payload, prefer } = {}) {
  const key = env("SUPABASE_SECRET_KEY");
  const r = await fetch(env("SUPABASE_URL") + "/rest/v1/" + path, {
    method,
    headers: {
      apikey: key,
      Authorization: "Bearer " + key,
      "Content-Type": "application/json",
      ...(prefer ? { Prefer: prefer } : {}),
    },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`supabase ${r.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

/* ─── PostHog (captura no servidor, sem dados pessoais) ──────────────────── */

async function posthog(events) {
  const token = env("POSTHOG_PROJECT_TOKEN");
  if (!token || !events.length) return;
  try {
    await fetch((env("POSTHOG_HOST") || "https://us.i.posthog.com") + "/batch/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: token,
        batch: events.map((e) => ({
          event: e.event,
          distinct_id: e.distinct_id,
          timestamp: e.timestamp || new Date().toISOString(),
          ...(e.uuid ? { uuid: e.uuid } : {}),
          properties: { $process_person_profile: false, $lib: "bidese-api", ...scrub(e.properties || {}) },
        })),
      }),
    });
  } catch (_) {
    // analytics nunca derruba a requisição principal
  }
}

/* ─── RD Station Marketing (conversão) ───────────────────────────────────── */

const slug = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

async function rdStationConversion(lead) {
  const key = env("RD_STATION_API_KEY");
  if (!key) return { status: "skipped", error: "RD_STATION_API_KEY ausente" };
  if (!lead.email) return { status: "skipped", error: "RD exige e-mail" };
  const tags = ["tour-lemme"]
    .concat(lead.fp_prioridades.map((p) => "prioridade-" + slug(p)))
    .concat(lead.fp_favoritos.map((f) => "favorito-" + slug(f)))
    .slice(0, 15);
  try {
    const r = await fetch("https://api.rd.services/platform/conversions?api_key=" + encodeURIComponent(key), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event_type: "CONVERSION",
        event_family: "CDP",
        payload: {
          conversion_identifier: env("RD_STATION_CONVERSION") || "tour-lemme-agendar-visita",
          name: lead.nome,
          email: lead.email,
          ...(lead.whatsapp ? { mobile_phone: lead.whatsapp } : {}),
          tags,
          available_for_mailing: false,
        },
      }),
    });
    if (r.ok) return { status: "sent" };
    return { status: "failed", error: `rd ${r.status}: ${(await r.text()).slice(0, 180)}` };
  } catch (e) {
    return { status: "failed", error: "rd " + String(e.message || e).slice(0, 180) };
  }
}

module.exports = {
  env, UUID_RE, guard, body, clientIp, rateLimited, str, strList, scrub,
  supabaseReady, supabase, posthog, rdStationConversion,
};
