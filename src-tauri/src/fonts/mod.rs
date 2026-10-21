use std::{collections::BTreeMap, sync::Arc};

use font_kit::{
    family_name::FamilyName,
    handle::Handle,
    properties::{Properties, Style as FontKitStyle, Weight as FontKitWeight},
    source::SystemSource,
};
use fontdb::{Database, Family, Query, Stretch, Style, Weight};
use serde::Serialize;
use tauri::ipc::Response;
use tokio::sync::OnceCell;

#[derive(Default, Clone)]
pub struct FontManager {
    database: Arc<OnceCell<Arc<Database>>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemFontFamily {
    pub name: String,
    pub monospaced: bool,
    pub faces: Vec<SystemFontFace>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemFontFace {
    pub family: String,
    pub post_script_name: String,
    pub weight: u16,
    pub style: String,
    pub monospaced: bool,
    pub face_index: u32,
}

impl FontManager {
    pub async fn database(&self) -> Result<Arc<Database>, String> {
        self.database
            .get_or_try_init(|| async {
                tokio::task::spawn_blocking(load_database)
                    .await
                    .map_err(|error| error.to_string())
            })
            .await
            .map(Arc::clone)
    }

    pub async fn list_families(&self) -> Result<Vec<SystemFontFamily>, String> {
        let database = self.database().await?;
        let mut families: BTreeMap<String, SystemFontFamily> = BTreeMap::new();

        for face in database.faces() {
            let Some((family_name, _)) = face.families.first() else {
                continue;
            };
            let entry = families
                .entry(family_name.clone())
                .or_insert_with(|| SystemFontFamily {
                    name: family_name.clone(),
                    monospaced: face.monospaced,
                    faces: Vec::new(),
                });
            entry.monospaced |= face.monospaced;
            entry.faces.push(SystemFontFace {
                family: family_name.clone(),
                post_script_name: face.post_script_name.clone(),
                weight: face.weight.0,
                style: style_name(face.style),
                monospaced: face.monospaced,
                face_index: face.index,
            });
        }

        // fontdb scans standard font directories. Supplement the catalog with
        // the platform font database so fonts registered outside those
        // directories still appear in the settings picker.
        if let Ok(Ok(system_families)) =
            tokio::task::spawn_blocking(|| SystemSource::new().all_families()).await
        {
            for name in system_families {
                families
                    .entry(name.clone())
                    .or_insert_with(|| SystemFontFamily {
                        name,
                        monospaced: false,
                        faces: Vec::new(),
                    });
            }
        }

        let mut result: Vec<SystemFontFamily> = families.into_values().collect();
        for family in &mut result {
            family.faces.sort_by(|a, b| {
                (a.style.as_str(), a.weight, a.post_script_name.as_str()).cmp(&(
                    b.style.as_str(),
                    b.weight,
                    b.post_script_name.as_str(),
                ))
            });
        }
        result.sort_by_key(|family| family.name.to_lowercase());
        Ok(result)
    }

    pub async fn lookup(
        &self,
        family: &str,
        style: Option<&str>,
        weight: Option<u16>,
    ) -> Result<SystemFontFace, String> {
        let family_for_native = family.to_string();
        let style_for_native = style.map(str::to_string);
        let native = tokio::task::spawn_blocking(move || {
            lookup_native(&family_for_native, style_for_native.as_deref(), weight)
        })
        .await
        .map_err(|error| error.to_string());

        match native {
            Ok(Ok(face)) => Ok(face),
            Ok(Err(native_error)) => match self.lookup_fontdb(family, style, weight).await {
                Ok(face) => Ok(face),
                Err(fontdb_error) => Err(format!(
                    "font-kit failed: {native_error}; fontdb failed: {fontdb_error}"
                )),
            },
            Err(join_error) => Err(join_error),
        }
    }

    pub async fn font_data(
        &self,
        family: &str,
        style: Option<&str>,
        weight: Option<u16>,
    ) -> Result<Response, String> {
        let family_for_native = family.to_string();
        let style_for_native = style.map(str::to_string);
        let native = tokio::task::spawn_blocking(move || {
            read_native(&family_for_native, style_for_native.as_deref(), weight)
        })
        .await
        .map_err(|error| error.to_string());

        match native {
            Ok(Ok(data)) => Ok(Response::new(data)),
            Ok(Err(native_error)) => match self.read_fontdb(family, style, weight).await {
                Ok(data) => Ok(Response::new(data)),
                Err(fontdb_error) => Err(format!(
                    "font-kit failed: {native_error}; fontdb failed: {fontdb_error}"
                )),
            },
            Err(join_error) => Err(join_error),
        }
    }

    async fn lookup_fontdb(
        &self,
        family: &str,
        style: Option<&str>,
        weight: Option<u16>,
    ) -> Result<SystemFontFace, String> {
        let database = self.database().await?;
        let id = resolve_id(&database, family, style, weight)?;
        let face = database
            .face(id)
            .ok_or_else(|| format!("font face disappeared: {family}"))?;
        Ok(SystemFontFace {
            family: face
                .families
                .first()
                .map(|(name, _)| name.clone())
                .unwrap_or_else(|| family.to_string()),
            post_script_name: face.post_script_name.clone(),
            weight: face.weight.0,
            style: style_name(face.style),
            monospaced: face.monospaced,
            face_index: face.index,
        })
    }

    async fn read_fontdb(
        &self,
        family: &str,
        style: Option<&str>,
        weight: Option<u16>,
    ) -> Result<Vec<u8>, String> {
        let database = self.database().await?;
        let id = resolve_id(&database, family, style, weight)?;
        database
            .with_face_data(id, |data, _face_index| data.to_vec())
            .ok_or_else(|| format!("failed to read font data: {family}"))
    }
}

fn load_database() -> Arc<Database> {
    let mut database = Database::new();
    database.load_system_fonts();
    Arc::new(database)
}

fn lookup_native(
    family: &str,
    style: Option<&str>,
    weight: Option<u16>,
) -> Result<SystemFontFace, String> {
    let handle = select_native_handle(family, style, weight)?;
    let font = handle.load().map_err(|error| error.to_string())?;
    let properties = font.properties();
    let face_index = handle_index(&handle);
    Ok(SystemFontFace {
        family: font.family_name(),
        post_script_name: font.postscript_name().unwrap_or_default(),
        weight: properties.weight.0.round() as u16,
        style: kit_style_name(properties.style),
        monospaced: font.is_monospace(),
        face_index,
    })
}

fn read_native(family: &str, style: Option<&str>, weight: Option<u16>) -> Result<Vec<u8>, String> {
    let handle = select_native_handle(family, style, weight)?;
    match handle {
        Handle::Path { path, .. } => std::fs::read(path).map_err(|error| error.to_string()),
        Handle::Memory { bytes, .. } => Ok(bytes.as_ref().clone()),
    }
}

fn select_native_handle(
    family: &str,
    style: Option<&str>,
    weight: Option<u16>,
) -> Result<Handle, String> {
    let source = SystemSource::new();
    let properties = Properties {
        style: kit_style(style),
        weight: FontKitWeight(weight.unwrap_or(400) as f32),
        ..Properties::new()
    };
    source
        .select_best_match(&[FamilyName::Title(family.to_string())], &properties)
        .map_err(|error| error.to_string())
}

fn handle_index(handle: &Handle) -> u32 {
    match handle {
        Handle::Path { font_index, .. } | Handle::Memory { font_index, .. } => *font_index,
    }
}

fn resolve_id(
    database: &Database,
    family: &str,
    style: Option<&str>,
    weight: Option<u16>,
) -> Result<fontdb::ID, String> {
    let families = [Family::Name(family)];
    let query = Query {
        families: &families,
        weight: Weight(weight.unwrap_or(Weight::NORMAL.0)),
        stretch: Stretch::Normal,
        style: parse_style(style),
    };

    database
        .query(&query)
        .or_else(|| {
            database
                .faces()
                .find(|face| face.families.iter().any(|(name, _)| name == family))
                .map(|face| face.id)
        })
        .ok_or_else(|| format!("font family not found: {family}"))
}

fn parse_style(style: Option<&str>) -> Style {
    match style.map(str::to_lowercase).as_deref() {
        Some("italic") => Style::Italic,
        Some("oblique") => Style::Oblique,
        _ => Style::Normal,
    }
}

fn kit_style(style: Option<&str>) -> FontKitStyle {
    match style.map(str::to_lowercase).as_deref() {
        Some("italic") => FontKitStyle::Italic,
        Some("oblique") => FontKitStyle::Oblique,
        _ => FontKitStyle::Normal,
    }
}

fn style_name(style: Style) -> String {
    match style {
        Style::Normal => "normal",
        Style::Italic => "italic",
        Style::Oblique => "oblique",
    }
    .to_string()
}

fn kit_style_name(style: FontKitStyle) -> String {
    match style {
        FontKitStyle::Normal => "normal",
        FontKitStyle::Italic => "italic",
        FontKitStyle::Oblique => "oblique",
    }
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loads_system_fonts_and_reads_face_data() {
        let database = load_database();
        assert!(!database.is_empty(), "no system fonts were loaded");

        let face = database
            .faces()
            .find(|face| face.monospaced)
            .or_else(|| database.faces().next())
            .expect("expected at least one font face");

        let data_len = database
            .with_face_data(face.id, |data, _| data.len())
            .expect("failed to read font data");
        assert!(data_len > 0, "font data should not be empty");
    }

    #[cfg(windows)]
    #[test]
    fn resolves_cascadia_code_on_windows() {
        let database = load_database();
        let families = [Family::Name("Cascadia Code")];
        let id = database
            .query(&Query {
                families: &families,
                weight: Weight::NORMAL,
                stretch: Stretch::Normal,
                style: Style::Normal,
            })
            .expect("Cascadia Code should be installed on the test machine");
        let face = database.face(id).expect("face should exist");
        assert_eq!(
            face.families.first().map(|(name, _)| name.as_str()),
            Some("Cascadia Code")
        );
    }

    #[cfg(windows)]
    #[test]
    fn font_kit_resolves_and_reads_cascadia_code() {
        let face = lookup_native("Cascadia Code", None, None)
            .expect("font-kit should resolve Cascadia Code");
        assert_eq!(face.family, "Cascadia Code");
        assert!(face.face_index < 16);
        assert!(face.monospaced);

        let data = read_native("Cascadia Code", None, None)
            .expect("font-kit should read Cascadia Code data");
        assert!(data.len() > 10_000);
    }
}
