//! Pager wire contract — the single source of truth shared by the relay, the
//! bridge, and the device WASM so all three encode and decode the same bytes.
//!
//! Trust model (see HANDOFF.md): the bridge holds the only long-term identity and
//! the device keys; the relay sees ciphertext and routing metadata only. Two
//! crypto operations, both built on [`svastha_core`]:
//!
//! - **Sealing a notification.** The bridge wraps a fresh data key to each paired
//!   device's X25519 key and seals the notification JSON under it. The relay
//!   forwards the opaque [`SealedBlob`]; only the device can open it.
//! - **Pairing.** The device seals its enrollment ([`Enrollment`]) to the
//!   bridge's X25519 key (learned out of band via the QR), so the relay cannot
//!   forge an enrollment — it never holds a key that can seal to the bridge.
//!
//! Requests that mutate trusted state (ingest, subscribe, pairing fetch) are
//! authenticated by the bridge's Ed25519 key via [`auth`], reusing
//! `svastha_core::relay`'s canonical signing bytes.

pub mod auth;
pub mod seal;
pub mod wire;

/// Bumped with any breaking change to the wire shapes below. Surfaced in the
/// pairing payload and `/api/config` so device and relay can refuse a mismatch.
pub const PAGER_CONTRACT_VERSION: u32 = 0;

/// AEAD associated data binding sealed notification payloads to this purpose and
/// version. The bridge seals with it and the device opens with it; a mismatch
/// fails authentication.
pub const NOTIFY_AAD: &[u8] = b"pager/v0/notify";

pub use seal::{open_blob, seal_to, SealError};
pub use wire::{
    AckReq, Delivery, DeviceStatus, Enrollment, Notif, NotifyReq, NotifyResp, PairPayload,
    SealedBlob, SubscribeReq, Subscription, SubscriptionKeys,
};
