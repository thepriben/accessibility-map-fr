/**
 * Capture d'écran d'une page locale, sans dépendance (pilotage direct de Chrome
 * via le protocole DevTools). Sert à vérifier le rendu 3D et les vignettes de
 * légende, que ni le typage ni les tests géométriques ne peuvent contrôler.
 *
 *   node --experimental-websocket scripts/capture.mjs <url> <sortie.png> [titre-attendu]
 *
 * `titre-attendu` : le harnais met `document.title` à un jeton une fois la
 * scène prête ; on attend ce jeton plutôt qu'un délai fixe.
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const [url, out, expectTitle] = process.argv.slice(2);
if (!url || !out) {
  console.error('usage: capture.mjs <url> <sortie.png> [titre-attendu]');
  process.exit(2);
}

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9333 + Math.floor(Math.random() * 400);

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

/** Attend que le point d'entrée DevTools réponde. */
async function endpoint() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return (await r.json()).webSocketDebuggerUrl;
    } catch {
      /* Chrome n'écoute pas encore */
    }
    await sleep(150);
  }
  throw new Error('Chrome injoignable');
}

/** Petit client CDP : envoie une commande et attend sa réponse. */
function client(ws) {
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message));
    else p.resolve(msg.result);
  });
  return (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      id += 1;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
}

try {
  const wsUrl = await endpoint();
  const ws = new WebSocket(wsUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  const send = client(ws);

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const call = (m, p) => send(m, p, sessionId);

  await call('Page.enable');
  await call('Runtime.enable');
  const logs = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.consoleAPICalled')
      logs.push(m.params.args.map((a) => a.value ?? a.description ?? JSON.stringify(a.preview ?? '')).join(' '));
    if (m.method === 'Runtime.exceptionThrown')
      logs.push(`ERREUR ${m.params.exceptionDetails.text} ${m.params.exceptionDetails.exception?.description ?? ''}`);
  });

  await call('Page.navigate', { url });

  // Attente active du jeton de titre : plus fiable qu'un délai arbitraire.
  const deadline = Date.now() + 60000;
  let title = '';
  while (Date.now() < deadline) {
    const r = await call('Runtime.evaluate', { expression: 'document.title', returnByValue: true });
    title = r.result.value ?? '';
    if (!expectTitle || title === expectTitle || title.includes('erreur')) break;
    await sleep(300);
  }
  await sleep(800); // laisse un dernier rendu s'afficher

  // --wheel <n> : n crans de molette vers l'avant au centre, pour inspecter le
  // detail d'une scene qui s'affiche par defaut a l'echelle du quartier.
  const wheelArg = process.argv.indexOf('--wheel');
  if (wheelArg > 0) {
    const turns = Number(process.argv[wheelArg + 1] ?? 5);
    for (let k = 0; k < turns; k += 1) {
      await call('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: 640,
        y: 430,
        deltaX: 0,
        deltaY: -120,
      });
      await sleep(140);
    }
    await sleep(900);
  }

  const shot = await call('Page.captureScreenshot', { format: 'png' });
  writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log(`titre: ${title}`);
  if (logs.length) console.log(logs.join('\n'));
  console.log(`capture: ${out}`);
  ws.close();
} finally {
  chrome.kill();
}
