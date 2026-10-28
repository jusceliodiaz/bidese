# `fp-intelligence.js` — FirstPerson Adaptive Intelligence (Lemme)

> Vertical slice do plano *FirstPerson Adaptive Intelligence Engine* rodando 100% no navegador:
> **cena → evento → perfil → sugestão → impressão → feedback**. Sem dependências, sem build, sem LLM.
> Funciona via `file://`. O backend (FastAPI + Supabase + PostHog + CRM) do plano entra depois pelo `CFG.endpoint`.

---

## Arquivos

| Arquivo | Papel |
|---|---|
| `fp-intelligence.js` | Motor: catálogo, eventos, tempo ativo, perfil, política `rules-v1`, guia, missões, favoritos, resumo, contexto do lead |
| `ui-compose.css` (seção *FirstPerson · inteligência adaptativa*) | Pele dos componentes no design system do Compose |
| `script-bidesse-main.js` / `bidese.html` | Ganchos `window.FPAI?.track(...)` nos pontos reais da experiência |

Carregado logo depois de `script-bidesse-main.js`. Eventos emitidos antes do `load` ficam na fila e são processados quando o catálogo é montado (os dados `FLOOR_DATA` / `FP_DATA` vêm dos scripts inline).

## Interface na tela

- **Botão "Seu percurso"** (✦) ao lado do menu, com selo de progresso `n/5`.
- **Card de sugestão** (canto inferior esquerdo; no mobile, acima do dock): título, motivo verdadeiro, "Ver agora", "Agora não", "Desligar sugestões".
- **Pergunta de prioridades** (uma vez por sessão): até 3 dimensões.
- **Painel "Seu percurso"**: estágio, missões, prioridades editáveis, "O que observamos" (barras + confiança + evidências), favoritos com tabela de comparação, top 3 sugestões, switches (sugestões / lembrar neste dispositivo), "Recomeçar", CTA "Agendar visita com meu percurso".
- **"Salvar"** (♥) no painel do andar.
- **Consentimento no lead**: "Enviar meu percurso ao consultor" (marcado por padrão, pode desmarcar).

## Catálogo semântico (`lemme-2026-10-v1`)

Dimensões: `vista`, `area_externa`, `lazer`, `espaco`, `privacidade`, `acabamento`, `localizacao`, `seguranca`.

| Tipo | Origem | Ação ao sugerir |
|---|---|---|
| `scene_*` | `SCENE_META` (6 vistas aéreas) | `navigateTo(id)` |
| `unit_*` | `FLOOR_DATA` + `UNIT_FEATURES` | vai à Vista 1, liga overlays, `openFloorPanel(id)` |
| `typo_*` | `FP_DATA` + `TYPO_FEATURES` | abre painel de plantas na tipologia |
| `surr_*` | categorias do Entorno | `openMapModal()` + `setMapFilter(cat)` |
| `sec_*` | seções do painel Lemme | `openLemmePanel()` + `lmGoTo(id)` |
| `poi_*` | POIs da cena | só alimenta o perfil |
| `act_compare` / `act_contact` / `act_question` | ações | comparação, lead, pergunta |

> [!warning] Valores editoriais
> Os pesos 0–1 por item são hipóteses de partida e **precisam de revisão com o comercial**. As vistas
> `pool/garden/living/kitchen/room6` são ids legados — todas são órbitas aéreas; os títulos em `SCENE_META`
> descrevem o que cada capa mostra.

Unidade só é recomendada se `avail === "disponivel"` e se passa nos filtros declarados (`floorMatchesFilters`).

## Dicionário de eventos

