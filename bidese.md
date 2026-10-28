# `bidese.html` — Edifício Lemme, Tour Virtual 3D

> Demo de experiência imobiliária archviz para o **Edifício Lemme** (Curitiba). Página standalone, sem dependência de `index.html`.

---

## Visão Geral

- **Título:** `Edifício Lemme | Tour Virtual 3D | Factory Studio`
- **URL de produção:** `https://www.factorystudio.works/bidese.html`
- **SEO:** `<meta name="robots" content="noindex, nofollow">` — página de demo, não indexada
- **Fontes:** DM Sans (300–600)
- **CSS:** 100% inline em `<style>` no próprio `bidese.html` + `styles.css` (compartilhado com `cityexplorer.html`)
- **GA:** `G-3K51DFTX3J`, lazy-loaded via `window.addEventListener('load', ...)`

---

## Dependências (ordem de carregamento)

```html
<link rel="stylesheet" href="styles.css" />
...
<script src="scenes-bidesse-main.js"></script>
<script src="images/bidesse/pano_living2_b64.js"></script>
<script src="script-bidesse-main.js"></script>
```

| Arquivo | Papel |
|---|---|
| `styles.css` | Reset, cursor customizado, `#stage`/`#track`/`#loader`, POI layer base — compartilhado com cityexplorer |
| `scenes-bidesse-main.js` | `CONFIG` global: timeline de cenas, POIs por cena, sequências de frames, mapa de transições |
| `images/bidesse/pano_living2_b64.js` | Exporta `window._PANO_LIVING2` (data URL base64 da imagem 360° do living) — workaround para `file://` |
| `script-bidesse-main.js` | Motor da experiência: scene player, sequence loader, POI cards, tour automático, track/nav, cursor, analytics |
| *(inline em `bidese.html`)* | Filtros de unidade, mapa de entorno (Leaflet-like SVG), modal panorama 360° (Three.js), overlays de andar (SVG sobre imagem aérea), painel de plantas, editor de overlays (dev tool) |

Não existe arquivo `bidesse_video.html`, `scenes-bidesse.js` ou `script-bidesse.js` — foram deletados e substituídos por `scenes-bidesse-main.js` / `script-bidesse-main.js`. Não referenciar esses nomes antigos.

---

## Estrutura HTML (`<body>`)

```
body
├── #top-bar                 → "LEMME · BIDESE" + botão filtros (mobile/desktop topo)
├── #cursor / #ring          → cursor customizado (desktop)
├── #noise                   → grain overlay
├── #stage
│   ├── #main-video          → vídeo loop de cena (muted, playsinline, preload=auto)
│   ├── #seq-canvas          → canvas para frame sequences (transições entre cenas)
│   └── #poi-layer           → POIs dinâmicos da cena atual
├── #scene-tag                → label da cena atual
├── #track                    → nav inferior (pill glass, arrows + label)
├── #filter-panel             → filtros de unidade (disponibilidade, quartos, banheiros, área)
├── #floor-svg                → overlay SVG de polígonos por andar sobre a imagem aérea
├── #floor-cta                → engrenagem no canto inferior direito (liga/desliga overlays + seleção na Vista 1)
├── #floor-panel-backdrop / #floor-panel   → drawer lateral com dados do andar clicado
├── #ov-edit-btn / #ov-export-panel        → editor de overlays (ferramenta interna, arraste handles)
├── #fp-toggle / #fp-panel    → painel de plantas baixas (por tipologia)
├── #loader                   → 3 spans animados
├── #debug-hud                → HUD de debug (hidden por padrão)
├── #cta-dock                 → botões Tour / Entorno
├── #map-modal                → modal "Entorno" (mini-mapa SVG + lista de POIs filtráveis)
├── #pano-modal                → modal 360° (Three.js WebGL)
├── #poi-card                  → card global de POI (posicionado via JS)
└── #lead-modal                → formulário de agendamento de visita
```

---

## `scenes-bidesse-main.js` — Configuração das Cenas

Define `const CONFIG = { timeline, scenes, sequences, transitions }` (global, sem `export`).

