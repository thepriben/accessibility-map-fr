// Verifie le calcul d'itineraire pieton de la scene 3D (src/three/route.ts) :
// suivi du reseau, detour autour d'un obstacle, evitement des escaliers et
// repli en liaison directe. Usage : node scripts/check-route.mjs
import { build } from 'esbuild';

const bundle = await build({
  entryPoints: ['src/three/route.ts'],
  bundle: true,
  format: 'esm',
  write: false,
  platform: 'neutral',
});
const { findRoute, frontDoorGuess } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
);

let failures = 0;

function ok(label, condition, detail = '') {
  if (!condition) failures += 1;
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? ` : ${detail}` : ''}`);
}

function near(label, got, want, tol) {
  const good = Math.abs(got - want) <= tol;
  if (!good) failures += 1;
  console.log(
    `${good ? 'ok  ' : 'FAIL'} ${label} : ${got.toFixed(2)} (attendu ${want.toFixed(2)} +/- ${tol})`
  );
}

// --- Couloir droit : le trajet doit suivre le cheminement, pas la diagonale ---
{
  const lines = [{ points: [[0, 0], [30, 0]] }];
  const r = findRoute(lines, [0, 2], [30, 2]);
  ok('couloir droit : suit le reseau', !r.direct);
  near('couloir droit : longueur', r.length, 34, 0.5); // 2 + 30 + 2
}

// --- Detour : le reseau contourne un batiment, le trajet doit le contourner ---
{
  // Un U : depart en bas a gauche, arrivee en bas a droite, passage par le haut.
  const lines = [
    { points: [[0, 0], [0, -20]] },
    { points: [[0, -20], [20, -20]] },
    { points: [[20, -20], [20, 0]] },
  ];
  const r = findRoute(lines, [0, 0], [20, 0]);
  ok('detour en U : suit le reseau', !r.direct);
  near('detour en U : longueur', r.length, 60, 0.5);
  ok(
    'detour en U : passe par le haut',
    r.points.some(([, y]) => y <= -19),
    `${r.points.length} sommets`
  );
}

// --- Escaliers : penalises, donc contournes si un detour raisonnable existe ---
{
  // Tout droit (20 m) mais par des marches, ou par un detour de 32 m a plat.
  const lines = [
    { points: [[0, 0], [20, 0]], cost: 6 }, // escalier
    { points: [[0, 0], [0, -6]] },
    { points: [[0, -6], [20, -6]] },
    { points: [[20, -6], [20, 0]] },
  ];
  const r = findRoute(lines, [0, 0], [20, 0]);
  ok(
    'escalier penalise : contourne',
    r.points.some(([, y]) => y <= -5.5),
    `longueur ${r.length.toFixed(1)} m`
  );
}

// --- Escalier unique passage : ne doit pas echouer pour autant ---
{
  const lines = [{ points: [[0, 0], [20, 0]], cost: 6 }];
  const r = findRoute(lines, [0, 0], [20, 0]);
  ok('escalier seul passage : emprunte quand meme', !r.direct);
}

// --- Reseau trop loin : liaison directe annoncee comme telle ---
{
  const lines = [{ points: [[500, 500], [520, 500]] }];
  const r = findRoute(lines, [0, 0], [10, 0]);
  ok('reseau hors de portee : liaison directe', r.direct);
  near('liaison directe : longueur', r.length, 10, 1e-6);
}

// --- Aucun reseau du tout ---
{
  const r = findRoute([], [0, 0], [3, 4]);
  ok('reseau vide : liaison directe', r.direct);
  near('reseau vide : longueur', r.length, 5, 1e-6);
}

// --- Troncons distincts qui se rejoignent a quelques cm pres ---
{
  const lines = [
    { points: [[0, 0], [10, 0]] },
    { points: [[10.08, 0.05], [20, 0]] }, // meme carrefour, coordonnees legerement differentes
  ];
  const r = findRoute(lines, [0, 0], [20, 0]);
  ok('sommets recales : troncons reconnectes', !r.direct, `longueur ${r.length.toFixed(1)} m`);
}

// --- Destination a defaut d'entree OSM : la façade donnant sur le trottoir ---
{
  // Batiment carre de 20 m, trottoir longeant sa façade sud (y = 14).
  const ring = [
    [0, 0],
    [20, 0],
    [20, 10],
    [0, 10],
  ];
  const net = [{ points: [[-10, 14], [30, 14]] }];
  const p = frontDoorGuess(ring, net, 1.2);
  ok('façade sur rue : cote sud retenu', p[1] > 10, `point ${p.map((v) => v.toFixed(1))}`);
  near('façade sur rue : decalage exterieur', p[1] - 10, 1.2, 0.3);
  ok('façade sur rue : centree sur la façade', Math.abs(p[0] - 10) < 0.6, `x=${p[0].toFixed(1)}`);
}

// --- Le trottoir passe au nord : c'est cette façade-la qui doit gagner ---
{
  const ring = [
    [0, 0],
    [20, 0],
    [20, 10],
    [0, 10],
  ];
  const net = [{ points: [[-10, -6], [30, -6]] }];
  const p = frontDoorGuess(ring, net, 1.2);
  ok('façade opposee : cote nord retenu', p[1] < 0, `point ${p.map((v) => v.toFixed(1))}`);
}

// --- Empreinte ou reseau absents ---
{
  ok('empreinte degeneree : pas de point', frontDoorGuess([[0, 0], [1, 1]], [{ points: [[0, 5], [5, 5]] }]) === null);
  ok('reseau absent : pas de point', frontDoorGuess([[0, 0], [4, 0], [4, 4], [0, 4]], []) === null);
}

console.log(failures ? `\n${failures} echec(s)` : '\nTout est conforme');
process.exit(failures ? 1 : 0);
