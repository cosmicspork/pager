//! Serde shapes for every pager request/response and the sealed-blob framing.
//! Field names are the JSON wire names; keep them stable across a contract major.

use serde::{Deserialize, Serialize};

/// A W3C Web Push subscription as the browser produces it. The relay needs these
/// transport keys in the clear to sign and encrypt to the push service; they are
/// *not* the end-to-end keys and carry no message content, so holding them does
/// not weaken zero-knowledge.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Subscription {
    pub endpoint: String,
    pub keys: SubscriptionKeys,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SubscriptionKeys {
    pub p256dh: String,
    pub auth: String,
}

/// The canonical sealed envelope used both for the pairing blob and for each
/// notification push payload: a data key wrapped to the recipient (`wk`) plus the
/// payload sealed under that data key (`ct`). Both fields are standard base64.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SealedBlob {
    pub v: u32,
    /// `WrappedKey` wire bytes, base64. (`ephemeral_public ‖ sealed_data_key`)
    pub wk: String,
    /// `Sealed` wire bytes, base64. (`nonce ‖ ciphertext+tag`)
    pub ct: String,
}

/// What a device seals to the bridge during pairing. The relay only ever sees
/// this wrapped inside a [`SealedBlob`] addressed to the bridge.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Enrollment {
    /// The device's X25519 public key (hex) — the address the bridge wraps
    /// notification data keys to. Doubles as the device id.
    pub device_x25519: String,
    /// The device's Ed25519 public key (hex), registered with the relay so it can
    /// verify that device's delivery acknowledgements. Empty for devices paired
    /// before acknowledgements existed; those simply cannot ack.
    #[serde(default)]
    pub device_ed25519: String,
    /// Human label for the bridge's device list (e.g. "iPhone").
    pub label: String,
    /// The device's Web Push subscription, handed to the relay by the bridge.
    pub subscription: Subscription,
}

/// The cleartext a notification carries once the device opens its [`SealedBlob`].
///
/// `url` and `tag` are additive and optional: a device running an older
/// service worker ignores them, and a sender that omits them behaves exactly
/// as before, so neither the contract version nor the AAD moves.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Notif {
    pub title: String,
    pub body: String,
    /// Origin app: "teams" | "outlook" | "tracon" (or "test").
    pub source: String,
    /// Unix milliseconds the bridge stamped.
    pub ts: u64,
    /// Where tapping the notification should land. Absent means the app root.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// The banner's replacement key. Absent falls back to `source`, which is
    /// what collapses a run of mail into one banner; a sender that wants each
    /// item to stand on its own sets a distinct tag.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tag: Option<String>,
}

/// `POST /api/subscribe` (bridge-authenticated): register a device's push
/// subscription under its id so the relay can fan out to it.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SubscribeReq {
    /// Device id = its X25519 public key, hex.
    pub id: String,
    pub subscription: Subscription,
    /// The device's Ed25519 public key (hex) for verifying its acks. Absent for
    /// devices enrolled by a bridge that predates acknowledgements.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ed25519: Option<String>,
}

/// One sealed push addressed to one device.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Delivery {
    /// Target device id (X25519 hex).
    pub id: String,
    /// `SealedBlob` JSON, base64 — the exact bytes delivered as the push payload.
    pub payload: String,
}

/// `POST /api/notify` (bridge-authenticated): a batch of per-device sealed pushes.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct NotifyReq {
    pub deliveries: Vec<Delivery>,
}

/// `/api/notify` result. `gone` lists device ids whose push subscription the push
/// service rejected (404/410) so the bridge can drop them; `delivered` lists the
/// ids the push service accepted, so an aggregate count never has to be guessed
/// back into per-device outcomes.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct NotifyResp {
    pub sent: u32,
    pub failed: u32,
    pub gone: Vec<String>,
    /// Empty when the relay predates per-device outcomes.
    #[serde(default)]
    pub delivered: Vec<String>,
}

/// `POST /api/ack/:id` (device-authenticated): the device reports that a push
/// reached its service worker. Signed with the device's Ed25519 key over the
/// same canonical bytes the bridge uses, and verified against the key registered
/// at enrollment — the relay learns liveness, never content.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AckReq {
    /// Whether the notification actually reached the screen. False means the
    /// worker ran but the device refused to display it (alerts switched off).
    pub shown: bool,
}

/// One row of `GET /api/devices` (bridge-authenticated): what the relay knows
/// about a device's delivery state. All timestamps are unix seconds.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DeviceStatus {
    pub id: String,
    /// Last push the push service accepted for this device.
    pub last_push: Option<u64>,
    /// Last acknowledgement from the device's service worker.
    pub last_ack: Option<u64>,
    /// Last acknowledgement that also reported the alert was displayed.
    pub last_shown: Option<u64>,
    /// False for devices enrolled before acks; their silence means nothing.
    pub can_ack: bool,
}

/// The data a pairing QR/URL carries to a new device. Encoded base64url in the
/// URL fragment of `https://<relay>/pair#<payload>` so the iOS Camera app can
/// open it straight into Safari without any in-app scanner.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PairPayload {
    /// Relay origin, e.g. "https://pager.0x69.xyz".
    pub relay: String,
    /// Bridge X25519 public key (hex) the device seals its enrollment to.
    pub bridge_x25519: String,
    /// VAPID public key (base64url) the device subscribes with.
    pub vapid_public_key: String,
    /// One-time pairing token; also the AEAD aad binding the enrollment blob.
    pub token: String,
    pub contract_version: u32,
}
