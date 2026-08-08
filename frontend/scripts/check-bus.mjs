// Verifie la mise en forme des lignes de bus (src/three/bus.ts) : les relations
// d'une meme ligne se reunissent, une voie citee par les deux sens n'est
// dessinee qu'une fois, et un ruban ne s'ecarte de l'axe que s'il partage la
// rue. Usage : node scripts/check-bus.mjs
import { build } from 'esbuild';

const bundle = await build({
  entryPoints: ['src/three/bus.ts'],
  bundle: true,
  format: 'esm',
  write: false,
  platform: 'neutral',
});
const { busPlacements, dropTwinRuns, mergeBusRoutes } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
);

let failures = 0;
function ok(label, cond, got) {
  if (cond) console.log(`ok   ${label}`);
  else {
    console.log(`ECHEC ${label}${got === undefined ? '' : ` (obtenu ${JSON.stringify(got)})`}`);
    failures += 1;
  }
}

const street = [
  [0, 0],
  [50, 0],
];
const other = [
  [0, 40],
  [50, 40],
];

// Cas reel de Vichy : la ligne D existe en quatre relations (deux sens, deux
// variantes de service) qui citent toutes la meme rue.
const vichy = [
  { id: 'r1', ref: 'D', name: 'MobiVie D : Les Biernets → Les Arloings', colour: '#c855be',
    segments: [{ way: 'w667', coords: street }] },
  { id: 'r2', ref: 'D', name: 'MobiVie D : Les Arloings → Les Biernets', colour: '#c855be',
    segments: [{ way: 'w667', coords: street }] },
  { id: 'r3', ref: 'D', name: 'MobiVie D_Toussaint : Chantegrelet → Poste', colour: '#c855be',
    segments: [{ way: 'w667', coords: street }] },
  { id: 'r4', ref: 'D', name: 'MobiVie D_Toussaint : Poste → Chantegrelet', colour: '#c855be',
    segments: [{ way: 'w667', coords: street }, { way: 'w688', coords: other }] },
];

const merged = mergeBusRoutes(vichy);
ok('quatre relations font une seule ligne', merged.length === 1, merged.length);
ok('la voie commune aux deux sens n’est gardee qu’une fois', merged[0].segments.length === 2, merged[0].segments.length);
ok('le nom perd la direction', merged[0].name === 'MobiVie D', merged[0].name);
ok('la couleur du reseau est conservee', merged[0].colour === '#c855be', merged[0].colour);

// Une relation sans numero ni nom reste seule : la rapprocher serait une invention.
const anonymes = mergeBusRoutes([
  { id: 'rA', ref: null, name: null, colour: null, segments: [{ way: 'w1', coords: street }] },
  { id: 'rB', ref: null, name: null, colour: null, segments: [{ way: 'w2', coords: other }] },
]);
ok('deux relations anonymes restent distinctes', anonymes.length === 2, anonymes.length);

// La couleur peut n'etre portee que par l'un des deux sens.
const partielle = mergeBusRoutes([
  { id: 'r1', ref: 'A', name: 'A : aller', colour: null, segments: [{ way: 'w1', coords: street }] },
  { id: 'r2', ref: 'A', name: 'A : retour', colour: '#e74754', segments: [{ way: 'w1', coords: street }] },
]);
ok('la couleur est reprise du sens qui la porte', partielle[0].colour === '#e74754', partielle[0].colour);

// Decalages : seule compte la rue reellement partagee.
const offsets = (runs, keys) => busPlacements(runs, keys).map((p) => p.offset);

const seule = offsets([{ line: 0, points: street }], ['A']);
ok('une ligne seule reste au milieu de la chaussee', seule[0] === 0, seule[0]);

const deux = offsets(
  [
    { line: 0, points: street },
    { line: 1, points: street },
  ],
  ['A', 'B']
);
ok('deux lignes s’ecartent symetriquement', Math.abs(deux[0] + deux[1]) < 1e-9, deux);
ok('elles restent sur la chaussee', Math.max(...deux.map(Math.abs)) <= 1.8, deux);

const eloignees = offsets(
  [
    { line: 0, points: street },
    { line: 1, points: other },
  ],
  ['A', 'B']
);
ok('deux rues distinctes ne se decalent pas', eloignees.every((o) => o === 0), eloignees);

// L'ordre du faisceau ne doit pas dependre de l'ordre d'arrivee des relations.
const ordre = offsets(
  [
    { line: 0, points: street },
    { line: 1, points: street },
  ],
  ['B', 'A']
);
ok('le faisceau est ordonne par numero de ligne', ordre[0] > ordre[1], ordre);

// Un simple croisement ne fait pas un tronçon commun.
const croise = offsets(
  [
    { line: 0, points: street },
    {
      line: 1,
      points: [
        [25, -40],
        [25, 40],
      ],
    },
  ],
  ['A', 'B']
);
ok('un croisement ne decale pas les rubans', croise.every((o) => o === 0), croise);

// Boulevard tres desservi : le faisceau ne doit pas deborder de la chaussee, et
// le pas doit se resserrer assez pour que les rubans ne se rejoignent pas.
const huit = busPlacements(
  Array.from({ length: 8 }, (_, i) => ({ line: i, points: street })),
  ['29', '87', '91', 'N01', 'N02', 'N11', 'N16', 'N139']
);
ok(
  'huit lignes tiennent sur la chaussee',
  Math.max(...huit.map((p) => Math.abs(p.offset))) <= 1.6,
  Math.max(...huit.map((p) => Math.abs(p.offset)))
);
ok('le pas se resserre quand les lignes s’accumulent', huit[0].spacing < 0.6, huit[0].spacing);
ok('le faisceau connait toutes ses lignes', huit[0].group.length === 8, huit[0].group.length);

// Boulevard a double chaussee : la ligne y figure deux fois, une par sens.
const aller = [
  [0, 0],
  [60, 0],
];
const retour = [
  [60, 9],
  [0, 9],
];
const jumeaux = dropTwinRuns([
  { line: 0, points: aller },
  { line: 0, points: retour },
]);
ok('les deux chaussees d’un boulevard ne font qu’un ruban', jumeaux.length === 1, jumeaux.length);

// Deux rues paralleles bien distinctes doivent, elles, rester visibles.
const paralleles = dropTwinRuns([
  { line: 0, points: aller },
  {
    line: 0,
    points: [
      [0, 45],
      [60, 45],
    ],
  },
]);
ok('deux rues paralleles distinctes restent dessinees', paralleles.length === 2, paralleles.length);

// Une rue decoupee en deux voies successives ne doit pas perdre sa seconde
// moitie : les troncons se suivent, ils ne se superposent pas.
const successifs = dropTwinRuns([
  { line: 0, points: aller },
  {
    line: 0,
    points: [
      [60, 0],
      [120, 0],
    ],
  },
]);
ok('deux troncons successifs sont tous deux gardes', successifs.length === 2, successifs.length);

// Deux lignes differentes sur la meme rue ne sont pas des jumelles.
const distinctes = dropTwinRuns([
  { line: 0, points: aller },
  { line: 1, points: aller },
]);
ok('deux lignes sur la meme rue restent deux rubans', distinctes.length === 2, distinctes.length);

console.log(failures ? `\n${failures} verification(s) en echec` : '\nTout est conforme');
process.exit(failures ? 1 : 0);
