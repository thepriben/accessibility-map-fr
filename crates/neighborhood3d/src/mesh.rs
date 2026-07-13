//! Construction de meshes : prisme extrude a partir d'un footprint (murs + toit).

use bevy::prelude::*;
use bevy::render::mesh::{Indices, PrimitiveTopology};
use bevy::render::render_asset::RenderAssetUsages;

/// Extrude un anneau (coordonnees locales x,z) de 0 a `height` : murs verticaux
/// + toit triangule (earcut). Renvoie un Mesh pret pour un PbrBundle.
pub fn extruded_polygon(ring: &[(f32, f32)], height: f32) -> Mesh {
    let mut positions: Vec<[f32; 3]> = Vec::new();
    let mut normals: Vec<[f32; 3]> = Vec::new();
    let mut uvs: Vec<[f32; 2]> = Vec::new();
    let mut indices: Vec<u32> = Vec::new();

    let n = ring.len();
    if n >= 3 {
        // --- Murs ---
        for i in 0..n {
            let (x0, z0) = ring[i];
            let (x1, z1) = ring[(i + 1) % n];
            let base = positions.len() as u32;

            // Normale du mur (perpendiculaire a l'arete, horizontale).
            let dx = x1 - x0;
            let dz = z1 - z0;
            let len = (dx * dx + dz * dz).sqrt().max(1e-4);
            let nx = dz / len;
            let nz = -dx / len;

            positions.push([x0, 0.0, z0]);
            positions.push([x1, 0.0, z1]);
            positions.push([x1, height, z1]);
            positions.push([x0, height, z0]);
            for _ in 0..4 {
                normals.push([nx, 0.0, nz]);
            }
            uvs.extend_from_slice(&[[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]]);

            indices.extend_from_slice(&[base, base + 1, base + 2, base, base + 2, base + 3]);
        }

        // --- Toit (triangulation earcut a y = height) ---
        let mut flat: Vec<f64> = Vec::with_capacity(n * 2);
        for &(x, z) in ring {
            flat.push(x as f64);
            flat.push(z as f64);
        }
        if let Ok(tri) = earcutr::earcut(&flat, &[], 2) {
            let base = positions.len() as u32;
            for &(x, z) in ring {
                positions.push([x, height, z]);
                normals.push([0.0, 1.0, 0.0]);
                uvs.push([0.0, 0.0]);
            }
            for idx in tri {
                indices.push(base + idx as u32);
            }
        }
    }

    let mut mesh = Mesh::new(
        PrimitiveTopology::TriangleList,
        RenderAssetUsages::RENDER_WORLD | RenderAssetUsages::MAIN_WORLD,
    );
    mesh.insert_attribute(Mesh::ATTRIBUTE_POSITION, positions);
    mesh.insert_attribute(Mesh::ATTRIBUTE_NORMAL, normals);
    mesh.insert_attribute(Mesh::ATTRIBUTE_UV_0, uvs);
    mesh.insert_indices(Indices::U32(indices));
    mesh
}
