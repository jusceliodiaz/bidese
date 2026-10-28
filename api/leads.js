// POST /api/leads — formulário "Agendar visita".
// Grava no Supabase (fonte da verdade), envia ao RD Station e registra no PostHog sem dados pessoais.

const L = require("./_lib");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

module.exports = async (req, res) => {
  if (!L.guard(req, res, ["POST"])) return;

  if (L.rateLimited("lead:" + L.clientIp(req), 5, 10 * 60 * 1000)) {
    return res.status(429).json({ ok: false, error: "too_many_requests" });
  }

  const b = L.body(req, 8 * 1024);
  if (!b || b.__tooLarge) return res.status(400).json({ ok: false, error: "invalid_body" });

  // honeypot: campo invisível que só robô preenche — finge sucesso
  if (L.str(b.website, 200)) return res.status(200).json({ ok: true });

  const email = L.str(b.email, 160).toLowerCase();
  const whatsapp = L.str(b.whatsapp || b.fone, 40).replace(/[^\d+]/g, "");
  const lead = {
    project: L.str(b.project, 60) || "Lemme",
    nome: L.str(b.nome || b.name, 120),
    email: EMAIL_RE.test(email) ? email : null,
    whatsapp: whatsapp.length >= 10 ? whatsapp : null,
    tipologia: L.str(b.tipologia || b.interesse, 80) || null,
    scene: L.str(b.scene, 40) || null,
    origem: L.str(req.headers.referer || "", 200) || null,
    fp_session: L.UUID_RE.test(b.fp_session || "") ? b.fp_session : null,
    fp_stage: L.str(b.fp_stage, 20) || null,
    fp_prioridades: L.strList(b.fp_prioridades, 8, 40),
    fp_interesses: L.strList(b.fp_interesses_observados, 8, 60),
    fp_favoritos: L.strList(b.fp_favoritos, 10, 40),
    fp_policy: L.str(b.fp_policy, 20) || null,
  };

  if (lead.nome.length < 2) return res.status(422).json({ ok: false, error: "nome_obrigatorio" });
  if (!lead.email && !lead.whatsapp) return res.status(422).json({ ok: false, error: "contato_obrigatorio" });

  if (!L.supabaseReady()) {
    console.error("leads: SUPABASE_URL/SUPABASE_SECRET_KEY não configurados");
    return res.status(503).json({ ok: false, error: "not_configured" });
  }

  let saved;
  try {
    [saved] = await L.supabase("leads?select=id", { body: lead, prefer: "return=representation" });
  } catch (e) {
    console.error("leads: falha ao gravar", e.message);
    return res.status(502).json({ ok: false, error: "storage_failed" });
  }

  // CRM e analytics depois do lead garantido no banco; falhas aqui não perdem o lead
  const crm = await L.rdStationConversion(lead);
  try {
    await L.supabase("leads?id=eq." + saved.id, {
      method: "PATCH",
      body: { crm: "rd_station", crm_status: crm.status, crm_error: crm.error || null },
      prefer: "return=minimal",
    });
  } catch (e) {
    console.error("leads: falha ao registrar status do CRM", e.message);
  }

  await L.posthog([{
    event: "lead_created",
    distinct_id: lead.fp_session || saved.id,
    properties: {
      lead_id: saved.id,
      scene: lead.scene,
      tipologia: lead.tipologia,
      fp_stage: lead.fp_stage,
      fp_context: !!lead.fp_session,
      crm_status: crm.status,
    },
  }]);

  return res.status(200).json({ ok: true, id: saved.id });
};
