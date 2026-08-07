// Verifie la geometrie d'orientation de la scene 3D (src/three/orient.ts) sur
// des cas de reference : sens d'un banc, orientation d'une place selon son
// empreinte / son parking / la rue. Usage : node scripts/check-orient.mjs
import { build } from 'esbuild';

const bundle = await build({
  entryPoints: ['src/three/orient.ts'],
  bundle: true,
  format: 'esm',
  write: false,
  platform: 'neutral',
});
const mod = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
);
const { alignX, benchAngle, faceBearing, localSideZ, orientedBox, parkingStall } = mod;

let failures = 0;
const DEG = 180 / Math.PI;

/** Direction monde (x = est, z = sud) vers laquelle pointe l'axe +Z apres rotation. */
const facing = (angle) => [Math.sin(angle), Math.cos(angle)];
/** Direction monde de l'axe +X apres rotation (axe long des objets allonges). */
const longAxis = (angle) => [Math.cos(angle), -Math.sin(angle)];
/** Azimut (0 = nord, 90 = est) d'une direction monde. */
const bearing = (dx, dz) => ((Math.atan2(dx, -dz) * DEG) % 360 + 360) % 360;

function check(label, got, want, tol = 1e-6) {
  const ok = Math.abs(got - want) <= tol;
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label} : ${got.toFixed(2)} (attendu ${want.toFixed(2)})`);
}

/** Deux azimuts equivalents modulo 180 (un axe n'a pas de sens). */
function checkAxis(label, gotDeg, wantDeg, tol = 0.5) {
  const d = Math.abs((((gotDeg - wantDeg) % 180) + 180) % 180);
  const ok = Math.min(d, 180 - d) <= tol;
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label} : axe ${gotDeg.toFixed(1)}° (attendu ${wantDeg}° mod 180)`);
}

console.log('\n— Azimuts —');
// Un banc "direction=90" (est) doit regarder vers l'est : +X monde.
for (const [deg, name, want] of [
  [0, 'nord', [0, -1]],
  [90, 'est', [1, 0]],
  [180, 'sud', [0, 1]],
  [270, 'ouest', [-1, 0]],
]) {
  const [fx, fz] = facing(faceBearing(deg));
  check(`regarde vers le ${name} (x)`, fx, want[0], 1e-9);
  check(`regarde vers le ${name} (z)`, fz, want[1], 1e-9);
}

console.log('\n— Banc : tag direction OSM —');
// direction=SW (225°) : le banc regarde vers le sud-ouest.
const swAngle = benchAngle(0, 0, 225, []);
check('banc SW -> azimut', bearing(...facing(swAngle)), 225, 0.001);

console.log('\n— Banc : deduit du cheminement —');
// Trottoir horizontal (est-ouest) a z = +3 ; banc a l'origine.
// Attendu : axe long est-ouest, assise tournee vers le trottoir (donc sud, 180°).
{
  const guides = [[[-20, 3], [20, 3]]];
  const a = benchAngle(0, 0, null, guides);
  checkAxis('axe long parallele au trottoir', bearing(...longAxis(a)), 90);
  check('assise tournee vers le trottoir', bearing(...facing(a)), 180, 0.001);
}
// Meme trottoir mais de l'autre cote (z = -3) : le banc doit se retourner (nord).
{
  const guides = [[[-20, -3], [20, -3]]];
  const a = benchAngle(0, 0, null, guides);
  check('banc retourne quand le trottoir change de cote', bearing(...facing(a)), 0, 0.001);
}
// Cheminement nord-sud a l'est du banc : assise vers l'est.
{
  const guides = [[[4, -20], [4, 20]]];
  const a = benchAngle(0, 0, null, guides);
  check('cheminement a l’est -> assise vers l’est', bearing(...facing(a)), 90, 0.001);
}

console.log('\n— localSideZ —');
{
  const angle = alignX(1, 0); // +X local vers l'est
  check('point au sud = cote +Z', localSideZ(0, 5, angle), 1, 0);
  check('point au nord = cote -Z', localSideZ(0, -5, angle), -1, 0);
}

console.log('\n— Place : empreinte OSM —');
// Rectangle 2.5 x 5 tourne de 30°, cartographie tel quel.
{
  const rot = (30 * Math.PI) / 180;
  const corners = [[-2.5, -1.25], [2.5, -1.25], [2.5, 1.25], [-2.5, 1.25]].map(([u, v]) => [
    u * Math.cos(rot) - v * Math.sin(rot) + 40,
    u * Math.sin(rot) + v * Math.cos(rot) - 10,
  ]);
  const box = orientedBox(corners);
  check('grand cote mesure 5 m', Math.max(box.width, box.depth), 5, 0.01);
  check('petit cote mesure 2,5 m', Math.min(box.width, box.depth), 2.5, 0.01);
  const stall = parkingStall({ x: 40, z: -10, pmr: false, ring: corners, host: null, roads: [] });
  check('longueur reprise de l’empreinte', stall.long, 5, 0.01);
  check('largeur reprise de l’empreinte', stall.short, 2.5, 0.01);
  // Grand axe = image de (u=1, v=0), soit (cos30, sin30) = (est 0,87 ; sud 0,5),
  // donc un azimut de 120° : z pointant vers le sud, une rotation de +30° dans
  // le plan (x, z) fait tourner vers le sud, pas vers le nord.
  checkAxis('vehicule dans l’axe de l’empreinte', bearing(...longAxis(stall.angle)), 120);
}

console.log('\n— Place : deduite du parking englobant —');
// Parking allonge est-ouest : les vehicules se rangent en bataille, donc
// perpendiculairement a l'allee -> axe nord-sud.
{
  const host = [[-30, -10], [30, -10], [30, 10], [-30, 10]];
  const stall = parkingStall({ x: 0, z: 0, pmr: true, ring: null, host, roads: [] });
  checkAxis('vehicule perpendiculaire a l’allee', bearing(...longAxis(stall.angle)), 0);
  check('place PMR elargie', stall.short, 3.3, 1e-9);
}

console.log('\n— Place : deduite de la rue (stationnement longitudinal) —');
{
  const roads = [[[-50, 6], [50, 6]]];
  const stall = parkingStall({ x: 0, z: 0, pmr: false, ring: null, host: null, roads });
  checkAxis('vehicule dans l’axe de la rue', bearing(...longAxis(stall.angle)), 90);
  check('place ordinaire', stall.short, 2.5, 1e-9);
}

console.log(failures ? `\n${failures} verification(s) en echec` : '\nToutes les verifications passent');
process.exit(failures ? 1 : 0);
