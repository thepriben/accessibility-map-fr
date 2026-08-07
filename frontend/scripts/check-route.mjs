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
const { findRoute, frontDoorGuess, measureWalk, sampleWalk } = await import(
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

// --- Parcours du trajet : position et cap a une abscisse donnee ---
{
  // Ligne brisee : 10 m vers l'est, puis 10 m vers le sud.
  const w = measureWalk([
    [0, 0],
    [10, 0],
    [10, 10],
  ]);
  near('longueur cumulee', w.total, 20, 0.001);

  const a = sampleWalk(w, 5, 1);
  near('milieu du premier segment : x', a.x, 5, 0.001);
  near('milieu du premier segment : z', a.z, 0, 0.001);
  near('cap plein est', a.hx, 1, 0.001);

  const b = sampleWalk(w, 15, 1);
  near('second segment : z', b.z, 5, 0.001);
  near('cap plein sud', b.hz, 1, 0.001);

  // Le cap vise plus loin que le segment courant : au sommet, il est deja
  // oriente vers la suite plutot que de pivoter d'un coup.
  const turn = sampleWalk(w, 10, 4);
  ok('cap lisse dans le virage', turn.hz > 0.9, `hz=${turn.hz.toFixed(2)}`);

  // Aux extremites, aucun cap indefini.
  const end = sampleWalk(w, 20, 4);
  near('arrivee bornee : x', end.x, 10, 0.001);
  ok('cap defini a l’arrivee', Math.hypot(end.hx, end.hz) > 0.99);
  const before = sampleWalk(w, -5, 4);
  near('depart borne : x', before.x, 0, 0.001);
}

// --- Sommets confondus et trajets degeneres ---
{
  const w = measureWalk([
    [0, 0],
    [0, 0],
    [3, 0],
  ]);
  ok('sommets confondus ecartes', w.points.length === 2, `${w.points.length} sommets`);
  near('longueur inchangee', w.total, 3, 0.001);

  const single = measureWalk([[2, 2]]);
  near('trajet reduit a un point : longueur', single.total, 0, 0.001);
  const p = sampleWalk(single, 5, 4);
  ok('point unique : position tenue', p.x === 2 && p.z === 2);
  ok('point unique : cap defini', Math.hypot(p.hx, p.hz) > 0.99);
}

console.log(failures ? `\n${failures} echec(s)` : '\nTout est conforme');
process.exit(failures ? 1 : 0);
