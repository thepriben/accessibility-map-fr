//! Construction de la scene ECS a partir de la charge utile du voisinage.

use bevy::prelude::*;

use crate::components::*;
use crate::data::ScenePayload;
use crate::geo::Origin;
use crate::mesh::extruded_polygon;

#[derive(Resource, Default)]
pub struct SceneInput(pub ScenePayload);

/// Hauteur d'un batiment : hauteur explicite, sinon etages x 3 m, sinon defaut.
fn building_height(height: Option<f64>, levels: Option<f64>) -> f32 {
    height
        .or(levels.map(|l| l * 3.0))
        .unwrap_or(9.0)
        .clamp(3.0, 200.0) as f32
}

/// Materiau plat "Doom" : couleur franche, sans eclairage (unlit).
fn flat(materials: &mut Assets<StandardMaterial>, r: f32, g: f32, b: f32) -> Handle<StandardMaterial> {
    materials.add(StandardMaterial {
        base_color: Color::srgb(r, g, b),
        unlit: true,
        ..default()
    })
}

/// Petit hash stable pour varier les couleurs des murs par batiment.
fn hash_id(s: &str) -> u32 {
    let mut h: u32 = 2166136261;
    for byte in s.bytes() {
        h ^= byte as u32;
        h = h.wrapping_mul(16777619);
    }
    h
}