| Evento | Onde é emitido | Peso |
|---|---|---|
| `scene_entered` | `startScene()` | 0,2 (só na 1ª entrada da vista) |
| `scene_engaged` | heartbeat: a cada 15 s de tempo ativo na vista (máx. 3 por vista) | 1 |
| `hotspot_opened` | `showPoiCard()` | 1 |
| `unit_viewed` | `openFloorPanel()` | 1,5 |
| `typology_viewed` | `loadFpData()` | 1,2 |
| `surroundings_opened` | `openMapModal()` | marco |
| `surroundings_filtered` | `setMapFilter(cat ≠ all)` | 1 |
| `section_viewed` | `lmGoTo()` | 0,8 |
| `filter_changed` | `applyFloorFilters()` | restrição declarada |
| `favorite_added` / `favorite_removed` | botão ♥ / painel | 3 / −2 (negativa separada) |
| `comparison_opened` | painel com ≥2 favoritos | marco |
| `preference_answered` | pergunta / chips do painel | declarado |
| `recommendation_impression` / `_clicked` / `_dismissed` | card visível / clique / descarte | denominador / 1 / −0,5 |
| `contact_requested` | submit do lead | estágio `contact` |

**Envelope:** `event_id` (UUID), `schema_version`, `session_id`, `name`, `target_id`, `occurred_at`, `properties`.
Repetição do mesmo alvo em menos de 3 s é ignorada. Tempo ativo pausa com aba oculta, sem foco, 30 s sem interação, modal aberto ou transição.

## Perfil

- **Observado:** `afinidade(d) = pos / (2 + pos + neg)` com decaimento `exp(−ln2 · idade / 7 dias)` e teto de 4 por alvo × dimensão (repetição não infla).
- **Declarado:** prioridades (sobrepõem sinais fracos: afinidade mínima 0,8 no ranking) e filtros.
- **Confiança:** `alta` (≥3 alvos e afinidade ≥0,5, ou declarada + observada) · `media` (2 alvos) · `baixa` (1) · `declarada`.
- **Estágio:** `discovery` → `exploration` (≥2 temas e ≥3 alvos) → `comparison` (≥2 favoritos ou ≥2 andares vistos) → `contact`.

## Política `rules-v1`

```text
score = 0,50 × afinidade + 0,20 × adequação_ao_estágio + 0,15 × novidade + 0,15 × diversidade − 0,30 × já_visto
```

Cada decisão guarda candidatos (top 6), scores, estágio, motivo e versão. O motivo sempre aponta evidência real:
"Você marcou vista como prioridade" › "Você explorou 3 pontos ligados a lazer" › editorial.

**Guia:** primeiro convite após 40 s e ≥2 sinais; cooldown 45 s (cresce 50% a cada descarte); máx. 3 por sessão;
só com 4 s sem interação, sem modal/painel/transição/tour; some sozinho em 16 s; some se um painel abrir.

## Dados e privacidade

- Estado em `sessionStorage` (aba). `localStorage` só com "Lembrar neste dispositivo".
- Nada sai do navegador, exceto o resumo junto do lead **se a caixa estiver marcada** (`fp_stage`, `fp_prioridades`, `fp_interesses_observados`, `fp_favoritos`, `fp_policy`, `fp_session`).
- `track('lead_submit')` não envia mais nome, e-mail e telefone para o analytics.
- Sem inferência de renda, família ou personalidade: só preferências sobre o imóvel.

## Testar

- `bidese.html?fpai=fast` — timers curtos (convites em segundos).
- Console: `FPAI.debug()` (estado, perfil, ranking), `FPAI.suggestNow()`, `FPAI.openJourney()`.

## Ligar ao backend (próximas fases do plano)

1. Definir `CFG.endpoint` (ex.: `/api/events`) — o motor já envia o envelope por `sendBeacon` com `policy_version` e `catalog_version`.
2. Implementar ingestão idempotente (Supabase + RLS + outbox) e PostHog no worker — seção 8 do plano.
3. Mover a decisão para `POST /v1/next-action` quando houver dados; o card continua igual.
4. Integrar resultados do CRM (`visit_scheduled`, `proposal_created`) para calibrar pesos e rodar experimento baseline × personalização.
