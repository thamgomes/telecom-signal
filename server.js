'use strict';

const express   = require('express');
const cors      = require('cors');
const iconv     = require('iconv-lite');
const RssParser = require('rss-parser');
const https     = require('https');
const http      = require('http');
const fs        = require('fs');
const path      = require('path');

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.static(__dirname));

// Agente HTTPS sem verificacao de cert (para Anatel/Fundamentus)
const agentInsecure = new https.Agent({ rejectUnauthorized: false });

// Cache
const CACHE = {};
function getCache(k)              { return CACHE[k] || null; }
function setCache(k, data, ttlMs) { CACHE[k] = { data, ts: Date.now(), ttlMs }; }
function isFresh(e)               { return e && (Date.now() - e.ts) < e.ttlMs; }

// Fetch helper com timeout
function fetchUrl(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const timeout = opts.timeout || 15000;
    const parsed  = new URL(url);
    const lib     = parsed.protocol === 'https:' ? https : http;
    const reqOpts = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method:   'GET',
      headers:  opts.headers || { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124' },
      agent:    opts.insecure ? agentInsecure : undefined,
    };

    const req = lib.request(reqOpts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({ status: res.statusCode, buf });
      });
    });
    req.setTimeout(timeout, () => { req.destroy(); reject(new Error('Timeout ' + url)); });
    req.on('error', reject);
    req.end();
  });
}

async function fetchJson(url, opts = {}) {
  const { buf } = await fetchUrl(url, opts);
  return JSON.parse(buf.toString('utf8'));
}

async function fetchText(url, opts = {}) {
  const { buf, status } = await fetchUrl(url, opts);
  const enc = opts.encoding || 'utf8';
  return { text: iconv.decode(buf, enc), status };
}

// B3 - Yahoo Finance + Fundamentus (BRST3)
const YAHOO_STOCKS = [
  { sym:'VIVT3.SA', name:'Vivo (Telefonica)', display:'VIVT3', color:'#4A9AF5' },
  { sym:'TIMS3.SA', name:'TIM Brasil',        display:'TIMS3', color:'#4B6FD5' },
  { sym:'OIBR3.SA', name:'Oi',               display:'OIBR3', color:'#F5C518' },
];

