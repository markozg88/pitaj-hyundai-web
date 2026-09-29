// POST /api/ask  – odgovor iz korisničkog priručnika (streaming, text/event-stream)
// Tijelo: { token?, model, question, image?, history?: [{role, content}] }
// Okolina: ANTHROPIC_API_KEY, PHOEBE_MACHINE_KEY, PHOEBE_BFF_URL, ANTHROPIC_MODEL?, ANTHROPIC_QUICK_MODEL?, ALLOW_DEMO?
import { buildIndex, search, searchMulti } from '../lib/retrieval.js';

export const config = { runtime: 'nodejs', maxDuration: 60 };

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';
const QUICK = process.env.ANTHROPIC_QUICK_MODEL || 'claude-haiku-4-5-20251001';
const DAILY_LIMIT = Number(process.env.DAILY_LIMIT || 30);
const RULES = `Ti si asistent za vlasnike Hyundai vozila u Hrvatskoj ("Pitaj Hyundai"). Odgovaraš ISKLJUČIVO na temelju izvadaka iz službenog korisničkog priručnika koje dobiješ u poruci.
Pravila:
1. Odgovaraj na hrvatskom, kratko i jasno, kao ljubazan savjetnik u servisu. Počni jednim kratkim podebljanim naslovom (**...**) koji imenuje o čemu je riječ, zatim najviše oko 150 riječi; nabrajanja samo kad su koraci (tada nabroji korake iz priručnika redom). Ne ponavljaj isto više puta.
2. Iza svake tvrdnje navedi stranicu u obliku [str. 5-13] koristeći "label" izvatka iz kojeg je tvrdnja.
3. Ako izvatci ne sadrže odgovor, reci to otvoreno ("U priručniku nisam pronašao…") i preporuči ovlaštenog Hyundai partnera ili besplatni broj 0800 1111. Nikad ne izmišljaj podatke, brojke ni postupke.
4. Sigurnosne napomene (OPASNOST, UPOZORENJE, OPREZ, OPASKA) bitne za pitanje prenesi doslovno, u zasebnom retku koji počinje tom riječju.
5. Ne postavljaj dijagnoze kvarova i ne procjenjuj cijene. Za sve što zahtijeva servis uputi na ovlaštenog partnera.
6. Ne spominji da si dobio izvatke; govori kao da poznaješ priručnik.
7. Neki izvatci imaju oznaku [SIMBOL] – aplikacija može prikazati sličicu tog simbola. Ako je pitanje o lampici/indikatoru, na kraju odgovora dodaj zaseban redak točno u obliku: SIMBOLI: 2, 5 (brojevi izvadaka označenih [SIMBOL] koji odgovaraju pitanju, najviše 4). Ako nijedan ne odgovara, izostavi taj redak.`;

const cache = new Map();   // code -> index (topao instance)
const usage = new Map();   // ref -> {day, n}

async function loadIndex(origin, code) {
  if (cache.has(code)) return cache.get(code);
  const r = await fetch(`${origin}/index/${encodeURIComponent(code)}.json`);
  if (!r.ok) return null;
  const idx = buildIndex(await r.json()); cache.set(code, idx); return idx;
}

async function bff(path, body) {
  const base = process.env.PHOEBE_BFF_URL, key = process.env.PHOEBE_MACHINE_KEY;
  if (!base || !key) return null;
  const r = await fetch(`${base}/api/machine/v1/${path}`, { method: 'POST', headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try { return await r.json(); } catch { return { valid: false, status: 'error', http: r.status }; }
}

async function claude(body, stream = false) {
  return fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ ...body, stream }),
  });
}

function limitOk(ref) {
  const day = new Date().toISOString().slice(0, 10); const u = usage.get(ref);
  if (!u || u.day !== day) { usage.set(ref, { day, n: 1 }); return true; }
  if (u.n >= DAILY_LIMIT) return false; u.n++; return true;
}

const sse = (ctl, enc, event, data) => ctl.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));

