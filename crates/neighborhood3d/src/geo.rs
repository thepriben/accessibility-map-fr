//! Projection locale ENU (repere metrique tangent) autour d'une origine.
//!
//! Bevy travaille en f32 : projeter chaque voisinage dans un repere local centre
//! sur le lieu evite toute perte de precision a l'echelle des "30 metres".
//! Convention : x = est (m), z = -nord (m), y = hauteur (m) -> nord vers -Z.

const M_PER_DEG_LAT: f64 = 110_574.0;
const M_PER_DEG_LON_EQ: f64 = 111_320.0;

#[derive(Clone, Copy)]
pub struct Origin {
    pub lng: f64,
    pub lat: f64,
    cos_lat: f64,
}

impl Origin {
    pub fn new(lng: f64, lat: f64) -> Self {
        Self {
            lng,
            lat,
            cos_lat: (lat.to_radians()).cos(),
        }
    }

    /// (lng, lat) -> (x_est, z = -nord) en metres, tronque en f32.
    pub fn to_local(&self, lng: f64, lat: f64) -> (f32, f32) {
        let east = (lng - self.lng) * self.cos_lat * M_PER_DEG_LON_EQ;
        let north = (lat - self.lat) * M_PER_DEG_LAT;
        (east as f32, -north as f32)
    }
}
