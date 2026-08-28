//! Seal/open helpers over [`svastha_core`]'s envelope, producing and consuming
//! the [`SealedBlob`] wire form. Used by the bridge (seal notifications to
//! devices, open pairing blobs) and mirrored by the device WASM.

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use svastha_core::envelope::{wrap_key, DataKey, Sealed, WrappedKey};
use svastha_core::keys::Identity;
use x25519_dalek::PublicKey;

use crate::wire::SealedBlob;
use crate::PAGER_CONTRACT_VERSION;

#[derive(Debug, thiserror::Error)]
pub enum SealError {
    #[error("recipient key is not 32-byte hex")]
    BadRecipient,
    #[error("blob field is not valid base64")]
    BadBase64,
    #[error("blob bytes are malformed")]
    BadFormat,
    #[error("decryption failed (wrong key, tampering, or aad mismatch)")]
    OpenFailed,
}

/// Seal `plaintext` to a recipient's X25519 public key (hex). Generates a fresh
/// random data key, seals the payload under it with `aad`, and wraps the data key
/// to the recipient. Only the recipient's secret can recover it.
pub fn seal_to(
    recipient_x25519_hex: &str,
    plaintext: &[u8],
    aad: &[u8],
) -> Result<SealedBlob, SealError> {
    let recipient = parse_public(recipient_x25519_hex)?;
    let data_key = DataKey::generate();
    let sealed = data_key.seal(plaintext, aad);
    let wrapped = wrap_key(&recipient, &data_key);
    Ok(SealedBlob {
        v: PAGER_CONTRACT_VERSION,
        wk: B64.encode(wrapped.to_bytes()),
        ct: B64.encode(sealed.to_bytes()),
    })
}

/// Open a [`SealedBlob`] with `identity`'s X25519 secret, supplying the same
/// `aad` used to seal. Unwraps the data key, then opens the payload.
pub fn open_blob(identity: &Identity, blob: &SealedBlob, aad: &[u8]) -> Result<Vec<u8>, SealError> {
    let wk = B64.decode(&blob.wk).map_err(|_| SealError::BadBase64)?;
    let ct = B64.decode(&blob.ct).map_err(|_| SealError::BadBase64)?;
    let wrapped = WrappedKey::from_bytes(&wk).map_err(|_| SealError::BadFormat)?;
    let data_key = identity
        .unwrap_key(&wrapped)
        .map_err(|_| SealError::OpenFailed)?;
    let sealed = Sealed::from_bytes(&ct).map_err(|_| SealError::BadFormat)?;
    data_key
        .open(&sealed, aad)
        .map_err(|_| SealError::OpenFailed)
}

fn parse_public(hex_str: &str) -> Result<PublicKey, SealError> {
    let bytes = hex::decode(hex_str).map_err(|_| SealError::BadRecipient)?;
    let arr: [u8; 32] = bytes.try_into().map_err(|_| SealError::BadRecipient)?;
    Ok(PublicKey::from(arr))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seal_open_roundtrip() {
        let (_m, id) = Identity::generate().unwrap();
        let recipient_hex = hex::encode(id.x25519_public().as_bytes());
        let blob = seal_to(&recipient_hex, b"hello phone", NOTIFY_AAD_TEST).unwrap();
        let out = open_blob(&id, &blob, NOTIFY_AAD_TEST).unwrap();
        assert_eq!(out, b"hello phone");
    }

    #[test]
    fn wrong_identity_cannot_open() {
        let (_m, sender_target) = Identity::generate().unwrap();
        let (_m2, attacker) = Identity::generate().unwrap();
        let recipient_hex = hex::encode(sender_target.x25519_public().as_bytes());
        let blob = seal_to(&recipient_hex, b"secret", NOTIFY_AAD_TEST).unwrap();
        assert!(open_blob(&attacker, &blob, NOTIFY_AAD_TEST).is_err());
    }

    #[test]
    fn aad_mismatch_fails() {
        let (_m, id) = Identity::generate().unwrap();
        let recipient_hex = hex::encode(id.x25519_public().as_bytes());
        let blob = seal_to(&recipient_hex, b"secret", b"aad-one").unwrap();
        assert!(open_blob(&id, &blob, b"aad-two").is_err());
    }

    const NOTIFY_AAD_TEST: &[u8] = b"pager/v0/notify";
}
