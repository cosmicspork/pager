//! Bridge↔relay request authentication. The bridge signs each mutating request
//! with its Ed25519 key over `svastha_core`'s canonical relay-auth bytes (method,
//! path, body hash, timestamp); the relay verifies the signature, that the key is
//! the one authorized bridge key, and that the timestamp is fresh. Stateless: no
//! sessions, no server secret, no nonce store.

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use svastha_core::keys::Identity;
use svastha_core::relay::{sign_request, verify_request, AuthRequest};

/// Hex of the bridge's Ed25519 public key.
pub const HEADER_PUBKEY: &str = "svastha-pubkey";
/// Base64 of the 64-byte Ed25519 signature.
pub const HEADER_SIGNATURE: &str = "svastha-signature";
/// Unix seconds the signature was produced.
pub const HEADER_TIMESTAMP: &str = "svastha-timestamp";

/// Default freshness window in seconds (request rejected if `|now - ts|` exceeds).
pub const DEFAULT_WINDOW_SECS: u64 = 300;

#[derive(Debug, thiserror::Error)]
pub enum AuthError {
    #[error("missing or malformed auth header")]
    BadHeader,
    #[error("timestamp outside freshness window")]
    Stale,
    #[error("key is not the authorized bridge key")]
    Unauthorized,
    #[error("signature does not verify")]
    BadSignature,
}

/// The three header values a signed request carries.
pub struct SignedHeaders {
    pub pubkey: String,
    pub signature: String,
    pub timestamp: u64,
}

/// Client side (bridge): sign `(method, path, body)` at time `now`. `path` must
/// include the query string. Returns the header values to attach.
pub fn sign(identity: &Identity, method: &str, path: &str, body: &[u8], now: u64) -> SignedHeaders {
    let req = AuthRequest::new(method, path, body, now);
    let sig = sign_request(identity, &req);
    SignedHeaders {
        pubkey: hex::encode(identity.verifying_key().to_bytes()),
        signature: B64.encode(sig),
        timestamp: now,
    }
}

/// Relay side: verify a request against the single authorized bridge public key
/// (hex). Checks freshness against `now`/`window`, key authorization, then the
/// Ed25519 signature over the canonical bytes.
pub fn verify(
    authorized_pubkey_hex: &str,
    method: &str,
    path: &str,
    body: &[u8],
    pubkey_hex: &str,
    signature_b64: &str,
    timestamp: u64,
    now: u64,
    window: u64,
) -> Result<(), AuthError> {
    let pubkey = parse_pubkey(pubkey_hex)?;
    let authorized = parse_pubkey(authorized_pubkey_hex).map_err(|_| AuthError::Unauthorized)?;
    if pubkey != authorized {
        return Err(AuthError::Unauthorized);
    }
    if now.abs_diff(timestamp) > window {
        return Err(AuthError::Stale);
    }
    let sig = parse_sig(signature_b64)?;
    let req = AuthRequest::new(method, path, body, timestamp);
    if verify_request(&pubkey, &sig, &req) {
        Ok(())
    } else {
        Err(AuthError::BadSignature)
    }
}

fn parse_pubkey(hex_str: &str) -> Result<[u8; 32], AuthError> {
    let bytes = hex::decode(hex_str).map_err(|_| AuthError::BadHeader)?;
    bytes.try_into().map_err(|_| AuthError::BadHeader)
}

fn parse_sig(b64: &str) -> Result<[u8; 64], AuthError> {
    let bytes = B64.decode(b64).map_err(|_| AuthError::BadHeader)?;
    bytes.try_into().map_err(|_| AuthError::BadHeader)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sign_then_verify_ok() {
        let (_m, id) = Identity::generate().unwrap();
        let authorized = hex::encode(id.verifying_key().to_bytes());
        let h = sign(&id, "POST", "/api/notify", b"{}", 1000);
        assert!(verify(&authorized, "POST", "/api/notify", b"{}", &h.pubkey, &h.signature, h.timestamp, 1010, 300).is_ok());
    }

    #[test]
    fn rejects_other_key() {
        let (_m, id) = Identity::generate().unwrap();
        let (_m2, other) = Identity::generate().unwrap();
        let authorized = hex::encode(other.verifying_key().to_bytes());
        let h = sign(&id, "POST", "/api/notify", b"{}", 1000);
        let r = verify(&authorized, "POST", "/api/notify", b"{}", &h.pubkey, &h.signature, h.timestamp, 1010, 300);
        assert!(matches!(r, Err(AuthError::Unauthorized)));
    }

    #[test]
    fn rejects_stale() {
        let (_m, id) = Identity::generate().unwrap();
        let authorized = hex::encode(id.verifying_key().to_bytes());
        let h = sign(&id, "POST", "/api/notify", b"{}", 1000);
        let r = verify(&authorized, "POST", "/api/notify", b"{}", &h.pubkey, &h.signature, h.timestamp, 5000, 300);
        assert!(matches!(r, Err(AuthError::Stale)));
    }

    #[test]
    fn rejects_tampered_body() {
        let (_m, id) = Identity::generate().unwrap();
        let authorized = hex::encode(id.verifying_key().to_bytes());
        let h = sign(&id, "POST", "/api/notify", b"{}", 1000);
        let r = verify(&authorized, "POST", "/api/notify", b"{\"x\":1}", &h.pubkey, &h.signature, h.timestamp, 1010, 300);
        assert!(matches!(r, Err(AuthError::BadSignature)));
    }
}