### `CONFIG.timeline`
6 cenas: `aerial`, `pool`, `garden`, `living`, `kitchen`, `room6` — cada uma com `{ id, label, icon }`.

### `CONFIG.scenes[id]`
- `cover` / `cover_m`: imagens de capa desktop/mobile (`images/bidesse/COVER_B1.jpg` … `COVER_B6.jpg`)
- `pois[]`: array de POIs da cena, com 2 tipos:

| `type` | Campos | Uso |
|---|---|---|
| `card-simple` | `label, x, y, accent, category, subcategory, title, description, car, walk` | Infraestrutura/localização — card sem imagem, com tempos de carro/caminhada |
| `card-complex` | `label, x, y, category, subcategory, title, description, image, pano360` | POIs com imagem + botão "Ver 360°" (abre `openPanoModal`) |

Atualmente apenas a cena `aerial` tem POIs (`PARKING` e `LOBBY`); as demais (`pool`, `garden`, `living`, `kitchen`, `room6`) têm `pois: []`.

### `CONFIG.sequences`
9 sequências de frames (`aerial-to-pool`, `pool-to-aerial`, `pool-to-garden`, `garden-to-pool`, `garden-to-living`, `living-to-garden`, `living-to-kitchen`, `kitchen-to-living`, `kitchen-to-room6`, `room6-to-kitchen`):
- `folder: "images/bidesse/"`, `folder_m: "images/bidesse/seq_arch_m/"`
- `prefix`: `BID_C1_` … `BID_C5_` (5 transições base, cada uma reaproveitada nos dois sentidos via `reverse: true`)
- `from: 0, to: 89, pad: 2, ext: "jpg", fps: 90` — 90 frames por transição

### `CONFIG.transitions`
Grafo linear de navegação: `aerial ⇄ pool ⇄ garden ⇄ living ⇄ kitchen ⇄ room6`.

---

## `script-bidesse-main.js` — Motor da Experiência

Funções principais (sem export, escopo global do script):

| Função | Responsabilidade |
|---|---|
| `sessionId()`, `track(event, props)` | Analytics customizado (sessão + eventos) |
| `markDwell(newScene)` | Mede tempo de permanência por cena |
| `resizeCanvas()` | Redimensiona `#seq-canvas` no resize |
| `sceneFromHash()` / `syncHash(sceneId)` | Deep-linking via `#hash` da URL |
| `videoSrc(scene)` | Resolve o vídeo de loop da cena atual |
| `preloadNeighbors(sceneId)` / `preloadAllVideos()` | Preload de vídeos das cenas vizinhas |
| `showPoster(src, cb)` | Mostra poster/cover enquanto vídeo carrega |
| `startScene(sceneId)` | Troca de cena — orquestra vídeo, POIs, track, tag |
| `fadeCanvas()` | Fade do canvas de sequência |
| `loadWithLoader(seqId)` / `rememberSeq()` / `preload(seqId)` | Carregamento e cache de sequências de frames |
| `playSequence(frames, reverse, gen, fps)` | Toca a sequência de frames da transição entre cenas |
| `drawCover(img)` | Desenha imagem de capa no canvas |
| `initPoiCard()` / `showPoiCard(poi, dotEl)` / `closePoiCard()` | Card global de POI — posicionamento e conteúdo |
| `renderPOIs(pois)` / `hidePOIs()` | Renderiza/oculta dots de POI na cena ativa |
| `openInfo(info)` | Abre painel de informação genérico |
| `buildTrack()` / `setActive(id)` | Constrói e atualiza a barra de navegação inferior |
| `startTour()` / `stopTour()` | Tour automático (avança cenas sozinho) — acionado pelo botão `#cta-tour` |
| `initCTA()` | Liga os botões do `#cta-dock`, abre `#lead-modal` |
| `initCursor()` | Cursor customizado desktop (`#cursor`/`#ring`) |

---

## Funcionalidades inline em `bidese.html`

### Top bar (`#top-bar`)
Barra fixa no topo: label "LEMME · BIDESE", botão de filtros (`#filter-toggle`) com indicador `.fi-dot` (visível quando há filtro ativo via classe `.has-active`).

