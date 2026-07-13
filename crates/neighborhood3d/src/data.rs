//! Structures de la charge utile envoyee par le frontend (JSON) a la scene.

use serde::Deserialize;

#[derive(Debug, Clone, Deserialize, Default)]
pub struct ScenePayload {
    pub place: PlaceInfo,
    pub neighborhood: Neighborhood,
    #[serde(default)]
    pub photos: Vec<StreetPhoto>,
    /// Thème de rendu : "dark" ou "light" (défaut light).
    #[serde(default)]
    pub theme: Option<String>,
}

impl ScenePayload {
    pub fn is_dark(&self) -> bool {
        self.theme.as_deref() == Some("dark")
    }
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct PlaceInfo {
    #[serde(default)]
    pub nom: String,
    pub lng: f64,
    pub lat: f64,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct Neighborhood {
    pub center: Center,
    #[serde(default)]
    pub buildings: Vec<Building>,
    #[serde(default)]
    pub furniture: Vec<Furniture>,
    #[serde(default)]
    pub paths: Vec<Path>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct Center {
    pub lng: f64,
    pub lat: f64,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct Building {
    #[serde(default)]
    pub id: String,
    /// Anneau exterieur : liste de [lng, lat].
    #[serde(default)]
    pub ring: Vec<[f64; 2]>,
    pub levels: Option<f64>,
    pub height: Option<f64>,
    #[serde(default)]
    pub wikidata: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct Furniture {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub kind: String,
    pub lng: f64,
    pub lat: f64,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct Path {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub coords: Vec<[f64; 2]>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct StreetPhoto {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub provider: String,
    pub lng: f64,
    pub lat: f64,
    pub azimuth: Option<f64>,
}
