// POST /api/events — envelope de eventos do fp-intelligence.js (um evento ou { batch: [...] }).
// Idempotente: event_id é a chave primária; retry com o mesmo UUID não duplica.

const L = require("./_lib");

const NAMES = new Set([
  "scene_entered", "scene_engaged", "hotspot_opened", "unit_viewed", "typology_viewed",
  "surroundings_opened", "surroundings_filtered", "section_viewed", "filter_changed",
  "favorite_added", "favorite_removed", "comparison_opened", "preference_answered",
  "recommendation_impression", "recommendation_clicked", "recommendation_dismissed",
  "contact_requested", "journey_opened",
]);
const TARGET_RE = /^[a-z0-9_]{1,80}$/i;

function clean(ev) {
  if (!ev || typeof ev !== "object") return null;
  if (!L.UUID_RE.test(ev.event_id || "") || !L.UUID_RE.test(ev.session_id || "")) return null;
  if (!NAMES.has(ev.name)) return null;
  const t = Date.parse(ev.occurred_at);
  const now = Date.now();
  if (!t || t > now + 5 * 60 * 1000 || t < now - 2 * 86400000) return null; // janela de atraso aceitável
  const target = ev.target_id == null ? null : String(ev.target_id);
  if (target && !TARGET_RE.test(target)) return null;
  const props = L.scrub(ev.properties || {});
  if (JSON.stringify(props).length > 4096) return null;
  return {
    id: ev.event_id,
    session_id: ev.session_id,
    name: ev.name,
    target_id: target,
    occurred_at: new Date(t).toISOString(),
    schema_version: ev.schema_version === 1 ? 1 : 1,
    policy_version: L.str(ev.policy_version, 20) || null,
    catalog_version: L.str(ev.catalog_version, 40) || null,
    properties: props,
  };
}

module.exports = async (req, res) => {
  if (!L.guard(req, res, ["POST"])) return;

  if (L.rateLimited("ev:" + L.clientIp(req), 600, 10 * 60 * 1000)) {
    return res.status(429).json({ ok: false, error: "too_many_requests" });
  }

  const b = L.body(req, 32 * 1024);
  if (!b || b.__tooLarge) return res.status(400).json({ ok: false, error: "invalid_body" });

  const list = (Array.isArray(b.batch) ? b.batch : [b]).slice(0, 50).map(clean).filter(Boolean);
  if (!list.length) return res.status(422).json({ ok: false, error: "no_valid_events" });

  if (L.supabaseReady()) {
    try {
      await L.supabase("fp_events?on_conflict=id", {
        body: list,
        prefer: "resolution=ignore-duplicates,return=minimal",
      });
    } catch (e) {
      console.error("events: falha ao gravar", e.message);
      return res.status(502).json({ ok: false, error: "storage_failed" });
    }
  }

  await L.posthog(list.map((e) => ({
    event: "fp_" + e.name,
    distinct_id: e.session_id,
    uuid: e.id, // PostHog deduplica pelo uuid
    timestamp: e.occurred_at,
    properties: { ...e.properties, target_id: e.target_id, policy_version: e.policy_version, catalog_version: e.catalog_version },
  })));

  return res.status(202).json({ ok: true, accepted: list.length });
};