export async function POST(req) {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  if (!process.env.ANTHROPIC_API_KEY) return Response.json({ error: 'llm_not_configured' }, { status: 503 });
  let body; try { body = await req.json(); } catch { return Response.json({ error: 'bad_json' }, { status: 400 }); }
  const { token, model, question = '', image, history = [] } = body;
  if (!model || (!question && !image)) return Response.json({ error: 'missing_fields' }, { status: 400 });

  // 1) provjera tokena kod BFF-a (ili demo)
  let ref = null;
  if (token && process.env.PHOEBE_MACHINE_KEY) {
    const v = await bff('module-sessions/verify', { token });
    if (!v || !v.valid) return Response.json({ error: 'invalid_token' }, { status: 401 });
    ref = v.ref;
  } else if (process.env.ALLOW_DEMO === '1') {
    ref = 'demo:' + (req.headers.get('x-forwarded-for') || 'anon').split(',')[0];
  } else return Response.json({ error: 'token_required' }, { status: 401 });
  if (!limitOk(ref)) return Response.json({ error: 'daily_limit' }, { status: 429 });

  // 2) indeks
  const origin = new URL(req.url).origin;
  const idx = await loadIndex(origin, model);
  if (!idx) return Response.json({ error: 'unknown_manual' }, { status: 404 });

  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(ctl) {
      try {
        // 3) opis slike (ako je ima)
        let desc = '';
        if (image) {
          const m = /^data:(image\/[a-z]+);base64,(.+)$/i.exec(image);
          if (!m) { sse(ctl, enc, 'error', { code: 'image_rejected' }); ctl.close(); return; }
          sse(ctl, enc, 'status', { text: 'Gledam fotografiju…' });
          const r = await claude({ model: QUICK, max_tokens: 400, messages: [{ role: 'user', content: [
            { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } },
            { type: 'text', text: 'Ovo je fotografija iz Hyundai vozila (instrument ploča, tipka, zaslon ili motorni prostor). U 2-3 rečenice na hrvatskom opiši točno što se vidi i što je bitno za priručnik: koji simbol/lampica/tipka/poruka, boja (crvena, žuta, zelena, plava, bijela), svijetli li ili trepće, tekst poruke ako postoji. Zatim u zadnjem retku napiši "KLJUČNE RIJEČI:" i 5-10 riječi kojima bi se to tražilo u korisničkom priručniku (hrvatski).' } ] }] });
          if (r.ok) { const j = await r.json(); desc = (j.content || []).map(c => c.text || '').join('').trim(); }
        }
        const kw = desc ? (desc.match(/KLJUČNE RIJEČI:\s*(.+)$/im) || [])[1] || '' : '';
        // 4) prijevod pitanja u rječnik priručnika (brzi model), pa pretraga s više upita
        let alts = [];
        if (question && question.length > 3) {
          try {
            const r = await claude({ model: QUICK, max_tokens: 200, messages: [{ role: 'user', content: `Vlasnik Hyundai vozila pita: "${question}"\nNapiši 3 kratka upita (3–6 riječi) kojima bi se to tražilo u korisničkom priručniku, rječnikom priručnika (npr. "punjenje visokonaponske baterije", "svjetlo upozorenja tlaka ulja", "raspored održavanja"). Jedan po retku, bez brojeva i bez objašnjenja.` }] });
            if (r.ok) { const j = await r.json(); alts = (j.content || []).map(c => c.text || '').join('').split('\n').map(x => x.replace(/^[-•\d.\s"]+|"$/g, '').trim()).filter(x => x.length > 3).slice(0, 3); }
          } catch {}
        }
        const q0 = (question + ' ' + kw + ' ' + (kw ? '' : desc)).trim();
        const hits = searchMulti(idx, [q0, ...alts], 10);
        sse(ctl, enc, 'sources', { hits: hits.map((h, i) => ({ n: i + 1, page: h.p, label: h.l, chapter: h.c, h1: h.h1, h2: h.h2, h3: h.h3, snippet: h.t.slice(0, 220), img: h.img || null })) });
        if (!hits.length) { sse(ctl, enc, 'delta', { text: 'U priručniku nisam pronašao odlomak koji odgovara na to pitanje. Pokušajte preformulirati ili se obratite ovlaštenom Hyundai partneru (0800 1111).' }); sse(ctl, enc, 'done', { symbols: [] }); ctl.close(); return; }
        const ctx = hits.map((h, i) => `[Izvadak ${i + 1} | poglavlje: ${h.c} | ${h.h1}${h.h2 ? ' › ' + h.h2 : ''}${h.h3 ? ' › ' + h.h3 : ''} | label: ${h.l || '?'}${h.img ? ' | [SIMBOL]' : ''}]\n${h.t.slice(0, 1600)}`).join('\n\n');
        const userTurn = `IZVATCI IZ PRIRUČNIKA:\n${ctx}\n\n${desc ? 'VLASNIK JE POSLAO FOTOGRAFIJU. Opis fotografije: ' + desc.replace(/KLJUČNE RIJEČI:.*$/im, '').trim() + '\n\n' : ''}PITANJE VLASNIKA: ${question || 'Što je ovo na slici i što trebam učiniti?'}`;
        const msgs = [...history.slice(-6).filter(t => t && (t.role === 'user' || t.role === 'assistant') && t.content), { role: 'user', content: userTurn }];
        // 5) odgovor, streaming
        sse(ctl, enc, 'status', { text: 'Sastavljam odgovor…' });
        const r = await claude({ model: MODEL, max_tokens: 1400, system: RULES, messages: msgs }, true);
        if (!r.ok) { sse(ctl, enc, 'error', { code: 'llm_error', http: r.status }); ctl.close(); return; }
        const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = '', full = '';
        const handle = line => {
          if (!line.startsWith('data: ')) return;
          let ev; try { ev = JSON.parse(line.slice(6)); } catch { return; }
          if (ev.type === 'content_block_delta' && ev.delta && ev.delta.text) { full += ev.delta.text; sse(ctl, enc, 'delta', { text: ev.delta.text }); }
          if (ev.type === 'message_delta' && ev.delta && ev.delta.stop_reason === 'max_tokens') sse(ctl, enc, 'status', { text: 'Odgovor je skraćen.' });
        };
        while (true) {
          const { value, done } = await reader.read(); if (done) break;
          buf += dec.decode(value, { stream: true }); const lines = buf.split('\n'); buf = lines.pop();
          lines.forEach(handle);
        }
        buf += dec.decode(); buf.split('\n').forEach(handle);
        const sm = full.match(/SIMBOLI:\s*([\d,\s]+)/i);
        const symbols = sm ? sm[1].split(/[,\s]+/).filter(Boolean).map(Number).filter(n => n >= 1 && n <= hits.length) : [];
        // 6) događaj prema BFF-u (samo pravi korisnici)
        let event = null;
        if (token && process.env.PHOEBE_MACHINE_KEY) {
          event = await bff('module-events', { token, event: 'question_answered', context: { model, photo: !!image, topic: (hits[0].h3 || hits[0].h2 || hits[0].h1 || '').slice(0, 120) } });
        }
        sse(ctl, enc, 'done', { symbols, event });
      } catch (e) {
        sse(ctl, enc, 'error', { code: 'server_error', message: String(e && e.message || e) });
      }
      ctl.close();
    }
  });
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' } });
}
