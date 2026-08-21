//! On-disk state for the bridge: its long-term identity (a BIP39 mnemonic) and
//! the list of paired devices. Both live under the config dir with 0600 perms.

use std::fs;
use std::io::Write;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use svastha_core::keys::Identity;

#[derive(Serialize, Deserialize)]
struct BridgeFile {
    /// 24-word BIP39 phrase the identity is derived from. The single secret.
    mnemonic: String,
    /// Cached public keys for human reference; derivation is the source of truth.
    ed25519_pub: String,
    x25519_pub: String,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Device {
    /// X25519 public key (hex) — the seal address and the device id.
    pub id: String,
    pub label: String,
    pub paired_at: u64,
    /// Unix seconds of the last push the relay reported as accepted for this
    /// device. Absent on devices last written by a bridge without per-device
    /// outcomes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_delivered: Option<u64>,
}

#[derive(Default, Serialize, Deserialize)]
pub struct Devices {
    pub devices: Vec<Device>,
}

pub fn config_dir() -> PathBuf {
    if let Ok(d) = std::env::var("PAGER_CONFIG_DIR") {
        return PathBuf::from(d);
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    PathBuf::from(home).join(".config").join("pager")
}

/// Load the bridge identity, creating and persisting a fresh one on first run.
pub fn load_or_create_identity(dir: &Path) -> Result<Identity> {
    let path = dir.join("bridge.json");
    if path.exists() {
        let f: BridgeFile = serde_json::from_slice(&fs::read(&path)?)
            .with_context(|| format!("parsing {}", path.display()))?;
        return Identity::from_mnemonic(&f.mnemonic, "").map_err(|e| anyhow::anyhow!(e));
    }
    fs::create_dir_all(dir)?;
    fs::set_permissions(dir, fs::Permissions::from_mode(0o700)).ok();
    let (mnemonic, identity) = Identity::generate().map_err(|e| anyhow::anyhow!(e))?;
    let f = BridgeFile {
        mnemonic: mnemonic.to_string(),
        ed25519_pub: hex::encode(identity.verifying_key().to_bytes()),
        x25519_pub: hex::encode(identity.x25519_public().as_bytes()),
    };
    write_0600(&path, &serde_json::to_vec_pretty(&f)?)?;
    Ok(identity)
}

pub fn load_devices(dir: &Path) -> Result<Devices> {
    let path = dir.join("devices.json");
    if !path.exists() {
        return Ok(Devices::default());
    }
    Ok(serde_json::from_slice(&fs::read(&path)?)?)
}

pub fn save_devices(dir: &Path, d: &Devices) -> Result<()> {
    write_0600(&dir.join("devices.json"), &serde_json::to_vec_pretty(d)?)
}

/// Write a file with 0600 perms, replacing any existing content.
fn write_0600(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut f = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)?;
    f.write_all(bytes)?;
    // Re-assert perms in case the file pre-existed with a looser mode.
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).ok();
    Ok(())
}
