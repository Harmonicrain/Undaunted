use crate::Result;
use std::os::windows::{ffi::OsStrExt, process::CommandExt};
use std::{
    fs,
    io::{Read, Write},
    path::Path,
    process::{Command, Stdio},
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use windows_sys::Win32::{
    Foundation::LocalFree,
    Security::Cryptography::{
        CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData, CryptUnprotectData,
    },
    Storage::FileSystem::{MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW},
    UI::Shell::ShellExecuteW,
};
const CREATE_NO_WINDOW: u32 = 0x08000000;
pub fn launch_installer(installer: &Path, directory: &Path) -> Result<()> {
    // NSIS requires /D last and unquoted, including directories with spaces.
    // raw_arg writes directly to the process command line; no shell is involved.
    Command::new(installer)
        .args(["--updated", "/S", "--force-run"])
        .raw_arg(format!("/D={}", directory.display()))
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|_| "Could not start the verified installer.".into())
}
pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
pub fn unique_tag() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    format!(
        "{}-{}-{}",
        now(),
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    )
}
fn wide(value: &std::ffi::OsStr) -> Vec<u16> {
    value.encode_wide().chain(Some(0)).collect()
}
pub fn copy_new(from: &Path, to: &Path) -> Result<()> {
    let mut input = fs::File::open(from).map_err(|_| "Could not read the source file.")?;
    let mut output = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(to)
        .map_err(|_| "Could not prepare the destination file.")?;
    std::io::copy(&mut input, &mut output).map_err(|_| "Could not copy the file.")?;
    output
        .sync_all()
        .map_err(|_| "Could not save the file.".to_string())
}
pub fn atomic_write(target: &Path, data: &[u8]) -> Result<()> {
    let parent = target.parent().ok_or("Invalid destination.")?;
    fs::create_dir_all(parent).map_err(|_| "Could not create the launcher profile.")?;
    let temp = parent.join(format!(".launcher-{}.tmp", unique_tag()));
    let result = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .map_err(|_| "Could not save launcher settings.")?;
        file.write_all(data)
            .and_then(|_| file.sync_all())
            .map_err(|_| "Could not save launcher settings.")?;
        drop(file);
        let source = wide(temp.as_os_str());
        let dest = wide(target.as_os_str());
        if unsafe {
            MoveFileExW(
                source.as_ptr(),
                dest.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        } == 0
        {
            return Err("Could not replace launcher settings.".into());
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result
}
// New Rust sessions are raw current-user DPAPI blobs, never plaintext.
pub fn protect(data: &[u8]) -> Result<Vec<u8>> {
    crypt(data, true)
}
pub fn unprotect(data: &[u8]) -> Result<Vec<u8>> {
    crypt(data, false)
}
fn crypt(data: &[u8], encrypt: bool) -> Result<Vec<u8>> {
    if data.len() > 64 * 1024 {
        return Err("The saved login is invalid.".into());
    }
    let input = CRYPT_INTEGER_BLOB {
        cbData: data.len() as u32,
        pbData: data.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    let ok = unsafe {
        if encrypt {
            CryptProtectData(
                &input,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        } else {
            CryptUnprotectData(
                &input,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        }
    };
    if ok == 0 {
        return Err(
            "Windows could not protect or restore your login session. Please sign in again.".into(),
        );
    }
    let bytes =
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe {
        LocalFree(output.pbData as _);
    }
    Ok(bytes)
}
pub fn bounded_process(mut command: Command, timeout: Duration, limit: u64) -> Result<Vec<u8>> {
    command
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = command
        .spawn()
        .map_err(|_| "The system check could not start.")?;
    let output = child
        .stdout
        .take()
        .ok_or("The system check could not start.")?;
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        output
            .take(limit + 1)
            .read_to_end(&mut bytes)
            .map(|_| bytes)
    });
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let bytes = reader
                    .join()
                    .map_err(|_| "The system check failed.")?
                    .map_err(|_| "The system check failed.")?;
                if !status.success() || bytes.len() as u64 > limit {
                    return Err("The system check failed.".into());
                }
                return Ok(bytes);
            }
            Ok(None) if start.elapsed() < timeout => std::thread::sleep(Duration::from_millis(30)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = reader.join();
                return Err("The system check timed out.".into());
            }
        }
    }
}
pub fn game_running(folder: Option<&Path>) -> Result<bool> {
    let system_root = std::env::var_os("SystemRoot").ok_or("Could not locate Windows.")?;
    let mut cmd = Command::new(
        Path::new(&system_root).join("System32/WindowsPowerShell/v1.0/powershell.exe"),
    );
    // Only a boolean crosses the boundary; command lines containing credentials never leave PowerShell.
    let script = "$ErrorActionPreference='Stop'; $p=@(Get-CimInstance Win32_Process -Filter \"Name='Dauntless-Win64-Shipping.exe'\" | Where-Object { ((-not $env:UNDAUNTED_CHECK_GAME_PATH) -or (-not $_.ExecutablePath) -or $_.ExecutablePath -eq $env:UNDAUNTED_CHECK_GAME_PATH) -and ((-not $_.CommandLine) -or $_.CommandLine -notmatch '(?i)(?:^|\\s)-server(?:\\s|$)') }); Write-Output ($p.Count -gt 0)";
    cmd.args(["-NoProfile", "-NonInteractive", "-Command", script])
        .env(
            "UNDAUNTED_CHECK_GAME_PATH",
            folder.map(|p| p.join(crate::game::EXE)).unwrap_or_default(),
        );
    match String::from_utf8(bounded_process(cmd, Duration::from_secs(10), 1024)?)
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "true" => Ok(true),
        "false" => Ok(false),
        _ => Err("Could not confirm Dauntless is closed. Close the game and try again.".into()),
    }
}
pub fn launch_game(folder: &Path, args: &[String]) -> Result<std::process::Child> {
    Command::new(folder.join(crate::game::EXE))
        .args(args)
        .current_dir(folder)
        .creation_flags(0x00000008 | 0x00000200)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "Dauntless could not start. Check your installation.".into())
}
pub fn open_discord() -> Result<()> {
    let verb = wide(std::ffi::OsStr::new("open"));
    let url = wide(std::ffi::OsStr::new("https://discord.gg/zxZfbhMEs7"));
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            verb.as_ptr(),
            url.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            1,
        )
    };
    if result as isize <= 32 {
        return Err("Could not open Discord in your browser. Please try again.".into());
    }
    Ok(())
}