### Filtros de Unidade (`#filter-panel`)
- Grupos: **Disponibilidade** (`disponivel`/`reservado`/`vendido` — cores verde/amarelo/vermelho via classes `.avail-*`), **Quartos** (1–3), **Banheiros** (1–2), **Área útil** (slider `40–200 m²`)
- `toggleFilterPanel()` — abre/fecha o painel
- `clearFilters()` — reseta todos os chips e o slider
- Chips usam `data-filter` + `data-val`, toggle de classe `.active`

### Overlays de Andar (`#floor-svg`)
- `FLOOR_IMG_W = 2920`, `FLOOR_IMG_H = 1643` — dimensões naturais de `COVER_B1.jpg` (usadas para mapear polígonos relativos `[0..1]` para coordenadas de tela)
- `FLOOR_DATA[]` — 8 andares (`cobertura`, `andar6` … `andar1`, `terreo`), cada um com `id, label, tipo, area, vagas, suites, status, desc, pdf, poly[]` (polígono normalizado sobre a imagem aérea da cena `aerial`)
- `imgToScreen(fx, fy)` — converte coordenada normalizada da imagem para pixel de tela, considerando `object-fit: cover`
- `buildFloorSVG()` — desenha os polígonos (`<polygon class="floor-poly">`) + labels sobre `#floor-svg`; clique abre `openFloorPanel(id)`
- `openFloorPanel(id)` / `closeFloorPanel()` — drawer lateral direito (`#floor-panel`) com tipologia, área, vagas, suítes, status, descrição e botão de download de PDF da planta (`#fl-pdf-btn`)
- Overlay só é visível/interativo na cena `aerial` (classe `.visible` em `#floor-svg`)
- Overlays começam **desligados** (`_floorOverlayOn = false`). Na cena `aerial`, a engrenagem `#floor-cta` (canto inferior direito, sutil) liga/desliga overlays + seleção — fica dourada (`.active`) quando ligada; o botão `#cta-overlay` do dock alterna o mesmo estado. `setFloorCtaVisible(v)` mostra/esconde a engrenagem (escondida durante transições e fora da Vista 1)

### Editor de Overlays (`#ov-edit-btn` / `#ov-export-panel`)
Ferramenta de desenvolvimento para reposicionar os vértices dos polígonos de `FLOOR_DATA` visualmente:
- `toggleOverlayEditor()` — ativa modo de edição, mostra handles arrastáveis (`.ov-handle`) em cada vértice
- `ovSelectFloor(id)` — seleciona qual andar editar no `<select id="ov-floor-select">`
- `ovApply()` — aplica posições arrastadas
- `ovCopyAll()` — copia o array `FLOOR_DATA` atualizado (formato JS) para clipboard, para colar de volta no código-fonte
- `ovResetFloor()` — desfaz alterações do andar ativo (restaura de `_ovOrigData`)
- Não é uma feature voltada ao usuário final — manter escondida (`display: none` por padrão, sem botão de acesso na UI pública)

### Painel de Plantas (`#fp-toggle` / `#fp-panel`)
- `toggleFpPanel()` — abre/fecha painel com seletor de tipologia (`tipo1`…`tipo5`: 134/162/189 m², Penthouse, Garden)
- Mostra imagem da planta baixa (`#fp-img`, placeholder se ausente), área útil, vagas, suítes, e botão de download de PDF (`#fp-pdf-btn`)

### Modal Entorno (`#map-modal`)
- Mini-mapa SVG (`#mini-map`) com ruas (`.street`), anéis de distância (`.ring-out`/`.ring-in`), pin central (`.center`) e pins de POI (`.pin`)
- Filtros por categoria: `all`, `educacao`, `saude`, `lazer`, `transporte` (`#map-filter-bar`)
- Lista de POIs (`#map-poi-list`) com ícone, nome, categoria, tempo
- `openMapModal()` — adiciona `.active` ao `#cta-surround`; `closeMapModal()` — remove
- Dados de POIs e categorias definidos inline no `<script>` do HTML (`POIS[]`, `MAP_CATS{}`)

