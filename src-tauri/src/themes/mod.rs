//! Custom theme folder scanning.
//!
//! Users drop files into `<config>/themes` to gain themes without touching
//! the app bundle:
//!
//! - NexTerm theme JSON (`name` + `variant`, optional `extends`/`colors`/
//!   `terminal` sections — see the `theme.schema.json` written next to them),
//! - Windows Terminal color scheme JSON (detected by content, converted),
//! - iTerm2 `.itermcolors` palettes (XML plist, converted).
//!
//! `themes_list` parses everything into the shape the frontend theme
//! registry consumes; unparsable files are reported as errors instead of
//! breaking the scan. A file watcher re-emits `themes-changed` so dropped-in
//! and edited files show up without a restart.

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

/// Event emitted whenever the themes folder changes on disk.
pub const THEMES_CHANGED_EVENT: &str = "themes-changed";

/// The JSON Schema file written into the themes folder so editors can
/// autocomplete/validate NexTerm theme files via `$schema`.
const SCHEMA_FILE: &str = "theme.schema.json";
const SCHEMA_JSON: &str = include_str!("schema.json");

/// Sentinel id for the "follow the UI theme" terminal color scheme; a custom
/// theme must not shadow it.
const TERMINAL_SCHEME_SENTINEL: &str = "theme";

const PALETTE_LEN: usize = 16;

/// (id, variant) of the built-in themes: the only builtin metadata the
/// backend needs (to validate `extends` and keep custom ids from shadowing
/// built-ins).
const BUILTIN_THEMES: &[(&str, &str)] = &[
    ("day", "light"),
    ("dim", "dark"),
    ("aqua-light", "light"),
    ("aqua-dark", "dark"),
    ("holo-light", "light"),
    ("holo-dark", "dark"),
    ("slate-light", "light"),
    ("slate-dark", "dark"),
    ("graphite-light", "light"),
    ("graphite-dark", "dark"),
    ("tgreen-light", "light"),
    ("tgreen-dark", "dark"),
    ("sandstone-light", "light"),
    ("sandstone-dark", "dark"),
];

/// Structural overrides accepted in a theme file's `structure` section. These
/// map onto the structure tokens the modern built-in families use (radii,
/// elevation, tab geometry, chrome), so an external theme can restyle the same
/// things a built-in family can. Integer values are pixels/tenths of a second;
/// `panelWeight`, `letterSpacing` float is em.
const STRUCTURE_PX_KEYS: &[&str] = &[
    "radius",
    "radiusSm",
    "radiusMd",
    "radiusLg",
    "menuRadius",
    "menuPadding",
    "buttonRadius",
    "tabHeight",
    "tabIndicator",
    "rowSelectedAccentBar",
];

const STRUCTURE_FLOAT_KEYS: &[&str] = &["panelWeight", "letterSpacing"];

/// Semantic color keys accepted in a theme file's `colors` section. The
/// frontend maps them onto the CSS custom properties from tokens.css
/// (hex values are converted to the HSL triplets the tokens use).
const COLOR_KEYS: &[&str] = &[
    "background",
    "backgroundAlt",
    "surface",
    "surfaceElevated",
    "surfaceHeader",
    "surfaceHover",
    "surfaceActive",
    "border",
    "borderMuted",
    "borderStrong",
    "foreground",
    "muted",
    "mutedForeground",
    "accent",
    "accentStrong",
    "accentSoft",
    "accentForeground",
    "link",
    "linkHover",
    "success",
    "warning",
    "error",
    "focusRing",
    "tableHeader",
    "rowHover",
    "rowSelected",
    "headerForeground",
    "headerMuted",
    "terminalBackground",
    "terminalForeground",
    "terminalCursor",
    "terminalSelection",
];

const WT_PALETTE_KEYS: &[&str] = &[
    "black",
    "red",
    "green",
    "yellow",
    "blue",
    "magenta",
    "cyan",
    "white",
    "brightBlack",
    "brightRed",
    "brightGreen",
    "brightYellow",
    "brightBlue",
    "brightMagenta",
    "brightCyan",
    "brightWhite",
];

