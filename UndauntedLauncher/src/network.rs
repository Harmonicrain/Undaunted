use crate::{Result, platform};
use serde_json::Value;
use std::{
    io::Read,
    net::Ipv4Addr,
    path::Path,
    process::Command,
    time::{Duration, Instant},
};
use url::{Host, Url};
pub fn server_origin(value: &str) -> Result<String> {
    if value.len() > 256 {
        return Err("Enter a valid server address.".into());
    }
    let url = Url::parse(value.trim())
        .map_err(|_| "Include http:// or https:// in the server address.")?;
    if !["http", "https"].contains(&url.scheme())
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err("Use a server address without a path, credentials or query.".into());
    }
    let private = match url.host() {
        Some(Host::Domain("localhost")) => true,
        Some(Host::Ipv6(ip)) => ip.is_loopback(),
        Some(Host::Ipv4(ip)) => private_ipv4(ip),
        _ => false,
    };
    if url.scheme() == "http" && !private {
        return Err("Public account servers must use HTTPS.".into());
    }
    Ok(url.origin().ascii_serialization())
}
fn private_ipv4(ip: Ipv4Addr) -> bool {
    let b = ip.octets();
    ip.is_loopback() || ip.is_private() || (b[0] == 100 && (64..=127).contains(&b[1]))
}
pub fn is_tailscale(origin: &str) -> bool {
    Url::parse(origin)
        .ok()
        .and_then(|u| match u.host() {
            Some(Host::Ipv4(ip)) => Some(ip.octets()),
            _ => None,
        })
        .is_some_and(|b| b[0] == 100 && (64..=127).contains(&b[1]))
}
pub struct Network {
    pub client: reqwest::blocking::Client,
    checked: Option<(String, Instant)>,
}
pub struct ApiError {
    pub message: String,
    pub status: Option<u16>,
}
impl Network {
    pub fn new() -> Result<Self> {
        Ok(Self {
            client: reqwest::blocking::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(15))
                .connect_timeout(Duration::from_secs(5))
                .build()
                .map_err(|_| "Could not initialize networking.")?,
            checked: None,
        })
    }
    pub fn tailnet(&mut self, origin: &str, required: bool) -> Result<()> {
        if !required {
            return Ok(());
        }
        if self
            .checked
            .as_ref()
            .is_some_and(|(s, t)| s == origin && t.elapsed() < Duration::from_secs(30))
        {
            return Ok(());
        }
        let bad = "Connect to Tailscale and accept the server sharing invitation before using this address.";
        let program = std::env::var_os("ProgramFiles").ok_or(bad)?;
        let mut command = Command::new(Path::new(&program).join("Tailscale/tailscale.exe"));
        command.args(["status", "--json"]);
        let bytes = platform::bounded_process(command, Duration::from_secs(5), 4 * 1024 * 1024)
            .map_err(|_| bad)?;
        let status: Value = serde_json::from_slice(&bytes).map_err(|_| bad)?;
        let url = Url::parse(origin).map_err(|_| bad)?;
        let host = url.host_str().ok_or(bad)?;
        let known = std::iter::once(&status["Self"])
            .chain(
                status["Peer"]
                    .as_object()
                    .into_iter()
                    .flat_map(|p| p.values()),
            )
            .any(|peer| {
                peer["TailscaleIPs"]
                    .as_array()
                    .is_some_and(|ips| ips.iter().any(|v| v.as_str() == Some(host)))
                    || peer["DNSName"]
                        .as_str()
                        .is_some_and(|dns| dns.trim_end_matches('.').eq_ignore_ascii_case(host))
            });
        if status["BackendState"] != "Running" || !known {
            return Err(bad.into());
        }
        self.checked = Some((origin.into(), Instant::now()));
        Ok(())
    }
    pub fn request(
        &mut self,
        origin: &str,
        route: &str,
        body: Option<Value>,
        access: Option<&str>,
    ) -> std::result::Result<Value, ApiError> {
        self.tailnet(origin, is_tailscale(origin))
            .map_err(|message| ApiError {
                message,
                status: None,
            })?;
        let url = format!("{origin}/launcher/v1/{route}");
        let mut request = if let Some(body) = body {
            self.client.post(url).json(&body)
        } else {
            self.client.get(url)
        };
        if let Some(token) = access {
            request = request.bearer_auth(token);
        }
        let response = request.send().map_err(|_| ApiError {
            message: "Could not reach the server. Check your connection and server address.".into(),
            status: None,
        })?;
        let code = response.status().as_u16();
        let data = bounded_json(response, 1024 * 1024).map_err(|_| ApiError {
            message: "This server does not support the 1.12 launcher yet.".into(),
            status: Some(code),
        })?;
        if !(200..300).contains(&code) {
            return Err(ApiError {
                message: data["message"]
                    .as_str()
                    .unwrap_or("The server could not complete this request.")
                    .chars()
                    .take(240)
                    .collect(),
                status: Some(code),
            });
        }
        Ok(data)
    }
    pub fn notes(&mut self, origin: &str) -> Result<Value> {
        self.tailnet(origin, is_tailscale(origin))?;
        let response = self
            .client
            .get(format!("{origin}/patchnotes/en/392819"))
            .timeout(Duration::from_secs(10))
            .send()
            .map_err(|_| "Could not load the update notes.")?;
        if !response.status().is_success() {
            return Err("This server has no update notes.".into());
        }
        Ok(crate::game::patch_notes(
            &bounded_json(response, 2 * 1024 * 1024)?["payload"],
        ))
    }
}
pub fn bounded_json(response: reqwest::blocking::Response, limit: u64) -> Result<Value> {
    if response.content_length().is_some_and(|n| n > limit) {
        return Err("The server response is too large.".into());
    }
    let mut bytes = Vec::new();
    response
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Could not read the server response.")?;
    if bytes.len() as u64 > limit {
        return Err("The server response is too large.".into());
    }
    serde_json::from_slice(&bytes).map_err(|_| "The server response is invalid.".into())
}
