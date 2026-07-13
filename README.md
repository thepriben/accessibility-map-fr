# accessibility-map-fr

Carte collaborative de l'accessibilite des lieux publics en France, a partir des
donnees [Acceslibre](https://acceslibre.beta.gouv.fr/). Site statique (GitHub
Pages) avec une montee en puissance progressive : carte 2D a grappes, vue liste
accessible (RGAA), puis vue 3D sobre du voisinage (Bevy/WASM) et imagerie de rue.

Projet realise dans le cadre d'un concours sur le handicap.

## Fonctionnalites

- **Carte 2D** (MapLibre GL) : clustering des etablissements Acceslibre sur toute
  la France, filtres par besoin d'accessibilite, attribution custom (sans drapeau
  Ukraine), fond CARTO sobre.
- **Vue liste accessible** (RGAA/WCAG) : meme jeu de lieux, navigable au clavier,
  avec libelles explicites - l'alternative accessible a la carte et a la 3D.
- **Fiche de lieu** : criteres d'accessibilite, voisinage OSM (les "30 derniers
  metres"), imagerie de rue a proximite (Panoramax + Mapillary).
- **Vue 3D** (Rust + Bevy -> WASM) : batiments extrudes (OSM, enrichis Wikidata),
  mobilier urbain (bancs, arrets de bus, fontaines, arbres, passages pietons),
  marqueurs d'imagerie orientes par azimut. Repere local ENU par voisinage.
- **Transition 2D -> 3D** : fondu du canvas Bevy par-dessus la carte, chargement
  paresseux du module WASM.

## Architecture

```
pipeline/     Scripts Node (build-time) : Acceslibre -> GeoJSON -> PMTiles, Wikidata
frontend/     App Vite + TypeScript (MapLibre, vue accessible, transition)
crates/
  neighborhood3d/   Crate Rust Bevy compilee en WASM (scene 3D ECS)
.github/workflows/  data.yml (tuiles) + deploy.yml (Pages + WASM)
```

Le flux de donnees : la cle API Acceslibre n'est utilisee **qu'au build** (secret
GitHub Actions), jamais cote navigateur. Les tuiles PMTiles sont publiees comme
asset de release et lues par MapLibre via des requetes HTTP par plage.

## Developpement local

### Frontend (mode echantillon, sans cle)

```bash
cd frontend
npm install
npm run dev
```

L'app lit `public/data/config.json` + `public/data/sample.geojson` (echantillon
Paris versionne). Aucune cle requise.

### Regenerer l'echantillon (necessite la cle Acceslibre)

```bash
cd pipeline
ACCESLIBRE_API_KEY=xxx node src/make-sample.mjs --commune Paris --max-pages 14
```

### Construire la 3D (Bevy -> WASM)

```bash
# rustup target add wasm32-unknown-unknown
wasm-pack build crates/neighborhood3d --release --target web \
  --out-dir ../../frontend/public/wasm --out-name neighborhood3d
```

Sans ce build, l'app reste pleinement fonctionnelle en 2D (la 3D se degrade
proprement).

## Donnees en production (France entiere)

Le workflow `data.yml` (secret `ACCESLIBRE_API_KEY`) recupere l'integralite des
ERP, genere les PMTiles avec [tippecanoe](https://github.com/felt/tippecanoe) et
les publie dans la release `data-latest`. Le workflow `deploy.yml` bascule alors
`config.json` en mode `pmtiles` pointant vers cette release.

## Secrets a configurer (Settings > Secrets and variables > Actions)

- `ACCESLIBRE_API_KEY` : cle API Acceslibre (a **regenerer** si elle a fuite).
- `VITE_MAPILLARY_TOKEN` (optionnel) : token Mapillary. Sans lui, seule
  l'imagerie Panoramax est active (aucune cle requise).

## Accessibilite du site

Un concours sur le handicap impose que le site soit lui-meme accessible. La 3D
(canvas WebGL) n'etant pas exploitable au lecteur d'ecran, la **vue liste** offre
une alternative textuelle complete, navigable au clavier, couvrant les memes
lieux et criteres.

## Sources et licences

- Etablissements : Acceslibre (Licence Ouverte / Etalab 2.0).
- Fonds de carte et voisinage : OpenStreetMap (ODbL), tuiles CARTO.
- Batiments notables : Wikidata (CC0).
- Imagerie de rue : Panoramax et Mapillary.
