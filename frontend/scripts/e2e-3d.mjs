/**
 * Parcours de bout en bout : recherche d'un lieu, ouverture du popup, passage
 * en 3D, puis survol d'un objet de la scène. Capture une image à chaque étape.
 * Vérifie ce que ni le typage ni les tests géométriques ne voient : la légende
 * s'illustre, l'infobulle apparaît, le repli 2D s'affiche là où OSM est vide.
 *
 *   node --experimental-websocket scripts/e2e-3d.mjs <base-url> <requête> <préfixe>
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const [base, query, prefix = '.tmp-e2e'] = process.argv.slice(2);
if (!base || !query) {
  console.error('usage: e2e-3d.mjs <base-url> <requête> [préfixe]');
  process.exit(2);
}

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9800 + Math.floor(Math.random() * 300);
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
    '--window-size=1280,860',
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
      /* pas encore prêt */
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
    new Promise((resolve, reject) => {
      id += 1;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
}

try {
  const ws = new WebSocket(await endpoint());
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  const send = client(ws);
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const call = (m, p) => send(m, p, sessionId);

  await call('Page.enable');
  await call('Runtime.enable');
  // --sans-osm : coupe Overpass pour vérifier le repli en carte 2D.
  if (process.argv.includes('--sans-osm')) {
    await call('Network.enable');
    await call('Network.setBlockedURLs', { urls: ['*/api/interpreter*'] });
  }
  const logs = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type !== 'debug')
      logs.push(`[${m.params.type}] ${m.params.args.map((a) => a.value ?? a.description ?? '').join(' ')}`);
    if (m.method === 'Runtime.exceptionThrown')
      logs.push(`[exception] ${m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text}`);
  });

  const evaluate = async (expression) => {
    const r = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'échec');
    return r.result.value;
  };
  const shot = async (name) => {
    const s = await call('Page.captureScreenshot', { format: 'png' });
    const file = `${prefix}-${name}.png`;
    writeFileSync(file, Buffer.from(s.data, 'base64'));
    console.log(`capture: ${file}`);
  };
  /** Attend qu'une expression devienne vraie. */
  const until = async (expr, label, ms = 90000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await evaluate(expr)) return true;
      await sleep(400);
    }
    throw new Error(`délai dépassé : ${label}`);
  };

  // Toute panne en cours de route est photographiée : c'est ce qui permet de
  // comprendre l'échec sans rejouer le parcours à la main.
  const guard = async (fn) => {
    try {
      await fn();
    } catch (err) {
      await shot('echec');
      console.error(String(err.message ?? err));
      console.log('--- console ---\n' + logs.join('\n'));
      throw err;
    }
  };

  await call('Page.navigate', { url: base });
  await until('!!document.getElementById("search-input")', 'chargement de la page');
  // Les points arrivent via un worker : on attend que la recherche réponde.
  await sleep(6000);

  // Recherche : on simule la saisie puis l'évènement d'entrée. Sur le jeu de
  // données complet, le worker peut n'être pas encore prêt : une frappe partie
  // trop tôt reste sans réponse, donc on la rejoue jusqu'à obtenir des résultats.
  const type = () =>
    evaluate(`(() => {
      const i = document.getElementById('search-input');
      i.value = ${JSON.stringify(query)};
      i.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
  await guard(async () => {
    const end = Date.now() + 120000;
    for (;;) {
      await type();
      try {
        await until(
          '!!document.querySelector("#search-results li button, #search-results li")',
          'résultats de recherche',
          5000
        );
        return;
      } catch (err) {
        if (Date.now() > end) throw err;
      }
    }
  });
  await shot('1-recherche');

  // La liste réagit à `mousedown` (pour devancer la perte de focus du champ).
  await evaluate(`(() => {
    const el = document.querySelector('#search-results li');
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  })()`);
  // Depuis la recherche, c'est la fiche detaillee qui s'ouvre (pas le popup) :
  // son bouton n'apparait qu'une fois le voisinage OSM recupere.
  await guard(() => until('!!document.querySelector("#btn-3d, .ppop-3d")', 'bouton 3D'));
  await shot('2-fiche');

  // Popup carto : la fiche ouverte depuis la recherche ne passe pas par lui, et
  // c'est pourtant lui qui porte le renvoi vers la source Acceslibre. La
  // recherche a centre la carte sur le lieu : son marqueur est donc au milieu,
  // l'icone legerement au-dessus du point d'ancrage.
  await evaluate(`document.querySelector('#panel-close')?.click()`);
  await sleep(600);
  const box = await evaluate(`(() => {
    const r = document.getElementById('map').getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
  let popupLink = null;
  for (const [dx, dy] of [
    [0, 0], [0, -8], [0, -16], [0, -24], [0, -32],
    [-8, -12], [8, -12], [-8, -24], [8, -24], [0, 8],
  ]) {
    if (popupLink) break;
    const at = { x: box.x + dx, y: box.y + dy, button: 'left', clickCount: 1 };
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', ...at });
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...at });
    await sleep(150);
    popupLink = await evaluate(
      `(() => { const a = document.querySelector('.ppop-source a'); return a ? a.href : null; })()`
    );
  }
  console.log(`lien Acceslibre dans le popup: ${popupLink ?? 'ABSENT'}`);
  await shot('2b-popup');

  // Sans popup, la fiche a ete fermee : on la rouvre pour la suite du parcours.
  if (!popupLink) {
    await evaluate(`(() => {
      const el = document.querySelector('#search-results li');
      if (el) el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    })()`);
    await guard(() => until('!!document.querySelector("#btn-3d, .ppop-3d")', 'bouton 3D'));
  }
  await evaluate(`document.querySelector('#btn-3d, .ppop-3d').click()`);
  await guard(() =>
    until(
      '!!document.querySelector("#scene3d-ui .scene3d-legend") || !!document.getElementById("scene3d-flat")',
      'vue 3D ou repli 2D'
    )
  );
  await sleep(4000);
  await shot('3-vue3d');

  const legend = await evaluate(`(() => {
    const imgs = [...document.querySelectorAll('#scene3d-ui img.lg-icon')];
    return {
      repli: !!document.getElementById('scene3d-flat'),
      entrees: imgs.length,
      illustrees: imgs.filter((i) => (i.src || '').startsWith('data:image/png')).length,
      titres: [...document.querySelectorAll('#scene3d-ui .scene3d-legend li')].map((li) => li.textContent.trim()),
    };
  })()`);
  console.log('légende:', JSON.stringify(legend));

  // Survol : on balaie le centre de la scène pour déclencher une infobulle.
  let tip = null;
  const sweep = [];
  for (let x = 220; x <= 820; x += 60) for (let y = 260; y <= 620; y += 60) sweep.push([x, y]);
  for (const [x, y] of sweep) {
    await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 });
    await sleep(120);
    tip = await evaluate(
      `(() => { const t = document.querySelector('.scene3d-tip'); return t && t.offsetParent !== null ? t.textContent.trim() : null; })()`
    );
    if (tip) {
      await shot('4-survol');
      break;
    }
  }
  console.log('infobulle:', tip ?? 'aucune');

  // Simulation à hauteur de fauteuil : elle n'existe que si le voisinage offre
  // un point de départ (place PMR ou arrêt de bus) relié à l'entrée.
  const sim = await evaluate(
    `(() => { const b = document.getElementById('scene3d-sim'); return b && !b.hidden ? document.getElementById('sim-route').options.length : 0; })()`
  );
  console.log(`trajets simulables: ${sim}`);
  if (sim) {
    await evaluate(`document.getElementById('sim-play').click()`);
    await sleep(6000);
    const running = await evaluate(`(() => ({
      banniere: !document.getElementById('scene3d-sim-banner').hidden,
      medaillon: !document.getElementById('scene3d-mini').hidden,
      legende: !!document.querySelector('.scene3d-legend')?.hidden,
      etat: document.getElementById('sim-state').textContent.trim(),
    }))()`);
    console.log(`simulation: ${JSON.stringify(running)}`);
    await shot('5-simulation');

    // Commandes de lecture : la position doit se reprendre à volonté, et un
    // trajet ramené en arrière ne doit plus se croire terminé.
    const press = async (id) => {
      await evaluate(`document.getElementById('${id}').click()`);
      await sleep(400);
    };
    const at = () => evaluate(`Number(document.getElementById('sim-seek').value)`);
    const label = () => evaluate(`document.getElementById('sim-play').textContent.trim()`);
    const played = await at();
    await press('sim-back');
    const back = await at();
    await press('sim-fwd');
    const fwd = await at();
    await press('sim-start');
    const start = await at();
    await press('sim-end');
    const [end, endLabel] = [await at(), await label()];
    console.log(`arrivée: ${await evaluate(`document.getElementById('sim-state').textContent.trim()`)}`);
    await press('sim-back');
    const [reopen, reopenLabel] = [await at(), await label()];
    console.log(
      `lecture: joué ${played} m, recul ${back} m, avance ${fwd} m, ` +
        `départ ${start} m, arrivée ${end} m (${endLabel}), ` +
        `rembobiné ${reopen} m (${reopenLabel})`
    );

    // Allure : ×4 doit faire progresser nettement plus vite qu'à l'arrêt.
    await evaluate(`(() => {
      const s = document.getElementById('sim-speed');
      s.value = '4';
      s.dispatchEvent(new Event('change', { bubbles: true }));
      document.getElementById('sim-play').click();
    })()`);
    const t0 = await at();
    await sleep(2000);
    const t1 = await at();
    console.log(`allure ×4 : ${t1 - t0} m en 2 s (attendu ~6,4 m)`);
    await shot('6-lecture');

    await evaluate(`document.getElementById('sim-stop').click()`);
    await sleep(700);
    const left = await evaluate(
      `document.getElementById('scene3d-sim-banner').hidden && !document.querySelector('.scene3d-legend')?.hidden`
    );
    console.log(`sortie de simulation propre: ${left ? 'oui' : 'NON'}`);
  }

  // L'infobulle doit disparaître hors des objets : une règle CSS trop faible
  // la laissait affichée en permanence, vide.
  if (tip) {
    await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 120, y: 130, buttons: 0 });
    await sleep(600);
    const visible = await evaluate(
      `(() => { const t = document.querySelector('.scene3d-tip'); return !!t && t.offsetParent !== null; })()`
    );
    console.log('infobulle masquée hors objet:', visible ? 'NON (défaut)' : 'oui');
  }

  if (logs.length) console.log('--- console ---\n' + logs.join('\n'));
  ws.close();
} finally {
  chrome.kill();
}
