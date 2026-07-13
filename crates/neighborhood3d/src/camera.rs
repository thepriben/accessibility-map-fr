//! Camera orbitale minimale (drag souris + molette) + deplacement (pan) et
//! systeme de billboards, sans dependance externe.

use bevy::input::mouse::{MouseMotion, MouseWheel};
use bevy::prelude::*;

use crate::components::Billboard;

#[derive(Resource)]
pub struct OrbitCamera {
    pub focus: Vec3,
    pub yaw: f32,
    pub pitch: f32,
    pub radius: f32,
}

impl Default for OrbitCamera {
    fn default() -> Self {
        Self {
            focus: Vec3::ZERO,
            yaw: 0.6,
            pitch: 0.8,
            radius: 120.0,
        }
    }
}

pub fn orbit(
    mut orbit: ResMut<OrbitCamera>,
    buttons: Res<ButtonInput<MouseButton>>,
    mut motion: EventReader<MouseMotion>,
    mut wheel: EventReader<MouseWheel>,
    mut q: Query<&mut Transform, With<Camera>>,
) {
    let mut changed = false;
    let left = buttons.pressed(MouseButton::Left);
    // Bouton droit ou molette : deplacement (pan) dans le voisinage.
    let pan = buttons.pressed(MouseButton::Right) || buttons.pressed(MouseButton::Middle);

    for ev in motion.read() {
        if pan {
            let (sy, cy) = orbit.yaw.sin_cos();
            let scale = orbit.radius * 0.0016;
            let right_dir = Vec3::new(cy, 0.0, -sy);
            let fwd_dir = Vec3::new(sy, 0.0, cy);
            orbit.focus += right_dir * (-ev.delta.x * scale) + fwd_dir * (ev.delta.y * scale);
            changed = true;
        } else if left {
            orbit.yaw -= ev.delta.x * 0.005;
            orbit.pitch = (orbit.pitch - ev.delta.y * 0.005).clamp(0.12, 1.5);
            changed = true;
        }
    }

    for ev in wheel.read() {
        orbit.radius = (orbit.radius * (1.0 - ev.y * 0.1)).clamp(8.0, 600.0);
        changed = true;
    }

    if !changed {
        return;
    }

    if let Ok(mut tf) = q.get_single_mut() {
        let (sy, cy) = orbit.yaw.sin_cos();
        let (sp, cp) = orbit.pitch.sin_cos();
        let offset = Vec3::new(cp * sy, sp, cp * cy) * orbit.radius;
        tf.translation = orbit.focus + offset;
        tf.look_at(orbit.focus, Vec3::Y);
    }
}

/// Oriente les sprites "billboard" face a la camera (rotation en yaw seulement,
/// ils restent verticaux facon Doom).
pub fn billboard(
    cam_q: Query<&Transform, (With<Camera>, Without<Billboard>)>,
    mut q: Query<&mut Transform, With<Billboard>>,
) {
    let Ok(cam) = cam_q.get_single() else {
        return;
    };
    let cp = cam.translation;
    for mut tf in &mut q {
        let dx = cp.x - tf.translation.x;
        let dz = cp.z - tf.translation.z;
        tf.rotation = Quat::from_rotation_y(dx.atan2(dz));
    }
}
