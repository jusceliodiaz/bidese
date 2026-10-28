// POST /api/track — analytics legado do script-bidesse-main.js (track()).
// Repassa ao PostHog sem dados pessoais; não grava no banco.

const L = require("./_lib");

const EVENT_RE = /^[a-z0-9_]{1,60}$/i;

module.exports = async (req, res) => {
  if (!L.guard(req, res, ["POST"])) return;
  if (L.rateLimited("tr:" + L.clientIp(req), 600, 10 * 60 * 1000)) return res.status(429).end();

  const b = L.body(req, 8 * 1024);
  if (!b || b.__tooLarge || !EVENT_RE.test(b.event || "")) return res.status(400).end();

  const { event, session, ts, ...props } = b;
  await L.posthog([{
    event: "site_" + event,
    distinct_id: L.UUID_RE.test(session || "") ? session : "anonymous",
    timestamp: Number.isFinite(ts) ? new Date(ts).toISOString() : undefined,
    properties: props, // scrub() remove nome/email/telefone em _lib
  }]);
  return res.status(204).end();
};
