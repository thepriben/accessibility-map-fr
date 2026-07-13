//! Composants ECS de la scene (modele Entity-Component-System de Bevy).

use bevy::prelude::*;

/// Batiment extrude (footprint OSM + hauteur), eventuellement lie a Wikidata.
#[derive(Component, Debug, Clone)]
pub struct BuildingTag {
    pub id: String,
    pub wikidata: Option<String>,
    pub name: Option<String>,
    pub height: f32,
}

/// Mobilier urbain des "30 derniers metres".
#[derive(Component, Debug, Clone)]
pub struct FurnitureTag {
    pub id: String,
    pub kind: String,
}

/// Cheminement pieton / trottoir / parc.
#[derive(Component, Debug, Clone)]
pub struct PathTag {
    pub kind: String,
}

/// Le lieu Acceslibre lui-meme (repere central).
#[derive(Component, Debug, Clone)]
pub struct AccessiblePlaceTag {
    pub nom: String,
}

/// Marqueur d'une photo de rue (Panoramax / Mapillary), oriente par azimut.
#[derive(Component, Debug, Clone)]
pub struct PhotoTag {
    pub id: String,
    pub provider: String,
}

/// Lieu d'accueil (hotel, restaurant, cafe, communautaire, cultuel).
#[derive(Component, Debug, Clone)]
pub struct PoiTag {
    pub id: String,
    pub kind: String,
    pub name: Option<String>,
}

/// Sprite "billboard" facon Doom : toujours oriente face a la camera (yaw).
#[derive(Component, Debug, Clone, Default)]
pub struct Billboard;