const ITERM_PALETTE_KEYS: &[&str] = &[
    "Ansi 0 Color",
    "Ansi 1 Color",
    "Ansi 2 Color",
    "Ansi 3 Color",
    "Ansi 4 Color",
    "Ansi 5 Color",
    "Ansi 6 Color",
    "Ansi 7 Color",
    "Ansi 8 Color",
    "Ansi 9 Color",
    "Ansi 10 Color",
    "Ansi 11 Color",
    "Ansi 12 Color",
    "Ansi 13 Color",
    "Ansi 14 Color",
    "Ansi 15 Color",
];

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomTerminalColors {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub background: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub foreground: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selection_background: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub palette: Option<Vec<String>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomTheme {
    pub id: String,
    pub name: String,
    pub variant: String,
    pub description: String,
    pub extends: String,
    pub source: &'static str,
    pub colors: BTreeMap<String, String>,
    pub terminal: Option<CustomTerminalColors>,
    /// Validated `structure` overrides, already flattened to CSS values
    /// (`{"radiusSm": "4px"}`); empty when the file has none.
    pub structure: BTreeMap<String, String>,
}

#[derive(Debug, Serialize)]
pub struct ThemeScanError {
    pub file: String,
    pub message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemesScan {
    pub themes: Vec<CustomTheme>,
    pub errors: Vec<ThemeScanError>,
    pub dir: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ThemeFile {
    name: String,
    variant: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    extends: Option<String>,
    #[serde(default)]
    colors: BTreeMap<String, String>,
    #[serde(default)]
    terminal: Option<ThemeTerminalSection>,
    #[serde(default)]
    structure: BTreeMap<String, serde_json::Value>,
    #[serde(rename = "$schema", default)]
    #[allow(dead_code)]
    schema_ref: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ThemeTerminalSection {
    #[serde(default)]
    background: Option<String>,
    #[serde(default)]
    foreground: Option<String>,
    #[serde(default)]
    cursor: Option<String>,
    #[serde(rename = "selectionBackground", default)]
    selection_background: Option<String>,
    #[serde(default)]
    palette: Option<Vec<String>>,
}

pub struct ThemeManager {
    dir: Option<PathBuf>,
}

impl ThemeManager {
    pub fn new(dir: Option<PathBuf>) -> Self {
        Self { dir }
    }

    pub fn dir(&self) -> Option<&Path> {
        self.dir.as_deref()
    }

    /// Watch the themes folder and emit `themes-changed` (trailing-debounced)
    /// whenever its contents change. Best-effort: failures are logged and the
    /// frontend still refreshes on demand.
    pub fn spawn_watcher(&self, app: AppHandle) {
        let Some(dir) = self.dir.clone() else {
            return;
        };
        if std::thread::Builder::new()
            .name("themes-watcher".into())
            .spawn(move || watch_dir(app, dir))
            .is_err()
        {
            eprintln!("[themes] failed to spawn watcher thread");
        }
    }
}

fn watch_dir(app: AppHandle, dir: PathBuf) {
    use std::sync::mpsc;

    use notify::Watcher;

    let (tx, rx) = mpsc::channel::<()>();
    let mut watcher =
        match notify::recommended_watcher(move |result: Result<notify::Event, notify::Error>| {
            if result.is_ok() {
                let _ = tx.send(());
            }
        }) {
            Ok(watcher) => watcher,
            Err(error) => {
                eprintln!("[themes] file watcher unavailable: {error}");
                return;
            }
        };
    if let Err(error) = watcher.watch(&dir, notify::RecursiveMode::NonRecursive) {
        eprintln!("[themes] failed to watch {}: {error}", dir.display());
        return;
    }
    // Trailing debounce: swallow the burst, wait out a quiet window, re-check
    // for fresh events, then emit — editors often write a file several times.
    loop {
        if rx.recv().is_err() {
            break;
        }
        while rx.try_recv().is_ok() {}
        std::thread::sleep(Duration::from_millis(300));
        while rx.try_recv().is_ok() {}
        let _ = app.emit(THEMES_CHANGED_EVENT, ());
    }
}

/// Write the JSON Schema into the themes folder once so users get editor
/// autocompletion by referencing it from their theme files.
pub fn ensure_schema_file(dir: &Path) {
    let path = dir.join(SCHEMA_FILE);
    if !path.exists() && std::fs::write(&path, SCHEMA_JSON).is_err() {
        eprintln!("[themes] failed to write {}", path.display());
    }
}

fn builtin_variant(id: &str) -> Option<&'static str> {
    BUILTIN_THEMES
        .iter()
        .find(|(builtin, _)| *builtin == id)
        .map(|(_, variant)| *variant)
}

fn is_builtin_theme(id: &str) -> bool {
    BUILTIN_THEMES.iter().any(|(builtin, _)| *builtin == id)
}

fn default_extends(variant: &str) -> &'static str {
    // Mirrors DEFAULT_LIGHT_THEME / DEFAULT_DARK_THEME on the frontend: a theme
    // file that leaves out `extends` lands on the modern baseline.
    if variant == "light" {
        "slate-light"
    } else {
        "slate-dark"
    }
}

/// Derive the theme id from the file stem: lowercase ASCII alphanumerics
/// only, everything else collapses to a single dash.
fn sanitize_theme_id(raw: &str) -> String {
    let mut out = String::new();
    for ch in raw.trim().chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
        } else if matches!(ch, '-' | '_' | ' ' | '.') {
            out.push('-');
        }
    }
    let mut collapsed = String::new();
    for ch in out.chars() {
        if ch == '-' && (collapsed.is_empty() || collapsed.ends_with('-')) {
            continue;
        }
        collapsed.push(ch);
    }
    while collapsed.ends_with('-') {
        collapsed.pop();
    }
    collapsed
}

/// Accept `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa` (the `#` is optional).
fn normalize_hex(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    let body = trimmed.strip_prefix('#').unwrap_or(trimmed);
    if ![3usize, 4, 6, 8].contains(&body.len()) || !body.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(format!(
            "'{value}' is not a hex color (expected #rgb, #rgba, #rrggbb or #rrggbbaa)"
        ));
    }
    Ok(format!("#{body}"))
}

fn hex_rgb6(value: &str) -> Option<(f64, f64, f64)> {
    let body = value.trim().strip_prefix('#')?;
    let expanded: String = match body.len() {
        3 => body.chars().map(|c| c.to_string().repeat(2)).collect(),
        6 => body.to_string(),
        _ => return None,
    };
    if !expanded.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let byte = |range: std::ops::Range<usize>| -> Option<f64> {
        u8::from_str_radix(&expanded[range], 16).ok().map(f64::from)
    };
    Some((
        byte(0..2)? / 255.0,
        byte(2..4)? / 255.0,
        byte(4..6)? / 255.0,
    ))
}

fn relative_luminance(rgb: (f64, f64, f64)) -> f64 {
    0.2126 * rgb.0 + 0.7152 * rgb.1 + 0.0722 * rgb.2
}

fn rgb_to_hex(rgb: (f64, f64, f64)) -> String {
    let component = |value: f64| format!("{:02x}", (value.clamp(0.0, 1.0) * 255.0).round() as u8);
    format!(
        "#{}{}{}",
        component(rgb.0),
        component(rgb.1),
        component(rgb.2)
    )
}

