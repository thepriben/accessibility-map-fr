// Sonde ponctuelle : verifie que la requete Overpass du voisinage repond bien
// (notamment le bloc `foreach` des lignes de bus) et resume ce qu'elle ramene.
// Usage : node scripts/probe-overpass.mjs [lat] [lng] [rayon_m]

const lat = parseFloat(process.argv[2] ?? '46.12640');
const lng = parseFloat(process.argv[3] ?? '3.42560');
const radiusM = parseFloat(process.argv[4] ?? '100');

const dLat = radiusM / 111320;
const dLng = radiusM / (111320 * Math.cos((lat * Math.PI) / 180));
const b = `${lat - dLat},${lng - dLng},${lat + dLat},${lng + dLng}`;

const query = `[out:json][timeout:25];
    (
      way["building"](${b});
      way["highway"="footway"](${b});
      way["footway"="sidewalk"](${b});
      way["footway"="crossing"](${b});
      way["highway"="pedestrian"](${b});
      way["highway"="steps"](${b});
      way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|road)$"](${b});
      node["amenity"="bench"](${b});
      node["highway"="bus_stop"](${b});
      node["public_transport"="platform"](${b});
      node["amenity"="parking_space"](${b});
      way["amenity"="parking_space"](${b});
      way["amenity"="parking"](${b});
      node["natural"="tree"](${b});
      way["natural"="tree_row"](${b});
      node["emergency"="fire_hydrant"](${b});
      node["man_made"="street_cabinet"](${b});
      node["amenity"="drinking_water"](${b});
      node["amenity"="fountain"](${b});
      way["amenity"="fountain"](${b});
      node["barrier"="kerb"](${b});
      node["kerb"](${b});
    );
    out geom tags;
    rel["route"~"^(bus|trolleybus)$"](${b})->.br;
    foreach.br->.r (
      .r out tags;
      way(r.r)(${b});
      out skel geom;
    );`;

const res = await fetch('https://overpass-api.de/api/interpreter', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/x-www-form-urlencoded',
    'User-Agent': 'accessibility-map-fr/dev (https://github.com/thepriben/accessibility-map-fr)',
  },
  body: `data=${encodeURIComponent(query)}`,
});
if (!res.ok) {
  console.error('HTTP', res.status, (await res.text()).slice(0, 800));
  process.exit(1);
}
const data = await res.json();
if (data.remark) console.warn('remark:', data.remark);

const els = data.elements ?? [];
const busStart = els.findIndex((e) => e.type === 'relation' && e.tags?.route);
const main = busStart >= 0 ? els.slice(0, busStart) : els;

const tally = {};
const bump = (k) => {
  tally[k] = (tally[k] ?? 0) + 1;
};
for (const el of main) {
  const t = el.tags ?? {};
  if (t.building) bump('batiment');
  if (t.highway === 'steps') bump('escalier');
  if (t.footway === 'crossing') bump('passage pieton');
  if (t.footway === 'sidewalk') bump('trottoir');
  if (t.amenity === 'parking_space') bump(`place (${el.type}${el.geometry ? ', empreinte' : ''})`);
  if (t.amenity === 'parking') bump('parking surfacique');
  if (t.natural === 'tree') bump('arbre');
  if (t.natural === 'tree_row') bump('alignement arbres');
  if (t.emergency === 'fire_hydrant') bump('borne incendie');
  if (t.man_made === 'street_cabinet') bump('armoire de rue');
  if (t.amenity === 'drinking_water') bump('eau potable');
  if (t.amenity === 'fountain') bump('fontaine');
  if (t.kerb || t.barrier === 'kerb') bump(`bordure (${t.kerb ?? '?'})`);
  if (t.highway === 'bus_stop') bump(`arret bus (abri=${t.shelter ?? '?'} banc=${t.bench ?? '?'})`);
}

console.log(`elements: ${els.length} (dont ${main.length} hors lignes de bus)`);
console.log(tally);

let route = null;
const routes = [];
for (const el of els.slice(Math.max(busStart, 0))) {
  if (busStart < 0) break;
  if (el.type === 'relation') {
    route = { ref: el.tags?.ref, colour: el.tags?.colour, ways: 0, pts: 0 };
    routes.push(route);
  } else if (el.type === 'way' && route) {
    route.ways += 1;
    route.pts += el.geometry?.length ?? 0;
  }
}
console.log('lignes de bus:', routes.length ? routes : 'aucune');