pub fn setup(
    mut commands: Commands,
    mut meshes: ResMut<Assets<Mesh>>,
    mut materials: ResMut<Assets<StandardMaterial>>,
    input: Res<SceneInput>,
) {
    let payload = &input.0;
    let origin = Origin::new(payload.place.lng, payload.place.lat);
    let dark = payload.is_dark();

    // Couleur de fond selon le theme (accord avec --scene-bg cote CSS).
    commands.insert_resource(ClearColor(if dark {
        Color::srgb(0.047, 0.059, 0.078)
    } else {
        Color::srgb(0.874, 0.902, 0.933)
    }));

    // Palette "Doom" : materiaux plats (unlit), couleurs franches.
    let ground_c = if dark { (0.09, 0.10, 0.12) } else { (0.62, 0.60, 0.55) };
    let mat_ground = flat(&mut materials, ground_c.0, ground_c.1, ground_c.2);
    let grid_c = if dark { (0.18, 0.20, 0.24) } else { (0.72, 0.70, 0.64) };
    let mat_grid = flat(&mut materials, grid_c.0, grid_c.1, grid_c.2);

    // Murs de batiments : teintes retro variees + surbrillance pour Wikidata.
    let wall_palette: Vec<Handle<StandardMaterial>> = [
        (0.62, 0.36, 0.30),
        (0.55, 0.47, 0.30),
        (0.40, 0.45, 0.55),
        (0.48, 0.40, 0.52),
        (0.35, 0.52, 0.50),
        (0.60, 0.55, 0.45),
    ]
    .iter()
    .map(|(r, g, b)| flat(&mut materials, *r, *g, *b))
    .collect();
    let mat_building_wd = flat(&mut materials, 0.85, 0.70, 0.25);

    let mat_place = flat(&mut materials, 0.83, 0.66, 0.33);
    let mat_bench = flat(&mut materials, 0.62, 0.40, 0.22);
    let mat_bus = flat(&mut materials, 0.20, 0.45, 0.85);
    let mat_fountain = flat(&mut materials, 0.25, 0.60, 0.85);
    let mat_tree = flat(&mut materials, 0.24, 0.55, 0.28);
    let mat_crossing = flat(&mut materials, 0.92, 0.92, 0.94);
    let mat_bollard = flat(&mut materials, 0.85, 0.30, 0.25);
    let mat_lamp = flat(&mut materials, 0.90, 0.82, 0.45);
    let mat_water = flat(&mut materials, 0.20, 0.70, 0.85);
    let mat_waste = flat(&mut materials, 0.45, 0.45, 0.48);
    let mat_path = flat(&mut materials, 0.42, 0.44, 0.48);
    let mat_park = flat(&mut materials, 0.24, 0.46, 0.28);
    let mat_mapillary = flat(&mut materials, 0.18, 0.70, 0.38);
    let mat_panoramax = flat(&mut materials, 0.85, 0.85, 0.90);

    // POI d'accueil : couleurs franches distinctes.
    let mat_hotel = flat(&mut materials, 0.55, 0.35, 0.75);
    let mat_restaurant = flat(&mut materials, 0.88, 0.30, 0.30);
    let mat_cafe = flat(&mut materials, 0.80, 0.55, 0.25);
    let mat_community = flat(&mut materials, 0.20, 0.65, 0.62);
    let mat_worship = flat(&mut materials, 0.45, 0.50, 0.85);

    // Meshes de base reutilisables : cube (volumes) + quad (billboards).
    let unit_cube = meshes.add(Cuboid::new(1.0, 1.0, 1.0));
    let quad = meshes.add(Rectangle::new(1.0, 1.0));

    // --- Sol + grille retro ---
    commands.spawn(PbrBundle {
        mesh: meshes.add(Cuboid::new(400.0, 0.1, 400.0)),
        material: mat_ground.clone(),
        transform: Transform::from_xyz(0.0, -0.06, 0.0),
        ..default()
    });
    let span = 120.0_f32;
    let mut g = -span;
    while g <= span {
        commands.spawn(PbrBundle {
            mesh: unit_cube.clone(),
            material: mat_grid.clone(),
            transform: Transform {
                translation: Vec3::new(0.0, 0.0, g),
                scale: Vec3::new(span * 2.0, 0.04, 0.15),
                ..default()
            },
            ..default()
        });
        commands.spawn(PbrBundle {
            mesh: unit_cube.clone(),
            material: mat_grid.clone(),
            transform: Transform {
                translation: Vec3::new(g, 0.0, 0.0),
                scale: Vec3::new(0.15, 0.04, span * 2.0),
                ..default()
            },
            ..default()
        });
        g += 10.0;
    }

    // --- Batiments extrudes ---
    for b in &payload.neighborhood.buildings {
        if b.ring.len() < 3 {
            continue;
        }
        let ring: Vec<(f32, f32)> = b.ring.iter().map(|p| origin.to_local(p[0], p[1])).collect();
        let h = building_height(b.height, b.levels);
        let mat = if b.wikidata.is_some() {
            mat_building_wd.clone()
        } else {
            wall_palette[(hash_id(&b.id) as usize) % wall_palette.len()].clone()
        };
        commands.spawn((
            PbrBundle {
                mesh: meshes.add(extruded_polygon(&ring, h)),
                material: mat,
                ..default()
            },
            BuildingTag {
                id: b.id.clone(),
                wikidata: b.wikidata.clone(),
                name: b.name.clone(),
                height: h,
            },
        ));
    }

    // --- Cheminements / parcs (rubans plats le long des polylignes) ---
    for path in &payload.neighborhood.paths {
        let (mat, width) = match path.kind.as_str() {
            "park" => (mat_park.clone(), 2.5),
            "sidewalk" => (mat_path.clone(), 1.6),
            _ => (mat_path.clone(), 1.2),
        };
        let pts: Vec<(f32, f32)> = path.coords.iter().map(|p| origin.to_local(p[0], p[1])).collect();
        for seg in pts.windows(2) {
            let (x0, z0) = seg[0];
            let (x1, z1) = seg[1];
            let dx = x1 - x0;
            let dz = z1 - z0;
            let len = (dx * dx + dz * dz).sqrt();
            if len < 0.1 {
                continue;
            }
            let angle = dz.atan2(dx);
            commands.spawn((
                PbrBundle {
                    mesh: unit_cube.clone(),
                    material: mat.clone(),
                    transform: Transform {
                        translation: Vec3::new((x0 + x1) * 0.5, 0.03, (z0 + z1) * 0.5),
                        rotation: Quat::from_rotation_y(-angle),
                        scale: Vec3::new(len, 0.06, width),
                    },
                    ..default()
                },
                PathTag { kind: path.kind.clone() },
            ));
        }
    }

    // --- Mobilier / obstacles / points d'eau (billboards facon Doom) ---
    for f in &payload.neighborhood.furniture {
        let (x, z) = origin.to_local(f.lng, f.lat);
        // Passage pieton : marquage au sol (pas un billboard).
        if f.kind == "crossing" {
            commands.spawn((
                PbrBundle {
                    mesh: unit_cube.clone(),
                    material: mat_crossing.clone(),
                    transform: Transform {
                        translation: Vec3::new(x, 0.04, z),
                        scale: Vec3::new(2.0, 0.08, 3.0),
                        ..default()
                    },
                    ..default()
                },
                FurnitureTag { id: f.id.clone(), kind: f.kind.clone() },
            ));
            continue;
        }
        let (mat, w, h) = match f.kind.as_str() {
            "bench" => (mat_bench.clone(), 1.8, 0.9),
            "bus_stop" => (mat_bus.clone(), 1.6, 3.0),
            "fountain" => (mat_fountain.clone(), 1.6, 1.4),
            "tree" => (mat_tree.clone(), 3.2, 5.0),
            "bollard" => (mat_bollard.clone(), 0.4, 1.0),
            "lamp" => (mat_lamp.clone(), 0.5, 4.5),
            "drinking_water" => (mat_water.clone(), 0.7, 1.2),
            "waste" => (mat_waste.clone(), 0.7, 1.0),
            _ => (mat_path.clone(), 0.8, 1.0),
        };
        commands.spawn((
            PbrBundle {
                mesh: quad.clone(),
                material: mat,
                transform: Transform {
                    translation: Vec3::new(x, h * 0.5, z),
                    scale: Vec3::new(w, h, 1.0),
                    ..default()
                },
                ..default()
            },
            FurnitureTag { id: f.id.clone(), kind: f.kind.clone() },
            Billboard,
        ));
    }

    // --- Lieux d'accueil (POI) : billboards colores, un peu plus hauts ---
    for p in &payload.neighborhood.pois {
        let (x, z) = origin.to_local(p.lng, p.lat);
        let mat = match p.kind.as_str() {
            "hotel" => mat_hotel.clone(),
            "restaurant" => mat_restaurant.clone(),
            "cafe" => mat_cafe.clone(),
            "community" => mat_community.clone(),
            "worship" => mat_worship.clone(),
            _ => mat_community.clone(),
        };
        let h = 3.2;
        commands.spawn((
            PbrBundle {
                mesh: quad.clone(),
                material: mat,
                transform: Transform {
                    translation: Vec3::new(x, 2.0 + h * 0.5, z),
                    scale: Vec3::new(2.2, h, 1.0),
                    ..default()
                },
                ..default()
            },
            PoiTag { id: p.id.clone(), kind: p.kind.clone(), name: p.name.clone() },
            Billboard,
        ));
    }

    // --- Marqueurs d'imagerie de rue (billboards face camera) ---
    for p in &payload.photos {
        let (x, z) = origin.to_local(p.lng, p.lat);
        let mat = if p.provider == "mapillary" {
            mat_mapillary.clone()
        } else {
            mat_panoramax.clone()
        };
        commands.spawn((
            PbrBundle {
                mesh: quad.clone(),
                material: mat,
                transform: Transform {
                    translation: Vec3::new(x, 2.6, z),
                    scale: Vec3::new(3.0, 2.0, 1.0),
                    ..default()
                },
                ..default()
            },
            PhotoTag { id: p.id.clone(), provider: p.provider.clone() },
            Billboard,
        ));
    }

    // --- Repere du lieu Acceslibre (au centre) ---
    commands.spawn((
        PbrBundle {
            mesh: meshes.add(Cylinder::new(1.2, 6.0)),
            material: mat_place,
            transform: Transform::from_xyz(0.0, 3.0, 0.0),
            ..default()
        },
        AccessiblePlaceTag { nom: payload.place.nom.clone() },
    ));

    // --- Eclairage (sobre, sans ombres pour la perf WASM) ---
    commands.insert_resource(AmbientLight {
        color: if dark {
            Color::srgb(0.45, 0.5, 0.62)
        } else {
            Color::srgb(0.85, 0.88, 0.95)
        },
        brightness: if dark { 220.0 } else { 380.0 },
    });
    commands.spawn(DirectionalLightBundle {
        directional_light: DirectionalLight {
            illuminance: if dark { 5500.0 } else { 9000.0 },
            shadows_enabled: false,
            ..default()
        },
        transform: Transform::from_xyz(60.0, 120.0, 40.0).looking_at(Vec3::ZERO, Vec3::Y),
        ..default()
    });

    // --- Camera ---
    commands.spawn(Camera3dBundle {
        transform: Transform::from_xyz(70.0, 90.0, 70.0).looking_at(Vec3::new(0.0, 2.0, 0.0), Vec3::Y),
        ..default()
    });
}
