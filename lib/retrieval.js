// BM25 pretraga nad indeksom priručnika (isti algoritam kao u stranici).
const DIA = { 'č': 'c', 'ć': 'c', 'đ': 'd', 'š': 's', 'ž': 'z' };
const STOP = new Set('i u na za je se da su od do o kako sto što koji koja koje kad ako ili ali te ne mi vi ga ih im ju mu li ce će bi biti sam ste smo ovo to taj ta te ovaj ova ove kod pri po iz s sa kao može mogu moze više vise samo vozilo vozila vozilu'.split(' '));
const SYN = { lampica: 'svjetlo upozorenja indikator', lampice: 'svjetlo upozorenja indikator', zaruljica: 'svjetlo upozorenja indikator', ikona: 'indikator svjetlo', uskličnik: 'upozorenja', uskličnikom: 'upozorenja', uskicnik: 'upozorenja', guma: 'pneumatik', gume: 'pneumatik', gumama: 'pneumatik', mobitel: 'telefon bluetooth', bluetooth: 'handsfree', servis: 'održavanje raspored', pregrijava: 'pregrije pregrijavanje temperatura', akumulator: 'baterija sustav punjenja', akumulatora: 'baterija sustav punjenja', tempomat: 'cruise control', kljuc: 'ključ pametni', klima: 'klima uređaj grijanje ventilacija', brisaci: 'brisač', brisači: 'brisač', puni: 'punjenje punjač', napuniti: 'punjenje punjač', napunim: 'punjenje punjač', puniti: 'punjenje punjač', baterija: 'visokonaponska baterija akumulator', bateriju: 'visokonaponska baterija akumulator', baterije: 'visokonaponska baterija akumulator', struja: 'punjenje električni', doseg: 'domet autonomija', potrosnja: 'potrošnja goriva', ulje: 'motorno ulje', svjetla: 'prednja svjetla farovi', farovi: 'prednja svjetla', kocnica: 'kočnica kočnice', kočnica: 'kočnice kočni' };

const norm = s => s.toLowerCase().replace(/[čćđšž]/g, c => DIA[c]).replace(/[^a-z0-9 ]+/g, ' ');
const stem = w => w.length > 7 ? w.slice(0, 7) : w.length > 5 ? w.slice(0, 5) : w;
const toks = s => norm(s).split(' ').filter(w => w.length > 1 && !STOP.has(w)).map(stem);
const expand = s => s + ' ' + norm(s).split(' ').map(w => SYN[w] || '').join(' ');

export function buildIndex(docs) {
  const N = docs.length, df = new Map(), tf = [], len = []; let avg = 0;
  docs.forEach((d, i) => {
    const t = toks([d.h1, d.h1, d.h2, d.h2, d.h3, d.h3, d.h3, d.t].join(' '));
    const m = new Map(); t.forEach(w => m.set(w, (m.get(w) || 0) + 1));
    tf[i] = m; len[i] = t.length; avg += t.length; m.forEach((_, w) => df.set(w, (df.get(w) || 0) + 1));
  });
  avg /= N || 1;
  return { docs, N, df, tf, len, avg };
}

export function search(idx, q, k = 10) {
  const { docs, N, df, tf, len, avg } = idx;
  const qt = [...new Set(toks(expand(q)))]; const sc = new Float64Array(N);
  qt.forEach(w => {
    const n = df.get(w); if (!n) return; const idf = Math.log(1 + (N - n + .5) / (n + .5));
    for (let i = 0; i < N; i++) { const f = tf[i].get(w); if (!f) continue; sc[i] += idf * (f * 2.2) / (f + 1.2 * (1 - .75 + .75 * len[i] / avg)); }
  });
  const nq = norm(q).trim();
  if (nq.length > 6) for (let i = 0; i < N; i++) if (norm(docs[i].t).includes(nq)) sc[i] *= 1.5;
  return [...sc.keys()].filter(i => sc[i] > 0).sort((a, b) => sc[b] - sc[a]).slice(0, k).map(i => docs[i]);
}

// Reciprocal-rank spajanje više upita
export function searchMulti(idx, queries, k = 10, opts = {}) {
  const score = new Map();
  const byId = new Map(idx.docs.map(d => [d.i, d]));
  const isSteps = d => /(^|\s)1\.\s.+\s2\.\s/.test(d.t);
  queries.filter(Boolean).forEach((q, qi) => {
    search(idx, q, k + 6).forEach((d, r) => { let w = (qi === 0 ? 1.3 : 1) / (r + 6); if (opts.howTo && isSteps(d)) w *= 1.6; score.set(d.i, (score.get(d.i) || 0) + w); });
  });
  return [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, k).map(([i]) => byId.get(i));
}

// Proširi pogotke na cijele odjeljke (isti h1/h2/h3), redom po stranici; ograniči ukupnu duljinu.
export function expandSections(idx, hits, { maxSections = 8, maxChars = 26000, perSection = 5000 } = {}) {
  const key = d => [d.h1, d.h2, d.h3].join('›');
  const groups = new Map();
  idx.docs.forEach(d => { const k = key(d); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(d); });
  const out = []; const seen = new Set(); let total = 0;
  for (const h of hits) {
    const k = key(h); if (seen.has(k)) continue; seen.add(k);
    const members = (groups.get(k) || [h]).slice().sort((a, b) => a.i - b.i);
    let t = ''; let img = null;
    for (const m of members) { if (t.length + m.t.length > perSection) break; t += (t ? ' ' : '') + m.t; if (!img && m.img) img = m.img; }
    if (!t) t = h.t.slice(0, perSection);
    if (total + t.length > maxChars && out.length) break;
    total += t.length;
    out.push({ i: members[0].i, p: members[0].p, l: members[0].l, c: h.c, h1: h.h1, h2: h.h2, h3: h.h3, t, img, n: members.length });
    if (out.length >= maxSections) break;
  }
  return out;
}
