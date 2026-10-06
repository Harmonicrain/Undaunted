use crate::{Result, platform};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs,
    io::Read,
    path::{Path, PathBuf},
};

pub const EXE: &str = "Dauntless-Win64-Shipping.exe";
pub const EXE_HASH: &str = "ee30d1821b4020ff1bcaa89a63fa6ef3515efb622f2969546b91bf018a379f43";
pub const RUNTIME_FILES: [&str; 2] = ["winmm.dll", "UndauntedInternalServer.dll"];
const SECTION: &str = "[/Script/Archon.ArchonGameUserSettings]";
pub const FRAME_RATES: [u32; 8] = [30, 60, 90, 120, 144, 165, 240, 0];

pub fn languages() -> Value {
    json!({"en":"English", "fr":"Français", "es":"Español", "it":"Italiano",
        "pt-BR":"Português (Brasil)", "de":"Deutsch", "ja":"日本語", "ru":"Русский"})
}
pub fn token(value: &str, prefix: &str, count: usize) -> bool {
    value.strip_prefix(prefix).is_some_and(|v| {
        v.len() == count
            && v.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}
pub fn valid_user(user: &Value) -> bool {
    let id = user["userId"].as_str().unwrap_or_default();
    let name = user["username"].as_str().unwrap_or_default();
    let uuid = id.strip_prefix("UID-").unwrap_or_default();
    uuid.len() == 36
        && uuid.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_digit() || (b'a'..=b'f').contains(&b)
            }
        })
        && (3..=16).contains(&name.len())
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}
pub fn hash_file(file: &Path) -> Result<String> {
    let mut input = fs::File::open(file).map_err(|_| "Could not read the selected file.")?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let size = input
            .read(&mut buffer)
            .map_err(|_| "Could not verify the selected file.")?;
        if size == 0 {
            break;
        }
        hash.update(&buffer[..size]);
    }
    Ok(format!("{:x}", hash.finalize()))
}
pub fn locate_game(folder: &Path) -> Result<PathBuf> {
    for suffix in [
        "",
        "Binaries/Win64",
        "Archon/Binaries/Win64",
        "Dauntless/Archon/Binaries/Win64",
    ] {
        let candidate = folder.join(suffix);
        if candidate.join(EXE).is_file() {
            return candidate
                .canonicalize()
                .map_err(|_| "Could not read the game folder.".into());
        }
    }
    Err(
        "Select the Dauntless 1.12.0 folder containing Archon, or its Binaries\\Win64 folder."
            .into(),
    )
}
pub fn verify_game(folder: &Path) -> Result<()> {
    if hash_file(&folder.join(EXE))? != EXE_HASH {
        return Err("This is a different Dauntless build. Select the supported 1.12.0 installation (CL392819).".into());
    }
    Ok(())
}
pub fn verify_resources(resources: &Path) -> Result<Value> {
    let bad = "The launcher runtime bundle is damaged. Reinstall the launcher.";
    let manifest: Value =
        serde_json::from_slice(&fs::read(resources.join("runtime.json")).map_err(|_| bad)?)
            .map_err(|_| bad)?;
    for name in RUNTIME_FILES {
        let expected = manifest["files"][name].as_str().ok_or(bad)?;
        if !token(expected, "", 64)
            || hash_file(&resources.join(name)).map_err(|_| bad)? != expected
        {
            return Err(bad.into());
        }
    }
    Ok(manifest)
}
pub fn runtime_status(folder: &Path, resources: &Path) -> Result<bool> {
    let manifest = verify_resources(resources)?;
    Ok(RUNTIME_FILES.iter().all(|name| {
        hash_file(&folder.join(name)).ok().as_deref() == manifest["files"][*name].as_str()
    }))
}
pub fn install_runtime(folder: &Path, resources: &Path) -> Result<()> {
    verify_game(folder)?;
    let manifest = verify_resources(resources)?;
    replace_runtime(folder, resources, &manifest)
}
// Separate from executable validation so rollback is exercised with disposable DLLs.
pub fn replace_runtime(folder: &Path, resources: &Path, manifest: &Value) -> Result<()> {
    let tag = platform::unique_tag();
    let mut prepared = Vec::new();
    let mut backups = Vec::new();
    let mut installed = Vec::new();
    let result = (|| -> Result<()> {
        for name in RUNTIME_FILES {
            let temp = folder.join(format!("{name}.{tag}.tmp"));
            prepared.push(temp.clone());
            platform::copy_new(&resources.join(name), &temp)?;
            if hash_file(&temp)? != manifest["files"][name].as_str().unwrap_or_default() {
                return Err("Runtime verification failed.".into());
            }
        }
        for (i, name) in RUNTIME_FILES.iter().enumerate() {
            let dest = folder.join(name);
            let backup = folder.join(format!("{name}.launcher-{tag}.bak"));
            match fs::rename(&dest, &backup) {
                Ok(()) => backups.push((dest.clone(), backup)),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
                Err(_) => return Err("Could not back up runtime.".into()),
            }
            fs::rename(&prepared[i], &dest).map_err(|_| "Could not install runtime.")?;
            installed.push(dest);
        }
        Ok(())
    })();
    if result.is_err() {
        let mut rollback_failed = false;
        for dest in installed.iter().rev() {
            if fs::remove_file(dest).is_err() {
                rollback_failed = true;
            }
        }
        for (dest, backup) in backups.iter().rev() {
            if fs::rename(backup, dest).is_err() {
                rollback_failed = true;
            }
        }
        for temp in prepared {
            let _ = fs::remove_file(temp);
        }
        return Err(if rollback_failed { "Runtime repair failed and rollback was incomplete. Keep the .launcher-*.bak files and contact the server owner." }
            else { "Could not install the runtime. Close Dauntless and check that you can write to the game folder." }.into());
    }
    Ok(())
}
pub fn launch_args(origin: &str, user: &Value, code: &str, language: &str) -> Result<Vec<String>> {
    let url = url::Url::parse(&crate::network::server_origin(origin)?)
        .map_err(|_| "Invalid server address.")?;
    if !valid_user(user) || !token(code, "ULX_", 64) {
        return Err("The server returned invalid launch details.".into());
    }
    let id = user["userId"].as_str().unwrap();
    let name = user["username"].as_str().unwrap();
    let mut args = vec![
        "-EpicPortal".into(),
        "-NoEAC".into(),
        "-AUTH_TYPE=exchangecode".into(),
        format!("-AUTH_LOGIN={id}"),
        format!("-AUTH_PASSWORD={code}"),
        "-epicapp=Archon".into(),
        "-epicenv=Prod".into(),
        format!("-epicusername={name}"),
        format!("-epicuserid={id}"),
        format!("-epicaccountid={id}"),
        "-epicsandboxid=jackal".into(),
        "-epicdeploymentid=53565ba467df4edbb6f5a3d939a8b4f2".into(),
        format!(
            "-UndauntedMetagame={}",
            &url[url::Position::BeforeHost..url::Position::AfterPort]
        ),
    ];
    if languages().get(language).is_some() {
        args.push(format!("-culture={language}"));
    }
    Ok(args)
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Debug)]
pub struct Display {
    pub mode: u32,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub vsync: bool,
}
impl Display {
    pub fn validate(&self) -> Result<()> {
        if self.mode > 2
            || !(640..=7680).contains(&self.width)
            || !(480..=4320).contains(&self.height)
            || !FRAME_RATES.contains(&self.fps)
        {
            return Err("Those display settings are not valid.".into());
        }
        Ok(())
    }
}
fn section(lines: &[&str]) -> Option<(usize, usize)> {
    let start = lines.iter().position(|line| line.trim() == SECTION)?;
    let end = lines
        .iter()
        .enumerate()
        .skip(start + 1)
        .find(|(_, line)| line.trim().starts_with('['))
        .map_or(lines.len(), |(i, _)| i);
    Some((start, end))
}
pub fn read_display(text: &str) -> Option<Display> {
    let lines: Vec<_> = text.split('\n').map(|l| l.trim_end_matches('\r')).collect();
    let (start, end) = section(&lines)?;
    let get = |key: &str| {
        lines[start + 1..end].iter().find_map(|line| {
            line.split_once('=')
                .filter(|(k, _)| k.trim() == key)
                .map(|(_, v)| v.trim())
        })
    };
    let number = |key, fallback| {
        get(key)
            .and_then(|n| n.parse::<f64>().ok())
            .filter(|n| n.is_finite() && *n >= 0.0)
            .map_or(fallback, |n| n.round() as u32)
    };
    Some(Display {
        mode: number("FullscreenMode", 1),
        width: number("ResolutionSizeX", 1920).max(1),
        height: number("ResolutionSizeY", 1080).max(1),
        fps: number("FrameRateLimit", 0),
        vsync: get("bUseVSync").is_some_and(|v| v.eq_ignore_ascii_case("true")),
    })
}
pub fn update_display(text: &str, display: &Display) -> Result<String> {
    display.validate()?;
    let eol = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let lines: Vec<_> = text.split('\n').map(|l| l.trim_end_matches('\r')).collect();
    let (start, end) = section(&lines)
        .ok_or("The game settings file has no Archon section; start Dauntless once first.")?;
    let wanted = vec![
        ("FullscreenMode", display.mode.to_string()),
        ("LastConfirmedFullscreenMode", display.mode.to_string()),
        ("PreferredFullscreenMode", display.mode.to_string()),
        ("ResolutionSizeX", display.width.to_string()),
        ("ResolutionSizeY", display.height.to_string()),
        (
            "LastUserConfirmedResolutionSizeX",
            display.width.to_string(),
        ),
        (
            "LastUserConfirmedResolutionSizeY",
            display.height.to_string(),
        ),
        ("FrameRateLimit", format!("{:.6}", display.fps as f64)),
        (
            "bUseVSync",
            if display.vsync { "True" } else { "False" }.into(),
        ),
    ];
    let mut seen = HashSet::new();
    let mut middle: Vec<String> = lines[start + 1..end]
        .iter()
        .map(|line| {
            let key = line.split_once('=').map_or("", |(k, _)| k.trim());
            if let Some((_, value)) = wanted.iter().find(|(k, _)| *k == key)
                && seen.insert(key.to_string())
            {
                return format!("{key}={value}");
            }
            (*line).into()
        })
        .collect();
    let insert = middle
        .iter()
        .rposition(|l| !l.trim().is_empty())
        .map_or(0, |i| i + 1);
    middle.splice(
        insert..insert,
        wanted
            .iter()
            .filter(|(k, _)| !seen.contains(*k))
            .map(|(k, v)| format!("{k}={v}")),
    );
    Ok(lines[..start + 1]
        .iter()
        .map(|l| l.to_string())
        .chain(middle)
        .chain(lines[end..].iter().map(|l| l.to_string()))
        .collect::<Vec<_>>()
        .join(eol))
}
fn text(value: &Value, limit: usize) -> String {
    value
        .as_str()
        .unwrap_or_default()
        .chars()
        .take(limit)
        .collect()
}
fn list(value: &Value, limit: usize) -> impl Iterator<Item = &Value> {
    value.as_array().into_iter().flatten().take(limit)
}
pub fn patch_notes(payload: &Value) -> Value {
    let categories: Vec<_> = list(&payload["notes"],12).filter_map(|category| {
        let sections: Vec<_> = list(&category["sections"],20).filter_map(|section| {
            let title = text(&section["title"],120); let description = text(&section["description"],1000);
            if title.is_empty() && description.is_empty() { return None; }
            let changes: Vec<_> = list(&section["changes"],10).map(|change| json!({"comment":text(&change["comment"],120),
                "list":list(&change["list"],30).map(|v| text(v,400)).filter(|v| !v.is_empty()).collect::<Vec<_>>() })).collect();
            Some(json!({"title":title,"description":description,"changes":changes}))
        }).collect();
        if sections.is_empty() { None } else { Some(json!({"title":text(&category["title"],80),"sections":sections})) }
    }).collect();
    json!({"date":text(&payload["date"],40),"title":text(&payload["title"],80),"version":text(&payload["release_version"],40),
        "description":text(&payload["description"],300),"categories":categories})
}
