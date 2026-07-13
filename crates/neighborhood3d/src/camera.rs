//! Camera orbitale minimale (drag souris + molette), sans dependance externe.

use bevy::input::mouse::{MouseMotion, MouseWheel};
use bevy::prelude::*;

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

    if buttons.pressed(MouseButton::Left) {
        for ev in motion.read() {
            orbit.yaw -= ev.delta.x * 0.005;
            orbit.pitch = (orbit.pitch - ev.delta.y * 0.005).clamp(0.12, 1.5);
            changed = true;
        }
    } else {
        motion.clear();
    }

    for ev in wheel.read() {
        orbit.radius = (orbit.radius * (1.0 - ev.y * 0.1)).clamp(15.0, 600.0);
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
