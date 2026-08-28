//! Device-side WASM for the pager PWA. Thin `#[wasm_bindgen]` wrappers over
//! [`pager_proto`] + `svastha_core` so the service worker decrypts notifications
//! with the exact same envelope code the bridge sealed them with.
//!
//! The device holds an X25519/Ed25519 identity derived from a BIP39 mnemonic kept
//! in IndexedDB. Only public keys, the mnemonic (for re-derivation), and decrypted
//! plaintext cross the JS boundary; the secret stays in wasm linear memory.

use pager_proto::wire::SealedBlob;
use svastha_core::keys::Identity;
use wasm_bindgen::prelude::*;

/// Install a readable panic hook on module load.
#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
}

/// The pager wire contract version this build speaks.
#[wasm_bindgen]
pub fn contract_version() -> u32 {
    pager_proto::PAGER_CONTRACT_VERSION
}

fn to_js<E: std::fmt::Display>(e: E) -> JsError {
    JsError::new(&e.to_string())
}

/// A device identity. Generate once at pairing, persist [`mnemonic`](Self::mnemonic)
/// in IndexedDB, and re-derive in the service worker on each push to decrypt.
#[wasm_bindgen]
pub struct DeviceIdentity {
    identity: Identity,
    mnemonic: Option<String>,
}

#[wasm_bindgen]
impl DeviceIdentity {
    /// Generate a fresh 24-word device identity.
    pub fn generate() -> Result<DeviceIdentity, JsError> {
        let (mnemonic, identity) = Identity::generate().map_err(to_js)?;
        Ok(DeviceIdentity {
            identity,
            mnemonic: Some(mnemonic.to_string()),
        })
    }

    /// Re-derive a device identity from its persisted mnemonic.
    pub fn from_mnemonic(phrase: &str) -> Result<DeviceIdentity, JsError> {
        let identity = Identity::from_mnemonic(phrase, "").map_err(to_js)?;
        Ok(DeviceIdentity {
            identity,
            mnemonic: Some(phrase.to_string()),
        })
    }

    /// The backup mnemonic to persist (only present right after `generate`).
    #[wasm_bindgen(getter)]
    pub fn mnemonic(&self) -> Option<String> {
        self.mnemonic.clone()
    }

    /// The device's X25519 public key (hex) — its id and seal address.
    #[wasm_bindgen(getter)]
    pub fn x25519_hex(&self) -> String {
        hex::encode(self.identity.x25519_public().as_bytes())
    }

    /// The device's Ed25519 public key (hex). Registered with the relay at
    /// enrollment so it can verify this device's delivery acknowledgements.
    #[wasm_bindgen(getter)]
    pub fn ed25519_hex(&self) -> String {
        hex::encode(self.identity.verifying_key().to_bytes())
    }

    /// Sign a relay request the way the bridge does — over the canonical
    /// method/path/body/timestamp bytes — returning the three header values as
    /// JSON. The service worker uses this to authenticate its acks; the device's
    /// secret never leaves wasm memory.
    pub fn sign_headers(
        &self,
        method: &str,
        path: &str,
        body: &[u8],
        now_secs: u64,
    ) -> Result<String, JsError> {
        let h = pager_proto::auth::sign(&self.identity, method, path, body, now_secs);
        serde_json::to_string(&h).map_err(to_js)
    }

    /// Open a notification `SealedBlob` (JSON) addressed to this device, returning
    /// the plaintext bytes. `aad` must match what the bridge sealed with.
    pub fn open(&self, blob_json: &str, aad: &[u8]) -> Result<Vec<u8>, JsError> {
        let blob: SealedBlob = serde_json::from_str(blob_json).map_err(to_js)?;
        pager_proto::open_blob(&self.identity, &blob, aad).map_err(to_js)
    }
}

/// Seal `plaintext` to a recipient's X25519 public key (hex), returning a
/// `SealedBlob` as JSON. The PWA uses this to seal its enrollment to the bridge.
#[wasm_bindgen]
pub fn seal_to(
    recipient_x25519_hex: &str,
    plaintext: &[u8],
    aad: &[u8],
) -> Result<String, JsError> {
    let blob = pager_proto::seal_to(recipient_x25519_hex, plaintext, aad).map_err(to_js)?;
    serde_json::to_string(&blob).map_err(to_js)
}
