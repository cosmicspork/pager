//! Bridge↔relay request authentication. The bridge signs each mutating request
//! with its Ed25519 key over `svastha_core`'s canonical relay-auth bytes (method,
//! path, body hash, timestamp); the relay verifies the signature, that the key is
//! among the authorized bridge keys, and that the timestamp is fresh. Stateless:
//! no sessions, no server secret, no nonce store.
//!
//! More than one bridge may be authorized. Each still holds its own device keys
//! and seals its own notifications, so this widens who may *send* without
//! widening who can read: a laptop bridge for what the laptop sees, a bridge
//! beside the always-on services for what they raise while it sleeps.

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
#[derive(serde::Serialize, serde::Deserialize)]
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

/// Relay side: verify a request against the authorized bridge public keys
/// (hex). Checks freshness against `now`/`window`, key authorization, then the
/// Ed25519 signature over the canonical bytes.
#[allow(clippy::too_many_arguments)] // a request descriptor split across header fields
pub fn verify<'a>(
    authorized_pubkeys_hex: impl IntoIterator<Item = &'a str>,
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
    // An unparseable entry in the configured list is not authorization for
    // anything; it is skipped rather than failing the whole check.
    let known = authorized_pubkeys_hex
        .into_iter()
        .filter_map(|h| parse_pubkey(h).ok())
        .any(|k| k == pubkey);
    if !known {
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
        assert!(verify(
            [authorized.as_str()],
            "POST",
            "/api/notify",
            b"{}",
            &h.pubkey,
            &h.signature,
            h.timestamp,
            1010,
            300
        )
        .is_ok());
    }

    #[test]
    fn rejects_other_key() {
        let (_m, id) = Identity::generate().unwrap();
        let (_m2, other) = Identity::generate().unwrap();
        let authorized = hex::encode(other.verifying_key().to_bytes());
        let h = sign(&id, "POST", "/api/notify", b"{}", 1000);
        let r = verify(
            [authorized.as_str()],
            "POST",
            "/api/notify",
            b"{}",
            &h.pubkey,
            &h.signature,
            h.timestamp,
            1010,
            300,
        );
        assert!(matches!(r, Err(AuthError::Unauthorized)));
    }

    #[test]
    fn any_authorized_bridge_is_accepted_and_a_stranger_still_is_not() {
        let (_m, laptop) = Identity::generate().unwrap();
        let (_m2, cluster) = Identity::generate().unwrap();
        let (_m3, stranger) = Identity::generate().unwrap();
        let authorized = [
            hex::encode(laptop.verifying_key().to_bytes()),
            hex::encode(cluster.verifying_key().to_bytes()),
        ];
        let keys = || authorized.iter().map(String::as_str);
        for id in [&laptop, &cluster] {
            let h = sign(id, "POST", "/api/notify", b"{}", 1000);
            assert!(verify(
                keys(),
                "POST",
                "/api/notify",
                b"{}",
                &h.pubkey,
                &h.signature,
                h.timestamp,
                1010,
                300
            )
            .is_ok());
        }
        let h = sign(&stranger, "POST", "/api/notify", b"{}", 1000);
        let r = verify(
            keys(),
            "POST",
            "/api/notify",
            b"{}",
            &h.pubkey,
            &h.signature,
            h.timestamp,
            1010,
            300,
        );
        assert!(matches!(r, Err(AuthError::Unauthorized)));
    }

    /// A malformed entry authorizes nothing, and does not stop the rest from
    /// being checked.
    #[test]
    fn a_junk_entry_is_skipped_not_trusted() {
        let (_m, id) = Identity::generate().unwrap();
        let good = hex::encode(id.verifying_key().to_bytes());
        let h = sign(&id, "POST", "/api/notify", b"{}", 1000);
        assert!(verify(
            ["not-hex", good.as_str()],
            "POST",
            "/api/notify",
            b"{}",
            &h.pubkey,
            &h.signature,
            h.timestamp,
            1010,
            300
        )
        .is_ok());
        let r = verify(
            ["not-hex"],
            "POST",
            "/api/notify",
            b"{}",
            &h.pubkey,
            &h.signature,
            h.timestamp,
            1010,
            300,
        );
        assert!(matches!(r, Err(AuthError::Unauthorized)));
    }

    #[test]
    fn rejects_stale() {
        let (_m, id) = Identity::generate().unwrap();
        let authorized = hex::encode(id.verifying_key().to_bytes());
        let h = sign(&id, "POST", "/api/notify", b"{}", 1000);
        let r = verify(
            [authorized.as_str()],
            "POST",
            "/api/notify",
            b"{}",
            &h.pubkey,
            &h.signature,
            h.timestamp,
            5000,
            300,
        );
        assert!(matches!(r, Err(AuthError::Stale)));
    }

    #[test]
    fn rejects_tampered_body() {
        let (_m, id) = Identity::generate().unwrap();
        let authorized = hex::encode(id.verifying_key().to_bytes());
        let h = sign(&id, "POST", "/api/notify", b"{}", 1000);
        let r = verify(
            [authorized.as_str()],
            "POST",
            "/api/notify",
            b"{\"x\":1}",
            &h.pubkey,
            &h.signature,
            h.timestamp,
            1010,
            300,
        );
        assert!(matches!(r, Err(AuthError::BadSignature)));
    }
}
