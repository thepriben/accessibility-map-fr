/**
 * Enregistre une video de demonstration : recherche d'un lieu, ouverture de sa
 * fiche, passage en 3D, puis simulation du trajet depuis la place PMR (ou
 * l'arret de bus) jusqu'a l'entree.
 *
 *   node --experimental-websocket scripts/demo-video.mjs <base-url> <requete> <sortie.mp4> [--trajet pmr|bus]
 *
 * Le navigateur est pilote par le protocole DevTools, ce qui evite de demander
 * l'autorisation d'enregistrer l'ecran et rend la prise reproductible. Comme un
 * clic programme ne se voit pas, la page recoit un curseur et des cartons
 * dessines pour l'occasion : sans eux, la video montre une interface qui
 * s'anime toute seule, sans qu'on comprenne ce qui est actionne.
 *
 * Les images arrivent au rythme des rendus (le WebGL logiciel du mode sans
 * fenetre est lent et irregulier) : on horodate chaque image et on laisse
 * ffmpeg restituer la duree reelle, plutot que de supposer une cadence fixe.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i > 0 ? args[i + 1] : fallback;
};
const positional = [];
for (let i = 0; i < args.length; i += 1) {
  if (args[i].startsWith('--')) i += 1; // l'option consomme sa valeur
  else positional.push(args[i]);
}
const [base, query, out = '.tmp/demo.mp4'] = positional;
const route = flag('--trajet', 'pmr');
if (!base || !query) {
  console.error('usage: demo-video.mjs <base-url> <requete> [sortie.mp4] [--trajet pmr|bus]');
  process.exit(2);
}

const FRAMES = resolve('.tmp/demo-frames');
rmSync(FRAMES, { recursive: true, force: true });
mkdirSync(FRAMES, { recursive: true });
mkdirSync(dirname(resolve(out)), { recursive: true });

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9500 + Math.floor(Math.random() * 300);
const W = 1280;
const H = 800;

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    '--disable-gpu',
    '--enable-unsafe-swiftshader',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--hide-scrollbars',
    '--no-first-run',
    '--force-device-scale-factor=1',
    `--window-size=${W},${H}`,
    'about:blank',
  ],
  { stdio: 'ignore' }
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function endpoint() {
  for (let i = 0; i < 80; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return (await r.json()).webSocketDebuggerUrl;
    } catch {
      /* pas encore pret */
    }
    await sleep(150);
  }
  throw new Error('Chrome injoignable');
}