fn variant_from_background(background: &str) -> &'static str {
    match hex_rgb6(background) {
        Some(rgb) if relative_luminance(rgb) >= 0.5 => "light",
        _ => "dark",
    }
}

fn validate_terminal_colors(
    terminal: Option<ThemeTerminalSection>,
) -> Result<Option<CustomTerminalColors>, String> {
    let Some(section) = terminal else {
        return Ok(None);
    };
    let field = |value: Option<String>, label: &str| -> Result<Option<String>, String> {
        value
            .map(|value| normalize_hex(&value))
            .transpose()
            .map_err(|error| format!("terminal.{label}: {error}"))
    };
    let background = field(section.background, "background")?;
    let foreground = field(section.foreground, "foreground")?;
    let cursor = field(section.cursor, "cursor")?;
    let selection_background = field(section.selection_background, "selectionBackground")?;
    let palette = match section.palette {
        Some(palette) => {
            if palette.len() != PALETTE_LEN {
                return Err(format!(
                    "terminal.palette must contain exactly {PALETTE_LEN} colors, got {}",
                    palette.len()
                ));
            }
            Some(
                palette
                    .iter()
                    .enumerate()
                    .map(|(index, value)| {
                        normalize_hex(value)
                            .map_err(|error| format!("terminal.palette[{index}]: {error}"))
                    })
                    .collect::<Result<Vec<_>, _>>()?,
            )
        }
        None => None,
    };
    Ok(Some(CustomTerminalColors {
        background,
        foreground,
        cursor,
        selection_background,
        palette,
    }))
}

/// A loaded theme file before id assignment and final validation.
struct ThemeParts {
    name: String,
    variant: String,
    description: String,
    extends: Option<String>,
    colors: BTreeMap<String, String>,
    terminal: Option<CustomTerminalColors>,
    /// Flattened CSS values for the `structure` section (already validated).
    structure: BTreeMap<String, String>,
    source: &'static str,
}

fn build_custom_theme(id: String, parts: ThemeParts) -> Result<CustomTheme, String> {
    let ThemeParts {
        name,
        variant,
        description,
        extends,
        colors,
        terminal,
        structure,
        source,
    } = parts;
    if !matches!(variant.as_str(), "light" | "dark") {
        return Err(format!(
            "unknown variant '{variant}' (expected \"light\" or \"dark\")"
        ));
    }
    let name = name.trim();
    if name.is_empty() {
        return Err("theme name must not be empty".to_string());
    }
    let extends = match extends {
        Some(base) => match builtin_variant(&base) {
            Some(base_variant) if base_variant == variant => base,
            Some(base_variant) => {
                return Err(format!(
                    "extends '{base}' is a {base_variant} theme but this theme is {variant}"
                ));
            }
            None => return Err(format!("extends '{base}' is not a built-in theme id")),
        },
        None => default_extends(&variant).to_string(),
    };
    let mut resolved_colors = BTreeMap::new();
    for (key, value) in colors {
        if !COLOR_KEYS.contains(&key.as_str()) {
            return Err(format!("unknown color key '{key}' (see theme.schema.json)"));
        }
        resolved_colors.insert(key, normalize_hex(&value)?);
    }
    Ok(CustomTheme {
        id,
        name: name.to_string(),
        variant,
        description: description.trim().to_string(),
        extends,
        source,
        colors: resolved_colors,
        terminal,
        structure,
    })
}

/// Validate a theme file's optional `structure` section and flatten it to the
/// CSS-value map the frontend writes as inline custom properties. Color-valued
/// keys accept hex; numeric keys are pixel/em numbers and are range-checked.
fn validate_structure(
    structure: Option<BTreeMap<String, serde_json::Value>>,
) -> Result<BTreeMap<String, String>, String> {
    let mut resolved = BTreeMap::new();
    let Some(structure) = structure else {
        return Ok(resolved);
    };
    for (key, value) in structure {
        if STRUCTURE_PX_KEYS.contains(&key.as_str()) {
            let number = value
                .as_f64()
                .ok_or_else(|| format!("structure.{key} must be a number of pixels"))?;
            if !(0.0..=64.0).contains(&number) {
                return Err(format!("structure.{key} must be between 0 and 64"));
            }
            resolved.insert(key, format!("{number}px"));
        } else if STRUCTURE_FLOAT_KEYS.contains(&key.as_str()) {
            let number = value
                .as_f64()
                .ok_or_else(|| format!("structure.{key} must be a number"))?;
            // `letterSpacing` is em and may be negative (tightening); the other
            // float key is a font weight.
            let (min, max) = if key == "letterSpacing" {
                (-0.5, 0.5)
            } else {
                (100.0, 900.0)
            };
            if !(min..=max).contains(&number) {
                return Err(format!("structure.{key} is out of range"));
            }
            let unit = if key == "letterSpacing" { "em" } else { "" };
            resolved.insert(key, format!("{number}{unit}"));
        } else if STRUCTURE_COLOR_KEYS.contains(&key.as_str()) {
            let text = value
                .as_str()
                .ok_or_else(|| format!("structure.{key} must be a hex color"))?;
            resolved.insert(key, normalize_hex(text)?);
        } else {
            return Err(format!(
                "unknown structure key '{key}' (see theme.schema.json)"
            ));
        }
    }
    Ok(resolved)
}

