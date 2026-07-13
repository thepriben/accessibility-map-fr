//! Scene 3D sobre du voisinage d'un lieu Acceslibre (Bevy compile en WASM).
//!
//! Point d'entree JS : `start_neighborhood(canvas_id, payload_json)`.
//! La charge utile (voisinage OSM + imagerie de rue) est fournie par le
//! frontend ; elle est convertie en entites ECS (batiments, mobilier, photos).

mod camera;
mod components;
mod data;
mod geo;
mod mesh;
mod scene;

use bevy::prelude::*;
use bevy::window::WindowPlugin;
use camera::{billboard, orbit, OrbitCamera};
use data::ScenePayload;
use scene::{setup, SceneInput};
use wasm_bindgen::prelude::*;

/// Lance la scene 3D dans le canvas cible avec les donnees du voisinage.
#[wasm_bindgen]
pub fn start_neighborhood(canvas_id: String, payload_json: String) {
    console_error_panic_hook::set_once();

    let payload: ScenePayload = serde_json::from_str(&payload_json).unwrap_or_default();

    let selector = if canvas_id.starts_with('#') {
        canvas_id
    } else {
        format!("#{canvas_id}")
    };

    let mut app = App::new();
    app.add_plugins(
        DefaultPlugins
            .set(WindowPlugin {
                primary_window: Some(Window {
                    canvas: Some(selector),
                    fit_canvas_to_parent: true,
                    prevent_default_event_handling: true,
                    ..default()
                }),
                ..default()
            })
            .set(AssetPlugin {
                meta_check: bevy::asset::AssetMetaCheck::Never,
                ..default()
            }),
    )
    .insert_resource(ClearColor(Color::srgb(0.05, 0.08, 0.13)))
    .insert_resource(OrbitCamera::default())
    .insert_resource(SceneInput(payload))
    .add_systems(Startup, setup)
    .add_systems(Update, (orbit, billboard))
    .run();
}