async function fetchYahooStock(sym) {
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${sym}?range=1d&interval=1d`;
  const json = await fetchJson(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/json',
      'Referer': 'https://finance.yahoo.com/',
    },
  });
  const meta = json?.chart?.result?.[0]?.meta;
  if (!meta) throw new Error('Sem dados para ' + sym);
  return {
    symbol:                    sym.replace('.SA',''),
    regularMarketPrice:        meta.regularMarketPrice,
    regularMarketChangePercent: meta.regularMarketChangePercent ?? 0,
    regularMarketVolume:       meta.regularMarketVolume ?? 0,
    previousClose:             meta.previousClose,
  };
}

async function fetchBrst3Fundamentus() {
  const { text } = await fetchText('https://www.fundamentus.com.br/detalhes.php?papel=BRST3', {
    insecure: true,
    encoding: 'latin1',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      'Accept': 'text/html',
      'Referer': 'https://www.fundamentus.com.br/resultado.php',
    },
  });

  const spans = [...text.matchAll(/<span[^>]*>([\d]+[,.][\d]+)<\/span>/g)];
  if (!spans.length) throw new Error('BRST3: nenhum span numerico no Fundamentus');

  const price  = parseFloat(spans[0][1].replace(',', '.'));
  const min52w = spans[1] ? parseFloat(spans[1][1].replace(',', '.')) : null;
  const max52w = spans[2] ? parseFloat(spans[2][1].replace(',', '.')) : null;

  const dateMatch = text.match(/Data\s+[uU]lt\s+cot[\s\S]{0,100}?(\d{2}\/\d{2}\/\d{4})/i);
  const lastDate  = dateMatch ? dateMatch[1] : null;

  if (!price || isNaN(price)) throw new Error('BRST3: preco invalido no Fundamentus');

  return {
    symbol:                     'BRST3',
    regularMarketPrice:         price,
    regularMarketChangePercent: 0,
    regularMarketVolume:        0,
    min52w, max52w, lastDate,
    source: 'Fundamentus',
    brisanet: true,
  };
}

app.get('/api/b3', async (req, res) => {
  const cached = getCache('b3');
  if (isFresh(cached)) return res.json(cached.data);

  const results = await Promise.allSettled([
    fetchBrst3Fundamentus(),
    ...YAHOO_STOCKS.map(s => fetchYahooStock(s.sym)),
  ]);

  const stocks = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      stocks.push(r.value);
    } else {
      const name = i === 0 ? 'BRST3' : YAHOO_STOCKS[i - 1].display;
      console.warn('[B3] ' + name + ': ' + r.reason?.message);
    }
  });

  const data = { results: stocks, fetchedAt: new Date().toISOString() };
  setCache('b3', data, 5 * 60 * 1000);
  res.json(data);
});

// RSS News
const RSS_FEEDS = [
  { name:'Teletime',            url:'https://teletime.com.br/feed/',                color:'#4A9AF5' },
  { name:'TeleSintese',         url:'https://telesintese.com.br/feed/',             color:'#A47FE0' },
  { name:'Convergencia Digital',url:'https://www.convergenciadigital.com.br/feed/', color:'#48CFAD' },
];
const rssParser = new RssParser({ timeout: 30000 });

app.get('/api/news', async (req, res) => {
  const cached = getCache('news');
  if (isFresh(cached)) return res.json(cached.data);

  const results = await Promise.allSettled(
    RSS_FEEDS.map(f =>
      rssParser.parseURL(f.url).then(feed =>
        (feed.items || []).slice(0, 50).map(item => ({
          title:  item.title?.trim(),
          link:   item.link,
          date:   item.pubDate || item.isoDate,
          source: f.name,
          color:  f.color,
        }))
      )
    )
  );

  let all = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') all = all.concat(r.value);
    else console.warn('[News] ' + RSS_FEEDS[i].name + ': ' + r.reason?.message);
  });
  all.sort((a, b) => new Date(b.date) - new Date(a.date));

  const data = { items: all, fetchedAt: new Date().toISOString() };
  setCache('news', data, 10 * 60 * 1000);
  res.json(data);
});

// Anatel - dados de assinantes
const GRUPO_MAP = {
  'TELEFONICA': { name:'Vivo (Telefonica)', color:'#4A9AF5' },
  'VIVO':       { name:'Vivo (Telefonica)', color:'#4A9AF5' },
  'TIM':        { name:'TIM Brasil',        color:'#4B6FD5' },
  'CLARO':      { name:'Claro',             color:'#CC1E1E' },
  'OI':         { name:'Oi',               color:'#F5C518' },
  'ALGAR':      { name:'Algar Telecom',     color:'#48CFAD' },
  'BRISANET':   { name:'Brisanet',          color:'#F05424', brisanet:true },
  'SKY':        { name:'Sky',               color:'#5CC8FF' },
  'SERCOMTEL':  { name:'Sercomtel',         color:'#8896B4' },
  'DESKTOP':    { name:'Desktop / Conexis', color:'#48CFAD' },
  'COPEL':      { name:'Copel Telecom',     color:'#A47FE0' },
};

function resolveGroup(g) {
  const up = (g || '').toUpperCase().trim();
  for (const [key, val] of Object.entries(GRUPO_MAP)) {
    if (up.includes(key)) return val;
  }
  return null;
}

const FALLBACK = {
  source: 'fallback',
  ref: 'SMP e SCM: Jun/2026 (Anatel dados abertos)',
  // Fonte: Anatel SMP (Telefonia Movel) - Jun/2026
  mobile: [
    { name:'Vivo (Telefonica)', subs:105.13, color:'#4A9AF5' },
    { name:'Claro',             subs: 92.26, color:'#CC1E1E' },
    { name:'TIM Brasil',        subs: 61.88, color:'#4B6FD5' },
    { name:'Algar Telecom',     subs:  5.31, color:'#48CFAD' },
    { name:'Datora (MVNO)',     subs:  4.12, color:'#8B92A5' },
    { name:'Surf Telecom',      subs:  3.51, color:'#5CC8FF' },
    { name:'Brisanet',          subs:  1.07, color:'#F05424', brisanet:true },
    { name:'Outros',            subs:  4.53, color:'#3A4A6A' },
  ],
  // Fonte: Anatel SCM (Banda Larga Fixa) - Jun/2026
  fixed: [
    { name:'Claro',             subs:10.81, color:'#CC1E1E' },
    { name:'Vivo (Telefonica)', subs: 8.41, color:'#4A9AF5' },
    { name:'Oi',                subs: 3.43, color:'#F5C518' },
    { name:'Brisanet',          subs: 1.58, color:'#F05424', brisanet:true },
    { name:'Brasil Tecpar',     subs: 1.37, color:'#48CFAD' },
    { name:'Giga+ Fibra',       subs: 1.31, color:'#22C97A' },
    { name:'Vero',              subs: 1.31, color:'#5CC8FF' },
    { name:'Desktop / Conexis', subs: 1.20, color:'#8B92A5' },
    { name:'TIM Brasil',        subs: 0.91, color:'#4B6FD5' },
    { name:'Unifique',          subs: 0.89, color:'#A47FE0' },
    { name:'Algar Telecom',     subs: 0.84, color:'#F5A623' },
    { name:'Alares',            subs: 0.81, color:'#48D1CC' },
    { name:'Outros ISPs',       subs:22.79, color:'#3A4A6A' },
  ],
};

async function discoverAnatelCsv(datasetId) {
  // Tenta multiplas abordagens para contornar bloqueios do servidor Anatel
  const attempts = [
    { url: 'https://dados.anatel.gov.br/api/3/action/package_show?id=' + datasetId, insecure: true },
    { url: 'http://dados.anatel.gov.br/api/3/action/package_show?id=' + datasetId,  insecure: false },
  ];

  let lastErr;
  for (const attempt of attempts) {
    try {
      const json = await fetchJson(attempt.url, {
        insecure: attempt.insecure,
        timeout: 20000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124',
          'Accept': 'application/json, */*',
          'Accept-Language': 'pt-BR,pt;q=0.9',
          'Connection': 'close',
        },
      });
      if (!json.success) throw new Error('CKAN retornou erro: ' + datasetId);

      const csvs = (json.result.resources || [])
        .filter(r => (r.format || '').toUpperCase() === 'CSV')
        .sort((a, b) => new Date(b.last_modified || b.created) - new Date(a.last_modified || a.created));

      if (!csvs.length) throw new Error('Sem CSVs: ' + datasetId);
      return csvs[0];
    } catch (e) {
      lastErr = e;
      console.warn('[Anatel] Tentativa falhou (' + attempt.url.slice(0,40) + '...): ' + e.message);
    }
  }
  throw lastErr;
}

async function parseAnatelCsv(csvUrl) {
  console.log('  CSV: ' + csvUrl);
  const { text } = await fetchText(csvUrl, { insecure: true, encoding: 'win1252', timeout: 60000 });

  const lines  = text.split('\n');
  const header = lines[0].split(';').map(h => h.replace(/"/g, '').trim().toLowerCase());

  const iGrupo = header.findIndex(h => h.includes('grupo') && h.includes('econ'));
  const iAcess = header.findIndex(h => h === 'acessos' || h.includes('acess'));

  if (iGrupo < 0 || iAcess < 0) {
    console.warn('  Colunas nao encontradas. Header: ' + header.join(' | '));
    throw new Error('Formato CSV inesperado');
  }

  const totals = {};
  for (let i = 1; i < lines.length; i++) {
    const row   = lines[i].split(';').map(c => c.replace(/"/g, '').trim());
    const grupo = row[iGrupo];
    const n     = parseInt((row[iAcess] || '').replace(/\D/g, ''), 10);
    if (!grupo || isNaN(n) || n === 0) continue;
    totals[grupo] = (totals[grupo] || 0) + n;
  }

  const grouped = {};
  let outros = 0;
  for (const [grupo, total] of Object.entries(totals)) {
    const op = resolveGroup(grupo);
    if (op) grouped[op.name] = { ...(grouped[op.name] || op), subs: ((grouped[op.name]?.subs || 0) + total) };
    else     outros += total;
  }

  const arr = Object.values(grouped)
    .map(op => ({ ...op, subs: Math.round(op.subs / 100000) / 10 }))
    .sort((a, b) => b.subs - a.subs);

  if (outros > 0) arr.push({ name:'Outros', subs: Math.round(outros / 100000) / 10, color:'#3A4A6A' });
  return arr;
}

async function fetchAnatel() {
  const cached = getCache('anatel');
  if (isFresh(cached)) return cached.data;

  try {
    console.log('[Anatel] Consultando CKAN...');
    const [resSMP, resSCM] = await Promise.all([
      discoverAnatelCsv('acessos-smp'),
      discoverAnatelCsv('acessos-scm'),
    ]);

    console.log('[Anatel] SMP: ' + resSMP.name);
    console.log('[Anatel] SCM: ' + resSCM.name);

    const [mobile, fixed] = await Promise.all([
      parseAnatelCsv(resSMP.url),
      parseAnatelCsv(resSCM.url),
    ]);

    const ref = new Date(resSMP.last_modified || Date.now())
      .toLocaleDateString('pt-BR', { month:'long', year:'numeric' });

    const data = { mobile, fixed, ref, source:'live' };
    setCache('anatel', data, 12 * 60 * 60 * 1000);
    return data;

  } catch (err) {
    console.warn('[Anatel] Falhou: ' + err.message + ' -> usando fallback Q1/2025');
    const data = { ...FALLBACK };
    setCache('anatel', data, 10 * 60 * 1000);
    return data;
  }
}

app.get('/api/anatel', async (req, res) => {
  try { res.json(await fetchAnatel()); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

// Vagas Brisanet - le do arquivo local vagas-brisanet.json
app.get('/api/vagas', (req, res) => {
  try {
    const filePath = path.join(__dirname, 'vagas-brisanet.json');
    const raw = fs.readFileSync(filePath, 'utf8');
    res.json(JSON.parse(raw));
  } catch (e) {
    res.status(500).json({ error: 'Arquivo vagas-brisanet.json nao encontrado ou invalido.' });
  }
});

// Noticias manuais Brisanet - le do arquivo local noticias-brisanet.json
app.get('/api/noticias-brisanet', (req, res) => {
  try {
    const filePath = path.join(__dirname, 'noticias-brisanet.json');
    const raw = fs.readFileSync(filePath, 'utf8');
    res.json(JSON.parse(raw));
  } catch (e) {
    res.json({ items: [] });
  }
});

app.get('/api/status', (_, res) => res.json({
  uptime: process.uptime().toFixed(0) + 's',
  cache: Object.entries(CACHE).map(([k, v]) => ({
    key: k, fresh: isFresh(v),
    ageMin: ((Date.now() - v.ts) / 60000).toFixed(1),
  })),
}));

// Start
app.listen(PORT, () => {
  console.log('\n  Telecom Signal Proxy rodando em http://localhost:' + PORT + '\n');
  console.log('  Fontes: Yahoo Finance + Fundamentus (BRST3) + RSS + Anatel CKAN\n');
  fetchAnatel().then(d => console.log('  [Anatel] ' + d.source + ' - ' + d.ref));
  fetchUrl('http://localhost:' + PORT + '/api/news').catch(() => {});
});

