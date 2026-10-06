pub mod core;
pub mod game;
pub mod network;
pub mod platform;
pub mod profile;
pub mod updates;

pub type Result<T> = std::result::Result<T, String>;
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
