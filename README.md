# ads-swipe

Scrapa a Facebook Ads Library e gera um swipe file estático no GitHub Pages.

Filtra apenas ads com **100+ creatives** usando o mesmo criativo — sinal forte de que o ad está convertendo.

---

## Pré-requisitos

- Node.js 18+
- npm

---

## 1. Instalar dependências

```bash
cd ads-swipe
npm install
npx playwright install chromium
```

---

## 2. Rodar o scraper

```bash
node scraper.js
```

O browser vai abrir em modo visível (headless: false). O scraper vai:
- Rolar a página 10x com delay de ~2.5s entre scrolls
- Coletar todos os ad cards
- Filtrar os que têm ≥ 100 creatives usando o mesmo criativo
- Salvar em `data/ads.json`

Se for interrompido com `Ctrl+C`, salva o progresso antes de sair.

**Se o Facebook pedir login**, o scraper para e avisa no terminal. Nesse caso, não há solução sem autenticação.

---

## 3. Abrir o site localmente

Opção A — com `serve`:
```bash
npx serve .
# abra http://localhost:3000/site
```

Opção B — abrir direto no browser:
```bash
open site/index.html
# Nota: fetch('../data/ads.json') pode falhar via file:// em alguns browsers.
# Prefira a opção A.
```

---

## 4. Deploy no GitHub Pages

1. Faça push do projeto para um repositório GitHub
2. Vá em **Settings → Pages**
3. Em "Source", selecione **Deploy from a branch**
4. Branch: `main` (ou `master`), pasta: **`/site`** — clique em Save
5. Aguarde ~1 min e acesse `https://<seu-usuario>.github.io/<repo>/`

> O arquivo `data/ads.json` precisa estar commitado junto com o `site/` para o GitHub Pages servir os dados.

---

## Customizar a busca

Edite a constante `TARGET_URL` no topo do `scraper.js` para mudar:
- `q=weight+loss` → qualquer keyword
- `country=US` → qualquer país
- `active_status=active` → `all` para incluir inativos

Edite `MIN_CREATIVE_COUNT` para mudar o filtro mínimo (padrão: 100).

---

## Estrutura

```
ads-swipe/
  scraper.js       # Playwright scraper
  package.json
  data/
    ads.json       # Output do scraper
  site/
    index.html     # Swipe file estático
  README.md
```
