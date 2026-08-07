// Analyse des empreintes de batiments d'un voisinage : taille, hauteur declaree
// et effet du retrait applique au rendu. Sert a reperer les tres petites
// empreintes (tombes, cabanons, kiosques) qui s'extrudent mal en 3D.
// Usage : node scripts/analyze-buildings.mjs [lat] [lng] [rayon_m]

const lat = parseFloat(process.argv[2] ?? '46.12640');
const lng = parseFloat(process.argv[3] ?? '3.42560');
const radiusM = parseFloat(process.argv[4] ?? '100');

const M_PER_DEG_LAT = 111320;
const dLat = radiusM / M_PER_DEG_LAT;
const dLng = radiusM / (M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180));
const b = `${lat - dLat},${lng - dLng},${lat + dLat},${lng + dLng}`;

// Overpass renvoie une page d'erreur XML quand il est sature : on reessaie.
const MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.osm.ch/api/interpreter',
];
const query = `[out:json][timeout:25];way["building"](${b});out geom tags;`;

async function ask() {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    for (const url of MIRRORS) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent':
              'accessibility-map-fr/dev (https://github.com/thepriben/accessibility-map-fr)',
          },
          body: `data=${encodeURIComponent(query)}`,
        });
        const text = await res.text();
        if (!res.ok || !text.startsWith('{')) continue;
        return JSON.parse(text);
      } catch {
        // miroir injoignable : on passe au suivant
      }
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error('Overpass indisponible');
}

const data = await ask();
if (data.remark) console.warn('remark:', data.remark);

const mPerDegLng = M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);
const toLocal = (p) => [(p.lon - lng) * mPerDegLng, -(p.lat - lat) * M_PER_DEG_LAT];

/** Aire d'un anneau (formule du lacet), en m². */
const area = (r) => {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i, i += 1) {
    a += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1]);
  }
  return Math.abs(a / 2);
};

/** Reproduit `insetRing` du rendu : chaque sommet avance vers le centroide. */
const insetRing = (ring, margin) => {
  const n = ring.length;
  const cx = ring.reduce((s, p) => s + p[0], 0) / n;
  const cz = ring.reduce((s, p) => s + p[1], 0) / n;
  return ring.map(([x, z]) => {
    const dx = cx - x;
    const dz = cz - z;
    const len = Math.hypot(dx, dz) || 1;
    return [x + (dx / len) * margin, z + (dz / len) * margin];
  });
};

/** Reproduit `buildingHeight` du rendu. */
const height = (t) => {
  const h = parseFloat(t.height) || (parseFloat(t['building:levels']) || 0) * 3 || 9;
  return Math.min(Math.max(h, 3), 200);
};

const rows = [];
for (const el of data.elements ?? []) {
  if (!Array.isArray(el.geometry) || el.geometry.length < 3) continue;
  const t = el.tags ?? {};
  const ring = el.geometry.map(toLocal);
  const a = area(ring);
  const inner = insetRing(ring, 0.6);
  const innerA = area(inner);
  const h = height(t);
  rows.push({
    id: el.id,
    type: t.building,
    aire: a,
    aireApresRetrait: innerA,
    // Le retrait retourne l'empreinte quand le batiment est plus etroit que
    // 1,2 m : la geometrie extrudee devient alors incoherente.
    retourne: innerA > a,
    hauteurDeclaree: t.height ?? t['building:levels'] ?? null,
    hauteurRendue: h,
    elance: h / Math.sqrt(Math.max(a, 0.01)),
  });
}

rows.sort((x, y) => x.aire - y.aire);
console.log(`${rows.length} empreintes de batiment dans ${radiusM} m`);

const petites = rows.filter((r) => r.aire < 12);
const retournees = rows.filter((r) => r.retourne);
// Elance > 2 : la hauteur rendue depasse deux fois la largeur -> aiguille.
const aiguilles = rows.filter((r) => r.elance > 2);

console.log(`  < 12 m²            : ${petites.length}`);
console.log(`  retournees par le retrait de 0,6 m : ${retournees.length}`);
console.log(`  rendues en aiguille (h > 2x largeur) : ${aiguilles.length}`);
console.log(`  sans hauteur declaree : ${rows.filter((r) => !r.hauteurDeclaree).length}`);

const typeTally = {};
for (const r of petites) typeTally[r.type] = (typeTally[r.type] ?? 0) + 1;
if (petites.length) console.log('\ntypes des petites empreintes :', typeTally);

console.log('\n10 plus petites :');
for (const r of rows.slice(0, 10)) {
  console.log(
    `  building=${String(r.type).padEnd(12)} aire ${r.aire.toFixed(1).padStart(6)} m²` +
      ` -> ${r.aireApresRetrait.toFixed(1).padStart(6)} m²` +
      ` | hauteur ${String(r.hauteurDeclaree ?? 'absente').padStart(7)} -> ${r.hauteurRendue} m` +
      `${r.retourne ? '  << EMPREINTE RETOURNEE' : ''}`
  );
}
