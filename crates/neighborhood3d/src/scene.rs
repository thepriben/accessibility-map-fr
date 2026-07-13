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

pub fn setup(
    mut commands: Commands,
    mut meshes: ResMut<Assets<Mesh>>,
    mut materials: ResMut<Assets<StandardMaterial>>,
    input: Res<SceneInput>,
) {
    let payload = &input.0;
    let origin = Origin::new(payload.place.lng, payload.place.lat);

    // Materiaux reutilisables (palette sobre).
    let mat_building = materials.add(StandardMaterial {
        base_color: Color::srgb(0.80, 0.81, 0.84),
        perceptual_roughness: 0.95,
        ..default()
    });
    let mat_building_wd = materials.add(StandardMaterial {
        base_color: Color::srgb(0.72, 0.78, 0.86),
        perceptual_roughness: 0.9,
        ..default()
    });
    let mat_ground = materials.add(StandardMaterial {
        base_color: Color::srgb(0.16, 0.19, 0.24),
        perceptual_roughness: 1.0,
        ..default()
    });
    let mat_place = materials.add(StandardMaterial {
        base_color: Color::srgb(0.18, 0.62, 0.36),
        emissive: LinearRgba::rgb(0.05, 0.25, 0.12),
        ..default()
    });
    let mat_bench = materials.add(Color::srgb(0.55, 0.38, 0.22));
    let mat_bus = materials.add(Color::srgb(0.20, 0.42, 0.78));
    let mat_fountain = materials.add(Color::srgb(0.30, 0.55, 0.80));
    let mat_tree = materials.add(Color::srgb(0.22, 0.5, 0.26));
    let mat_crossing = materials.add(Color::srgb(0.9, 0.9, 0.92));
    let mat_path = materials.add(Color::srgb(0.4, 0.42, 0.46));
    let mat_park = materials.add(Color::srgb(0.24, 0.44, 0.28));
    let mat_mapillary = materials.add(StandardMaterial {
        base_color: Color::srgb(0.18, 0.62, 0.34),
        ..default()
    });
    let mat_panoramax = materials.add(StandardMaterial {
        base_color: Color::srgb(0.82, 0.85, 0.90),
        ..default()
    });

    // Meshes de base reutilisables.
    let unit_cube = meshes.add(Cuboid::new(1.0, 1.0, 1.0));

    // --- Sol ---
    commands.spawn(PbrBundle {
        mesh: meshes.add(Cuboid::new(400.0, 0.1, 400.0)),
        material: mat_ground.clone(),
        transform: Transform::from_xyz(0.0, -0.06, 0.0),
        ..default()
    });

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
            mat_building.clone()
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

    // --- Mobilier urbain (30 derniers metres) ---
    for f in &payload.neighborhood.furniture {
        let (x, z) = origin.to_local(f.lng, f.lat);
        let (mat, scale, y, mesh) = match f.kind.as_str() {
            "bench" => (mat_bench.clone(), Vec3::new(1.6, 0.5, 0.5), 0.25, unit_cube.clone()),
            "bus_stop" => (mat_bus.clone(), Vec3::new(0.25, 3.0, 0.25), 1.5, unit_cube.clone()),
            "fountain" => (
                mat_fountain.clone(),
                Vec3::ONE,
                0.4,
                meshes.add(Cylinder::new(0.8, 0.8)),
            ),
            "tree" => (mat_tree.clone(), Vec3::ONE, 2.0, meshes.add(Sphere::new(1.6))),
            "crossing" => (mat_crossing.clone(), Vec3::new(2.0, 0.05, 3.0), 0.03, unit_cube.clone()),
            _ => (mat_path.clone(), Vec3::splat(0.6), 0.3, unit_cube.clone()),
        };
        commands.spawn((
            PbrBundle {
                mesh,
                material: mat,
                transform: Transform {
                    translation: Vec3::new(x, y, z),
                    scale,
                    ..default()
                },
                ..default()
            },
            FurnitureTag { id: f.id.clone(), kind: f.kind.clone() },
        ));
    }

    // --- Marqueurs d'imagerie de rue (billboards orientes par azimut) ---
    for p in &payload.photos {
        let (x, z) = origin.to_local(p.lng, p.lat);
        let mat = if p.provider == "mapillary" {
            mat_mapillary.clone()
        } else {
            mat_panoramax.clone()
        };
        let yaw = p.azimuth.map(|a| -(a as f32).to_radians()).unwrap_or(0.0);
        commands.spawn((
            PbrBundle {
                mesh: unit_cube.clone(),
                material: mat,
                transform: Transform {
                    translation: Vec3::new(x, 2.6, z),
                    rotation: Quat::from_rotation_y(yaw),
                    scale: Vec3::new(3.0, 2.0, 0.2),
                },
                ..default()
            },
            PhotoTag { id: p.id.clone(), provider: p.provider.clone() },
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
        color: Color::srgb(0.85, 0.88, 0.95),
        brightness: 380.0,
    });
    commands.spawn(DirectionalLightBundle {
        directional_light: DirectionalLight {
            illuminance: 9000.0,
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