/// Structure keys that take a color instead of a number.
const STRUCTURE_COLOR_KEYS: &[&str] = &[
    "hairlineColor",
    "panelHeaderBg",
    "surfaceBackdrop",
    "rowSelectedBg",
    "groupHeaderBg",
    "menuHoverBg",
    "navHoverBg",
    "tabActiveBg",
    "tabHiddenBg",
];

fn detect_windows_terminal(value: &serde_json::Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    // Our own format is distinguished by the mandatory `variant` field.
    if object.contains_key("variant") {
        return false;
    }
    if !matches!(object.get("background"), Some(serde_json::Value::String(_)))
        || !matches!(object.get("foreground"), Some(serde_json::Value::String(_)))
    {
        return false;
    }
    WT_PALETTE_KEYS
        .iter()
        .any(|key| matches!(object.get(*key), Some(serde_json::Value::String(_))))
}

fn convert_windows_terminal(
    value: &serde_json::Value,
    fallback_name: &str,
) -> Result<(String, String, CustomTerminalColors), String> {
    let object = value
        .as_object()
        .expect("detect_windows_terminal checked the object shape");
    let string_field = |key: &str| -> Result<String, String> {
        match object.get(key) {
            Some(serde_json::Value::String(value)) => Ok(value.clone()),
            _ => Err(format!("missing or non-string field '{key}'")),
        }
    };
    let optional_string = |key: &str| -> Option<String> {
        object
            .get(key)
            .and_then(serde_json::Value::as_str)
            .map(str::to_string)
    };
    let background = string_field("background")?;
    let foreground = string_field("foreground")?;
    let palette = WT_PALETTE_KEYS
        .iter()
        .map(|key| {
            string_field(key)
                .and_then(|value| normalize_hex(&value))
                .map_err(|error| format!("{key}: {error}"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let cursor = optional_string("cursorColor");
    let selection = optional_string("selectionBackground");
    let name = optional_string("name").unwrap_or_else(|| fallback_name.to_string());
    Ok((
        name,
        variant_from_background(&background).to_string(),
        CustomTerminalColors {
            background: Some(normalize_hex(&background)?),
            foreground: Some(normalize_hex(&foreground)?),
            cursor: cursor.map(|value| normalize_hex(&value)).transpose()?,
            selection_background: selection.map(|value| normalize_hex(&value)).transpose()?,
            palette: Some(palette),
        },
    ))
}

/// Extract the earliest plist scalar value (`<real>`/`<integer>`/`<string>`)
/// from `rest`, returning its numeric parse (if any) and the remaining text.
fn plist_scalar(rest: &str) -> Option<(Option<f64>, &str)> {
    let mut best: Option<(&str, usize, usize)> = None; // (close tag, start, end)
    for (tag, close) in [
        ("<real>", "</real>"),
        ("<integer>", "</integer>"),
        ("<string>", "</string>"),
    ] {
        if let Some(start) = rest.find(tag) {
            let after_tag = start + tag.len();
            if let Some(end) = rest[after_tag..].find(close) {
                let value_end = after_tag + end;
                if best.is_none_or(|(_, existing_start, _)| start < existing_start) {
                    best = Some((close, after_tag, value_end));
                }
            }
        }
    }
    let (close, start, end) = best?;
    let after_close = end + close.len();
    let text = rest[start..end].trim();
    let parsed = text.parse::<f64>().ok();
    Some((parsed, &rest[after_close..]))
}

fn parse_component_dict(body: &str) -> Option<(f64, f64, f64)> {
    let mut red = None;
    let mut green = None;
    let mut blue = None;
    let mut rest = body;
    while let Some(start) = rest.find("<key>") {
        let after_key = &rest[start + "<key>".len()..];
        let Some(end) = after_key.find("</key>") else {
            break;
        };
        let key = after_key[..end].trim();
        let (value, remainder) = plist_scalar(&after_key[end + "</key>".len()..])?;
        match key {
            "Red Component" => red = value,
            "Green Component" => green = value,
            "Blue Component" => blue = value,
            _ => {}
        }
        rest = remainder;
    }
    Some((red?, green?, blue?))
}

/// Parse an iTerm2 `.itermcolors` XML plist into `color name -> rgb` floats.
fn parse_itermcolors(content: &str) -> Result<BTreeMap<String, (f64, f64, f64)>, String> {
    let mut colors = BTreeMap::new();
    let mut rest = content;
    while let Some(start) = rest.find("<key>") {
        let after_key = &rest[start + "<key>".len()..];
        let Some(end) = after_key.find("</key>") else {
            return Err("malformed plist: unterminated <key>".to_string());
        };
        let key = after_key[..end].trim().to_string();
        let after = &after_key[end + "</key>".len()..];
        let dict_start = after.find("<dict>");
        let next_key = after.find("<key>");
        match dict_start {
            Some(dict_start) if next_key.is_none_or(|next| next > dict_start) => {
                let body = &after[dict_start + "<dict>".len()..];
                let Some(dict_end) = body.find("</dict>") else {
                    return Err(format!("malformed plist: unterminated <dict> for '{key}'"));
                };
                if let Some(rgb) = parse_component_dict(&body[..dict_end]) {
                    colors.insert(key, rgb);
                }
                rest = &body[dict_end + "</dict>".len()..];
            }
            // Scalar value (or nothing) — move past this key only.
            _ => {
                rest = after;
            }
        }
    }
    Ok(colors)
}

fn convert_iterm_colors(
    colors: &BTreeMap<String, (f64, f64, f64)>,
    fallback_name: &str,
) -> Result<(String, String, CustomTerminalColors), String> {
    let required = |key: &str| -> Result<(f64, f64, f64), String> {
        colors
            .get(key)
            .copied()
            .ok_or_else(|| format!("missing color entry '{key}'"))
    };
    let background = required("Background Color")?;
    let foreground = required("Foreground Color")?;
    let palette = ITERM_PALETTE_KEYS
        .iter()
        .map(|key| required(key).map(rgb_to_hex))
        .collect::<Result<Vec<_>, _>>()?;
    let cursor = colors.get("Cursor Color").copied().unwrap_or(foreground);
    let selection = colors.get("Selection Color").copied().unwrap_or(foreground);
    Ok((
        fallback_name.to_string(),
        variant_from_background(&rgb_to_hex(background)).to_string(),
        CustomTerminalColors {
            background: Some(rgb_to_hex(background)),
            foreground: Some(rgb_to_hex(foreground)),
            cursor: Some(rgb_to_hex(cursor)),
            selection_background: Some(rgb_to_hex(selection)),
            palette: Some(palette),
        },
    ))
}

fn load_theme_file(path: &Path, seen: &mut HashSet<String>) -> Result<CustomTheme, String> {
    let stem = path
        .file_stem()
        .map(|stem| stem.to_string_lossy().to_string())
        .unwrap_or_default();
    let extension = path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    let content =
        std::fs::read_to_string(path).map_err(|error| format!("failed to read: {error}"))?;

    let parts = if extension == "itermcolors" {
        let colors = parse_itermcolors(&content)
            .map_err(|error| format!("invalid iTerm2 color file: {error}"))?;
        let (name, variant, terminal) = convert_iterm_colors(&colors, &stem)?;
        ThemeParts {
            name,
            variant,
            description: String::new(),
            extends: None,
            colors: BTreeMap::new(),
            terminal: Some(terminal),
            structure: BTreeMap::new(),
            source: "iterm2",
        }
    } else {
        let value: serde_json::Value =
            serde_json::from_str(&content).map_err(|error| format!("invalid JSON: {error}"))?;
        if value.get("variant").is_some() {
            let file: ThemeFile = serde_json::from_value(value)
                .map_err(|error| format!("invalid theme file: {error}"))?;
            let terminal = validate_terminal_colors(file.terminal)?;
            let structure = validate_structure(Some(file.structure))?;
            ThemeParts {
                name: file.name,
                variant: file.variant,
                description: file.description,
                extends: file.extends,
                colors: file.colors,
                terminal,
                structure,
                source: "json",
            }
        } else if detect_windows_terminal(&value) {
            let (name, variant, terminal) = convert_windows_terminal(&value, &stem)?;
            ThemeParts {
                name,
                variant,
                description: String::new(),
                extends: None,
                colors: BTreeMap::new(),
                terminal: Some(terminal),
                structure: BTreeMap::new(),
                source: "windows-terminal",
            }
        } else {
            return Err(
                "neither a NexTerm theme (needs name + variant), a Windows Terminal scheme, nor an iTerm2 .itermcolors palette"
                    .to_string(),
            );
        }
    };

    let id = sanitize_theme_id(&stem);
    if id.is_empty() {
        return Err("file name does not contain a usable theme id".to_string());
    }
    if is_builtin_theme(&id) || id == TERMINAL_SCHEME_SENTINEL {
        return Err(format!(
            "theme id '{id}' conflicts with a built-in theme id"
        ));
    }
    if !seen.insert(id.clone()) {
        return Err(format!(
            "duplicate theme id '{id}' — another file already uses it"
        ));
    }
    build_custom_theme(id, parts)
}

fn scan_dir(dir: &Path) -> ThemesScan {
    ensure_schema_file(dir);
    let mut themes = Vec::new();
    let mut errors = Vec::new();
    let mut seen = HashSet::new();

    let mut entries: Vec<PathBuf> = match std::fs::read_dir(dir) {
        Ok(rows) => rows
            .filter_map(|row| row.ok().map(|entry| entry.path()))
            .filter(|path| {
                path.is_file()
                    && path
                        .extension()
                        .and_then(|ext| ext.to_str())
                        .map(|ext| {
                            ext.eq_ignore_ascii_case("json")
                                || ext.eq_ignore_ascii_case("itermcolors")
                        })
                        .unwrap_or(false)
            })
            .collect(),
        Err(error) => {
            errors.push(ThemeScanError {
                file: dir.display().to_string(),
                message: format!("failed to read themes directory: {error}"),
            });
            return ThemesScan {
                themes,
                errors,
                dir: Some(dir.display().to_string()),
            };
        }
    };
    entries.sort();
    for path in entries {
        let file_name = path
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_default();
        if file_name.eq_ignore_ascii_case(SCHEMA_FILE) || file_name.starts_with('.') {
            continue;
        }
        match load_theme_file(&path, &mut seen) {
            Ok(theme) => themes.push(theme),
            Err(message) => errors.push(ThemeScanError {
                file: file_name,
                message,
            }),
        }
    }
    themes.sort_by_key(|theme| theme.name.to_lowercase());
    ThemesScan {
        themes,
        errors,
        dir: Some(dir.display().to_string()),
    }
}

#[tauri::command]
pub async fn themes_list(state: State<'_, ThemeManager>) -> Result<ThemesScan, String> {
    let dir = state.dir().map(Path::to_path_buf);
    tokio::task::spawn_blocking(move || match dir {
        Some(dir) => scan_dir(&dir),
        None => ThemesScan {
            themes: Vec::new(),
            errors: Vec::new(),
            dir: None,
        },
    })
    .await
    .map_err(|error| format!("themes scan failed: {error}"))
}

#[tauri::command]
pub fn themes_open_folder(app: AppHandle, state: State<'_, ThemeManager>) -> Result<(), String> {
    let Some(dir) = state.dir() else {
        return Err("config directory is unavailable".to_string());
    };
    std::fs::create_dir_all(dir)
        .map_err(|error| format!("failed to create themes folder: {error}"))?;
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_path(dir.to_string_lossy().to_string(), None::<&str>)
        .map_err(|error| format!("failed to open themes folder: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn sanitize_theme_id_normalizes_file_stems() {
        assert_eq!(sanitize_theme_id("Campbell"), "campbell");
        assert_eq!(sanitize_theme_id("One Half Dark"), "one-half-dark");
        assert_eq!(sanitize_theme_id("aqua__light!"), "aqua-light");
        assert_eq!(sanitize_theme_id("--Weird--Name--"), "weird-name");
        assert_eq!(sanitize_theme_id("!!!"), "");
    }

    #[test]
    fn normalize_hex_accepts_shorthands_and_bare_values() {
        assert_eq!(normalize_hex("#fff").unwrap(), "#fff");
        assert_eq!(normalize_hex("11223344").unwrap(), "#11223344");
        assert_eq!(normalize_hex("#ABC").unwrap(), "#ABC");
        assert!(normalize_hex("#12").is_err());
        assert!(normalize_hex("#zzzzzz").is_err());
        assert!(normalize_hex("").is_err());
    }

    #[test]
    fn theme_file_parses_with_schema_ref_and_extends() {
        let file: ThemeFile = serde_json::from_str(
            r##"{
                "$schema": "./theme.schema.json",
                "name": "Nightfall",
                "variant": "dark",
                "description": " deep blue ",
                "extends": "dim",
                "colors": { "background": "#12181f", "accent": "#4c8dd8" }
            }"##,
        )
        .expect("parse theme file");
        assert_eq!(file.name, "Nightfall");
        assert_eq!(file.extends.as_deref(), Some("dim"));
        let theme = build_custom_theme(
            "nightfall".to_string(),
            ThemeParts {
                name: file.name,
                variant: file.variant,
                description: file.description,
                extends: file.extends,
                colors: file.colors,
                terminal: validate_terminal_colors(file.terminal).expect("terminal section"),
                structure: BTreeMap::new(),
                source: "json",
            },
        )
        .expect("build theme");
        assert_eq!(theme.extends, "dim");
        assert_eq!(theme.description, "deep blue");
        assert_eq!(theme.colors.get("background").unwrap(), "#12181f");
    }

    #[test]
    fn theme_file_rejects_unknown_fields_and_bad_values() {
        let error = serde_json::from_str::<ThemeFile>(
            r##"{ "name": "X", "variant": "dark", "colour": "#fff" }"##,
        )
        .expect_err("unknown field must fail");
        assert!(error.to_string().contains("unknown field"));

        assert!(build_custom_theme(
            "x".to_string(),
            ThemeParts {
                name: "X".to_string(),
                variant: "blue".to_string(),
                description: String::new(),
                extends: None,
                colors: BTreeMap::new(),
                terminal: None,
                structure: BTreeMap::new(),
                source: "json",
            },
        )
        .is_err());

        let mut colors = BTreeMap::new();
        colors.insert("notAColor".to_string(), "#ffffff".to_string());
        assert!(build_custom_theme(
            "x".to_string(),
            ThemeParts {
                name: "X".to_string(),
                variant: "dark".to_string(),
                description: String::new(),
                extends: None,
                colors,
                terminal: None,
                structure: BTreeMap::new(),
                source: "json",
            },
        )
        .is_err());
    }

    #[test]
    fn extends_must_match_variant() {
        let error = build_custom_theme(
            "x".to_string(),
            ThemeParts {
                name: "X".to_string(),
                variant: "dark".to_string(),
                description: String::new(),
                extends: Some("day".to_string()),
                colors: BTreeMap::new(),
                terminal: None,
                structure: BTreeMap::new(),
                source: "json",
            },
        )
        .expect_err("light base for a dark theme must fail");
        assert!(error.contains("extends 'day'"));
    }

    #[test]
    fn terminal_section_validates_palette_length() {
        let short: ThemeTerminalSection = serde_json::from_str(
            r##"{ "background": "#000000", "palette": ["#000000", "#ffffff"] }"##,
        )
        .expect("parse terminal section");
        let error = validate_terminal_colors(Some(short)).expect_err("palette length must fail");
        assert!(error.contains("exactly 16"));

        let full: ThemeTerminalSection = serde_json::from_str(
            r##"{
                "background": "#000000",
                "foreground": "#ffffff",
                "cursor": "#00ff00",
                "selectionBackground": "#ffffff80",
                "palette": ["#000000","#111111","#222222","#333333","#444444","#555555","#666666","#777777","#888888","#999999","#aaaaaa","#bbbbbb","#cccccc","#dddddd","#eeeeee","#ffffff"]
            }"##,
        )
        .expect("parse terminal section");
        let resolved = validate_terminal_colors(Some(full)).expect("valid terminal section");
        assert_eq!(
            resolved.unwrap().selection_background.as_deref(),
            Some("#ffffff80")
        );
    }

    #[test]
    fn converts_windows_terminal_scheme() {
        let value: serde_json::Value = serde_json::from_str(CAMPBELL).expect("parse WT scheme");
        assert!(detect_windows_terminal(&value));
        let (name, variant, terminal) =
            convert_windows_terminal(&value, "campbell").expect("convert WT scheme");
        assert_eq!(name, "Campbell");
        assert_eq!(variant, "dark");
        assert_eq!(terminal.background.as_deref(), Some("#0C0C0C"));
        assert_eq!(terminal.cursor.as_deref(), Some("#FFFFFF"));
        assert_eq!(terminal.selection_background.as_deref(), Some("#FFFFFF"));
        assert_eq!(terminal.palette.as_ref().unwrap().len(), 16);
        assert_eq!(terminal.palette.as_ref().unwrap()[1], "#C50F1F");

        let nex_term: serde_json::Value = serde_json::from_str(
            r##"{ "name": "N", "variant": "dark", "background": "#000", "foreground": "#fff" }"##,
        )
        .expect("parse NexTerm theme");
        assert!(!detect_windows_terminal(&nex_term));
    }

    #[test]
    fn parses_iterm2_palette() {
        let mut xml = String::from(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<plist version=\"1.0\">\n<dict>\n",
        );
        xml.push_str(&iterm_entry("Background Color", 0.05, 0.06, 0.08));
        xml.push_str(&iterm_entry("Foreground Color", 0.8, 0.85, 0.9));
        xml.push_str(&iterm_entry("Cursor Color", 1.0, 1.0, 1.0));
        xml.push_str(&iterm_entry("Selection Color", 0.2, 0.3, 0.4));
        for index in 0..16 {
            let value = f64::from(index) / 15.0;
            xml.push_str(&iterm_entry(
                &format!("Ansi {index} Color"),
                value,
                value,
                value,
            ));
        }
        xml.push_str("</dict>\n</plist>\n");

        let colors = parse_itermcolors(&xml).expect("parse itermcolors");
        assert_eq!(colors.len(), 20);
        let (name, variant, terminal) =
            convert_iterm_colors(&colors, "my-scheme").expect("convert itermcolors");
        assert_eq!(name, "my-scheme");
        assert_eq!(variant, "dark");
        assert_eq!(terminal.background.as_deref(), Some("#0d0f14"));
        assert_eq!(terminal.palette.as_ref().unwrap().len(), 16);
        assert_eq!(terminal.palette.as_ref().unwrap()[8], "#888888");
        assert_eq!(terminal.cursor.as_deref(), Some("#ffffff"));
        assert_eq!(terminal.selection_background.as_deref(), Some("#334d66"));

        // Missing palette entries must fail loudly.
        let mut partial = colors.clone();
        partial.remove("Ansi 7 Color");
        assert!(convert_iterm_colors(&partial, "x").is_err());
    }

    #[test]
    fn scan_dir_collects_all_supported_formats() {
        let dir = TempDir::new().expect("temp dir");
        let root = dir.path();

        std::fs::write(
            root.join("nightfall.json"),
            r##"{ "name": "Nightfall", "variant": "dark", "extends": "dim", "colors": { "background": "#12181f" } }"##,
        )
        .unwrap();
        std::fs::write(root.join("Campbell.json"), CAMPBELL).unwrap();
        let mut xml = String::from("<plist version=\"1.0\"><dict>\n");
        xml.push_str(&iterm_entry("Background Color", 1.0, 1.0, 1.0));
        xml.push_str(&iterm_entry("Foreground Color", 0.0, 0.0, 0.0));
        for index in 0..16 {
            xml.push_str(&iterm_entry(&format!("Ansi {index} Color"), 0.5, 0.5, 0.5));
        }
        xml.push_str("</dict></plist>");
        std::fs::write(root.join("LightScheme.itermcolors"), xml).unwrap();

        std::fs::write(root.join("broken.json"), "{ not json").unwrap();
        std::fs::write(
            root.join("dim.json"),
            r##"{ "name": "Shadow Dim", "variant": "dark" }"##,
        )
        .unwrap();
        std::fs::write(
            root.join("dupe.json"),
            r##"{ "name": "Dupe", "variant": "dark" }"##,
        )
        .unwrap();
        std::fs::write(
            root.join("DUPE.itermcolors"),
            iterm_full_document("Dupe", 0.0),
        )
        .unwrap();

        let scan = scan_dir(root);
        assert_eq!(
            scan.themes
                .iter()
                .map(|theme| theme.id.as_str())
                .collect::<Vec<_>>(),
            ["campbell", "dupe", "lightscheme", "nightfall"]
        );
        assert_eq!(scan.themes[0].source, "windows-terminal");
        assert_eq!(scan.themes[2].source, "iterm2");
        assert_eq!(scan.themes[2].variant, "light");
        assert_eq!(scan.themes[3].extends, "dim");
        assert_eq!(scan.themes[3].colors.get("background").unwrap(), "#12181f");

        let failed_files = scan
            .errors
            .iter()
            .map(|error| error.file.as_str())
            .collect::<Vec<_>>();
        assert_eq!(failed_files, ["broken.json", "dim.json", "dupe.json"]);
        assert!(scan.errors[0].message.contains("invalid JSON"));
        assert!(scan.errors[1].message.contains("conflicts with a built-in"));
        assert!(scan.errors[2].message.contains("duplicate theme id"));
        assert!(root.join(SCHEMA_FILE).exists());
    }

    fn iterm_entry(key: &str, red: f64, green: f64, blue: f64) -> String {
        format!(
            "\t<key>{key}</key>\n\t<dict>\n\t\t<key>Color Space</key>\n\t\t<string>sRGB</string>\n\t\t<key>Red Component</key>\n\t\t<real>{red}</real>\n\t\t<key>Green Component</key>\n\t\t<real>{green}</real>\n\t\t<key>Blue Component</key>\n\t\t<real>{blue}</real>\n\t</dict>\n"
        )
    }

    fn iterm_full_document(name: &str, gray: f64) -> String {
        let mut xml = format!(
            "<plist version=\"1.0\"><dict>\n\t<key>Name</key>\n\t<string>{name}</string>\n"
        );
        xml.push_str(&iterm_entry("Background Color", 0.0, 0.0, 0.0));
        xml.push_str(&iterm_entry("Foreground Color", 1.0, 1.0, 1.0));
        for index in 0..16 {
            xml.push_str(&iterm_entry(
                &format!("Ansi {index} Color"),
                gray,
                gray,
                gray,
            ));
        }
        xml.push_str("</dict></plist>");
        xml
    }

    const CAMPBELL: &str = r##"{
        "name": "Campbell",
        "background": "#0C0C0C",
        "foreground": "#CCCCCC",
        "cursorColor": "#FFFFFF",
        "selectionBackground": "#FFFFFF",
        "black": "#0C0C0C",
        "red": "#C50F1F",
        "green": "#13A10E",
        "yellow": "#C19C00",
        "blue": "#0037DA",
        "magenta": "#881798",
        "cyan": "#3A96DD",
        "white": "#CCCCCC",
        "brightBlack": "#767676",
        "brightRed": "#E74856",
        "brightGreen": "#16C60C",
        "brightYellow": "#F9F1A5",
        "brightBlue": "#3B78FF",
        "brightMagenta": "#B4009E",
        "brightCyan": "#61D6D6",
        "brightWhite": "#F2F2F2"
    }"##;

    /// Parse one NexTerm theme JSON string in a throwaway folder: the test
    /// counterpart of dropping a file into the themes directory.
    fn load_theme_json(name: &str, json: &str) -> Result<CustomTheme, String> {
        let dir = TempDir::new().expect("temp dir");
        std::fs::write(dir.path().join(format!("{name}.json")), json).expect("write theme");
        let mut seen = HashSet::new();
        load_theme_file(&dir.path().join(format!("{name}.json")), &mut seen)
    }
    #[test]
    fn structure_section_flattens_to_css_values() {
        let theme = load_theme_json(
            "modern",
            r##"{
                "name": "Modern",
                "variant": "dark",
                "extends": "slate-dark",
                "structure": {
                    "radiusSm": 4,
                    "tabHeight": 32,
                    "tabIndicator": 2,
                    "panelWeight": 600,
                    "letterSpacing": -0.01,
                    "hairlineColor": "#2d333b"
                }
            }"##,
        )
        .expect("structure section must parse");
        assert_eq!(theme.extends, "slate-dark");
        assert_eq!(
            theme.structure.get("radiusSm").map(String::as_str),
            Some("4px")
        );
        assert_eq!(
            theme.structure.get("tabHeight").map(String::as_str),
            Some("32px")
        );
        assert_eq!(
            theme.structure.get("panelWeight").map(String::as_str),
            Some("600")
        );
        assert_eq!(
            theme.structure.get("letterSpacing").map(String::as_str),
            Some("-0.01em")
        );
        assert_eq!(
            theme.structure.get("hairlineColor").map(String::as_str),
            Some("#2d333b")
        );
    }

    #[test]
    fn structure_section_rejects_unknown_and_out_of_range_values() {
        let unknown = load_theme_json(
            "bad",
            r##"{ "name": "Bad", "variant": "dark", "structure": { "mystery": 1 } }"##,
        )
        .expect_err("unknown structure key must fail");
        assert!(unknown.contains("unknown structure key"));

        let huge = load_theme_json(
            "huge",
            r##"{ "name": "Huge", "variant": "dark", "structure": { "radiusSm": 999 } }"##,
        )
        .expect_err("out-of-range radius must fail");
        assert!(huge.contains("between 0 and 64"));

        let not_hex = load_theme_json(
            "hex",
            r##"{ "name": "Hex", "variant": "dark", "structure": { "hairlineColor": "red" } }"##,
        )
        .expect_err("non-hex color must fail");
        assert!(not_hex.contains("hex color"));
    }

    #[test]
    fn default_extends_lands_on_the_modern_baseline() {
        let dark = load_theme_json("x", r##"{ "name": "X", "variant": "dark" }"##)
            .expect("theme without extends must parse");
        assert_eq!(dark.extends, "slate-dark");
        let light = load_theme_json("y", r##"{ "name": "Y", "variant": "light" }"##)
            .expect("theme without extends must parse");
        assert_eq!(light.extends, "slate-light");
    }

    #[test]
    fn every_modern_builtin_is_accepted_as_extends() {
        for (id, variant) in BUILTIN_THEMES {
            let json =
                format!(r#"{{ "name": "Base", "variant": "{variant}", "extends": "{id}" }}"#);
            let theme =
                load_theme_json("base", &json).unwrap_or_else(|error| panic!("{id}: {error}"));
            assert_eq!(&theme.extends, id);
        }
    }

    #[test]
    fn schema_extends_enum_matches_the_builtin_table() {
        let schema: serde_json::Value =
            serde_json::from_str(SCHEMA_JSON).expect("schema.json must be valid JSON");
        let ids = schema["properties"]["extends"]["enum"]
            .as_array()
            .expect("extends enum")
            .iter()
            .map(|value| value.as_str().expect("string id").to_string())
            .collect::<Vec<_>>();
        let expected = BUILTIN_THEMES
            .iter()
            .map(|(id, _)| id.to_string())
            .collect::<Vec<_>>();
        assert_eq!(ids, expected);
        // Every structure key the validator knows is documented for editors.
        let documented = schema["properties"]["structure"]["properties"]
            .as_object()
            .expect("structure properties");
        for key in STRUCTURE_PX_KEYS
            .iter()
            .chain(STRUCTURE_FLOAT_KEYS)
            .chain(STRUCTURE_COLOR_KEYS)
        {
            assert!(documented.contains_key(*key), "schema is missing '{key}'");
        }
    }
}