function client(ws) {
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.error) p.reject(new Error(m.error.message));
    else p.resolve(m.result);
  });
  return (method, params = {}, sessionId) =>
    new Promise((resolve_, reject) => {
      id += 1;
      pending.set(id, { resolve: resolve_, reject });
      ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
}

/** Curseur, onde de clic et carton d'explication, injectes dans la page. */
const OVERLAY = `window.__demo = (() => {
  const arrow = document.createElement('div');
  arrow.style.cssText = 'position:fixed;left:0;top:0;width:26px;height:26px;z-index:2147483647;'
    + 'pointer-events:none;transition:transform .55s cubic-bezier(.34,.03,.28,1);will-change:transform;'
    + 'filter:drop-shadow(0 2px 3px rgba(8,14,22,.45))';
  arrow.innerHTML = '<svg width="26" height="26" viewBox="0 0 24 24" aria-hidden="true">'
    + '<path d="M5.4 2.1 L18.7 11.3 L12.1 12.2 L15.2 18.8 L12.3 20.1 L9.2 13.5 L5.4 16.8 Z"'
    + ' fill="#ffffff" stroke="#16202c" stroke-width="1.3" stroke-linejoin="round"/></svg>';
  const ring = document.createElement('div');
  ring.style.cssText = 'position:fixed;left:0;top:0;width:36px;height:36px;margin:-18px 0 0 -18px;'
    + 'border-radius:50%;border:2px solid rgba(255,255,255,.95);opacity:0;z-index:2147483646;pointer-events:none';
  const cap = document.createElement('div');
  // Sous le bandeau de la vue 3D et sous celui de la simulation, qui occupent
  // deja le haut de l'ecran : un carton par-dessus rendait les deux illisibles.
  cap.style.cssText = 'position:fixed;left:50%;top:206px;transform:translateX(-50%);z-index:2147483645;'
    + 'pointer-events:none;background:rgba(12,16,22,.9);color:#f4f7fb;'
    + 'font:600 16px/1.35 -apple-system,system-ui,sans-serif;padding:10px 18px;border-radius:999px;'
    + 'opacity:0;transition:opacity .4s;max-width:78vw;text-align:center;'
    + 'box-shadow:0 6px 20px rgba(8,14,22,.35)';
  document.body.append(arrow, ring, cap);
  let x = Math.round(innerWidth / 2), y = Math.round(innerHeight - 90);
  const place = () => {
    arrow.style.transform = 'translate(' + x + 'px,' + y + 'px)';
    ring.style.transform = 'translate(' + x + 'px,' + y + 'px)';
  };
  place();
  return {
    move(nx, ny) { x = Math.round(nx); y = Math.round(ny); place(); return { x, y }; },
    at() { return { x, y }; },
    tap() {
      ring.animate(
        [
          { transform: 'translate(' + x + 'px,' + y + 'px) scale(.45)', opacity: 1 },
          { transform: 'translate(' + x + 'px,' + y + 'px) scale(1.6)', opacity: 0 },
        ],
        { duration: 480, easing: 'ease-out' }
      );
    },
    caption(t) { cap.textContent = t || ''; cap.style.opacity = t ? '1' : '0'; },
  };
})(); true`;

const frames = [];

try {
  const ws = new WebSocket(await endpoint());
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  const send = client(ws);
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const call = (m, p) => send(m, p, sessionId);

  await call('Page.enable');
  await call('Runtime.enable');

  // Reception des images : chacune doit etre acquittee, sinon le flux s'arrete.
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method !== 'Page.screencastFrame' || m.sessionId !== sessionId) return;
    const file = join(FRAMES, `f${String(frames.length).padStart(5, '0')}.jpg`);
    writeFileSync(file, Buffer.from(m.params.data, 'base64'));
    frames.push({ file, t: m.params.metadata.timestamp });
    call('Page.screencastFrameAck', { sessionId: m.params.sessionId }).catch(() => {});
  });

  const evaluate = async (expression) => {
    const r = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails)
      throw new Error(r.exceptionDetails.exception?.description ?? 'echec de l’evaluation');
    return r.result.value;
  };
  const until = async (expr, label, ms = 120000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await evaluate(expr)) return true;
      await sleep(300);
    }
    throw new Error(`delai depasse : ${label}`);
  };
  const caption = (t) => evaluate(`window.__demo.caption(${JSON.stringify(t)})`);

  /** Deplace le curseur dessine jusqu'au centre d'un element, puis clique. */
  const clickOn = async (selector, { pause = 650, mousedown = false } = {}) => {
    const box = await evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
    if (!box) throw new Error(`introuvable : ${selector}`);
    await evaluate(`window.__demo.move(${box.x}, ${box.y})`);
    await sleep(pause);
    await evaluate('window.__demo.tap()');
    const at = { x: box.x, y: box.y, button: 'left', clickCount: 1 };
    await call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...at, buttons: 0 });
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', ...at });
    if (!mousedown) await call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...at });
    return box;
  };

  await call('Page.navigate', { url: base });
  await until('!!document.getElementById("search-input")', 'chargement de la page');
  await evaluate(OVERLAY);
  await call('Page.startScreencast', {
    format: 'jpeg',
    quality: 90,
    maxWidth: W,
    maxHeight: H,
    everyNthFrame: 1,
  });

  await caption('Carte d’accessibilité — 632 000 lieux d’Access’libre');
  await sleep(2000);

  // --- Recherche ---
  await caption('On cherche un lieu par son nom');
  await clickOn('#search-input');
  await sleep(400);
  for (const ch of query) {
    await call('Input.insertText', { text: ch });
    await sleep(75);
  }
  await sleep(600);

  // L'index des noms se complete en arriere-plan : on relance la frappe tant
  // que la reponse n'est pas la, sinon la video attend devant une liste vide.
  await (async () => {
    const end = Date.now() + 90000;
    for (;;) {
      const ready = await evaluate(`(() => {
        const li = document.querySelector('#search-results li');
        return !!li && !li.textContent.trim().startsWith('Chargement');
      })()`);
      if (ready) return;
      if (Date.now() > end) throw new Error('delai depasse : resultats de recherche');
      await evaluate(`(() => {
        const i = document.getElementById('search-input');
        i.value = ${JSON.stringify(query)};
        i.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await sleep(1200);
    }
  })();
  await sleep(900);

  const found = await evaluate(
    `document.querySelector('#search-results li').textContent.trim().replace(/\\s+/g, ' ')`
  );
  console.log(`resultat : ${found}`);

  // La liste reagit a `mousedown`, pour devancer la perte de focus du champ.
  await caption('Un résultat : le Grand Marché, à Vichy');
  await clickOn('#search-results li', { pause: 800, mousedown: true });
  await until('!!document.querySelector("#btn-3d, .ppop-3d")', 'fiche du lieu');
  await sleep(500);
  await caption('Sa fiche : ce qu’Access’libre sait de l’accès');
  await sleep(3000);

  // --- Passage en 3D ---
  await caption('On regarde les cent derniers mètres en 3D');
  await clickOn('#btn-3d, .ppop-3d', { pause: 900 });
  await until(
    '!!document.querySelector("#scene3d-ui .scene3d-legend") || !!document.getElementById("scene3d-flat")',
    'vue 3D'
  );
  await sleep(2200);
  // La fiche reste ouverte par-dessus la scene : on la referme, sinon un tiers
  // du voisinage est cache pendant tout le parcours.
  await clickOn('#panel-close', { pause: 700 });
  await sleep(1400);
  await caption('Le lieu visé est en orange, reconstitué d’après OpenStreetMap');
  await sleep(3200);

  // --- Simulation ---
  const options = await evaluate(`(() => {
    const s = document.getElementById('sim-route');
    if (!s || document.getElementById('scene3d-sim').hidden) return [];
    return [...s.options].map((o) => ({ id: o.value, label: o.textContent.trim() }));
  })()`);
  console.log(`trajets : ${JSON.stringify(options)}`);
  if (!options.length) throw new Error('aucun trajet simulable pour ce lieu');
  const wanted = options.find((o) => o.id === route) ?? options[0];

  await caption('Un trajet part de la place PMR la plus proche');
  await evaluate(`(() => {
    const s = document.getElementById('sim-route');
    s.value = ${JSON.stringify(wanted.id)};
    s.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await sleep(2400);

  await caption('On le parcourt à hauteur d’yeux, assis en fauteuil');
  await clickOn('#sim-play', { pause: 900 });
  await sleep(2200);
  // Deux fois l'allure reelle : le trajet dure une minute, et une video de
  // demonstration n'a pas a la faire attendre en entier. Le selecteur affiche
  // l'allure retenue, donc rien n'est masque.
  await evaluate(`(() => {
    const s = document.getElementById('sim-speed');
    s.value = '2';
    s.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await caption(`${wanted.label} — allure ×2`);

  // Le trajet avance tout seul : on suit son compteur jusqu'a l'arrivee.
  const end = Date.now() + 150000;
  let last = '';
  for (;;) {
    const state = await evaluate(
      `document.getElementById('sim-state').textContent.trim()`
    );
    if (state !== last) last = state;
    if (/Arriv/i.test(state) || Date.now() > end) break;
    await sleep(500);
  }
  await caption('Arrivée à l’entrée du bâtiment');
  await sleep(3000);
  await caption('');
  await sleep(900);

  await call('Page.stopScreencast');
  console.log(`images : ${frames.length}`);
  ws.close();
} finally {
  chrome.kill();
}

if (frames.length < 10) {
  console.error('trop peu d’images capturees');
  process.exit(1);
}

// Duree reelle de chaque image, d'apres son horodatage. La derniere reste a
// l'ecran un instant, sinon la video se coupe net.
const list = [];
for (let i = 0; i < frames.length; i += 1) {
  const dt = i + 1 < frames.length ? frames[i + 1].t - frames[i].t : 1.4;
  list.push(`file '${frames[i].file}'`, `duration ${Math.max(dt, 0.016).toFixed(3)}`);
}
list.push(`file '${frames[frames.length - 1].file}'`);
const listFile = join(FRAMES, 'liste.txt');
writeFileSync(listFile, list.join('\n'));

const total = frames[frames.length - 1].t - frames[0].t;
console.log(`duree : ${total.toFixed(1)} s — ${(frames.length / total).toFixed(1)} images/s en moyenne`);

const ff = spawnSync(
  'ffmpeg',
  [
    '-y',
    '-f', 'concat',
    '-safe', '0',
    '-i', listFile,
    // Le mode sans fenetre rend une hauteur impaire (barre d'outils deduite) ;
    // x264 exige des dimensions paires.
    '-vf', 'fps=30,scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p',
    '-c:v', 'libx264',
    '-preset', 'slow',
    '-crf', '21',
    '-movflags', '+faststart',
    resolve(out),
  ],
  { encoding: 'utf8' }
);
if (ff.status !== 0) {
  console.error(ff.stderr?.split('\n').slice(-12).join('\n'));
  process.exit(1);
}
console.log(`video : ${resolve(out)}`);