### Modal Panorama 360° (`#pano-modal`)
- Three.js r160 via CDN, lazy-loaded na primeira chamada de `openPanoModal(src, title)`
- `SphereGeometry(100, 64, 32)` com `geo.scale(-1,1,1)` — renderiza de dentro da esfera
- `renderer.toneMapping = THREE.NoToneMapping`, `tex.colorSpace = THREE.NoColorSpace`
- **Workaround `file://`:** a imagem `pano_living2.jpg` é pré-convertida para base64 em `images/bidesse/pano_living2_b64.js`, exportando `window._PANO_LIVING2`. `openPanoModal()` usa esse data URL quando disponível — evita `SecurityError` do Chrome ao carregar textura via `file://`
- Drag/pinch/scroll para navegar; inércia (fator `0.88`)
- `closePanoModal()` — fecha via backdrop click, botão X ou Escape

### Lead Capture (`#lead-modal`)
- Formulário: Nome, E-mail, WhatsApp (`#lead-form`)
- Acionado a partir do `#cta-dock` (fluxo de agendamento de visita)
- Mensagem de sucesso `#lead-ok` (hidden por padrão)

### CTA Dock (`#cta-dock`)
Botões: `#cta-tour` (`startTour()`), `#cta-surround` (`openMapModal()`) — o assistente (`#cta-bot` / `#bot-popup`) foi removido
- Comportamento: ícone apenas por padrão; `.active` expande com texto via `max-width` transition

---

## Assets (`images/bidesse/`)

| Padrão | Descrição |
|---|---|
| `COVER_B1.jpg` … `COVER_B6.jpg` | Covers desktop das 6 cenas da timeline |
| `seq_arch_m/COVER_B1.jpg` … | Covers mobile otimizadas |
| `BID_C1_00.jpg` … `BID_C5_89.jpg` | 5 transições × 90 frames cada (sequências de câmera entre cenas) |
| `seq_arch_m/BID_C*_NN.jpg` | Versões mobile das sequências |
| `pano_living2.jpg` | Imagem equiretangular 360° (2752×1536) do living |
| `pano_living2_b64.js` | Versão base64 (`window._PANO_LIVING2`) — ~848KB, gerado via script Node.js, necessário para `file://` |

Para adicionar uma nova imagem 360°: gerar um novo arquivo `_b64.js` equivalente (script Node.js similar ao usado para `pano_living2_b64.js`) e referenciá-lo em um novo `<script src="images/bidesse/NOME_b64.js">` antes de `script-bidesse-main.js`.

---

## Padrões a Seguir

- Antes de editar `bidese.html`, `scenes-bidesse-main.js` ou `script-bidesse-main.js`, **ler o trecho com Read** para pegar a string exata com indentação
- Novo CSS: injetar no final do bloco `<style>` de `bidese.html`, antes de `</style>`
- Novas cenas/POIs: editar `CONFIG` em `scenes-bidesse-main.js`, nunca hardcode dentro do HTML
- Novos andares/overlays: editar `FLOOR_DATA` em `bidese.html` — usar o Editor de Overlays (`ovCopyAll()`) para gerar as coordenadas corretas em vez de estimar manualmente
- Accent sempre `#b89c6e` (dourado) — consistente com o resto do site
- Sem `box-shadow` decorativo além do já usado em modais/drawers (blur/glass já definidos)

## Padrões a Evitar

- Não referenciar `bidesse_video.html`, `scenes-bidesse.js`, `script-bidesse.js` — arquivos deletados, substituídos por `scenes-bidesse-main.js` e `script-bidesse-main.js`
- Não usar `THREE.TextureLoader` diretamente — falha em Chrome com `file://` (CORS)
- Não usar `<img>` + `THREE.Texture(img)` diretamente — `texSubImage2D` SecurityError em Chrome `file://`
- Não usar `fetch()`/`XHR` para carregar imagens locais em `file://` — bloqueado pelo Chrome (origin null)
- Não expor o Editor de Overlays (`#ov-edit-btn`) na UI pública — é ferramenta de desenvolvimento
- Não trocar DM Sans por Inter — `bidese.html` segue o padrão de `cityexplorer.html`

---

*Gerado a partir do código-fonte em `bidese.html`, `scenes-bidesse-main.js` e `script-bidesse-main.js` — 02/07/2026.*
