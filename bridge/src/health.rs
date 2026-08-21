//! Delivery health: does a device that the relay is happily pushing to still
//! actually page?
//!
//! `sent=1 failed=0` only means the push service accepted the message. Between
//! that and a banner on a phone sit the service worker and the OS's notification
//! permission, and both can fail silently for days. Devices acknowledge each
//! push they handle, so the relay can report two distinct kinds of quiet:
//!
//! - **Silent** — pushes land, no acks. The worker isn't running: the app was
//!   deleted, its storage was evicted, or the subscription is a zombie the push
//!   service hasn't retired yet. Re-pair.
//! - **NotShowing** — acks arrive, but none of them report a displayed alert.
//!   The worker is fine and notification permission is not.

use std::time::Duration;

use pager_proto::DeviceStatus;

/// How often the bridge asks the relay for delivery state while pushing.
pub const CHECK_EVERY: Duration = Duration::from_secs(15 * 60);
/// Silence longer than this, while pushes are landing, is a fault.
pub const STALE_SECS: u64 = 6 * 3600;
/// Don't repeat the same complaint about the same device more often than this.
pub const RENOTIFY_SECS: u64 = 12 * 3600;
/// Only judge a device the relay has actually pushed to recently.
const RECENT_PUSH_SECS: u64 = 6 * 3600;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Fault {
    /// Pushes are being accepted but the device's worker never reports in.
    Silent,
    /// The worker reports in, but nothing is reaching the screen.
    NotShowing,
}

impl Fault {
    pub fn headline(&self, label: &str) -> String {
        match self {
            Fault::Silent => format!("{label} has stopped acknowledging pages"),
            Fault::NotShowing => format!("{label} is not showing alerts"),
        }
    }

    pub fn detail(&self) -> &'static str {
        match self {
            Fault::Silent => "Pushes are being accepted but never handled — re-pair the device.",
            Fault::NotShowing => "Pages are arriving but alerts are switched off on the device.",
        }
    }
}

/// Judge one device's delivery state. `None` means healthy, or not judgeable:
/// devices that cannot ack, or that nothing has been pushed to recently, are
/// never faulted — absence of evidence is not evidence here.
pub fn assess(st: &DeviceStatus, now: u64) -> Option<Fault> {
    if !st.can_ack {
        return None;
    }
    let pushed = st.last_push?;
    if now.saturating_sub(pushed) > RECENT_PUSH_SECS {
        return None;
    }
    let stale = |t: Option<u64>| t.is_none_or(|t| now.saturating_sub(t) > STALE_SECS);
    match (stale(st.last_ack), stale(st.last_shown)) {
        (true, _) => Some(Fault::Silent),
        (false, true) => Some(Fault::NotShowing),
        _ => None,
    }
}

/// Raise a desktop notification on the machine running the bridge. Best-effort:
/// a missing helper is not worth failing a push over.
pub fn notify_locally(title: &str, body: &str) {
    let mut cmd = if cfg!(target_os = "macos") {
        let script = format!(
            "display notification {} with title {}",
            applescript_string(body),
            applescript_string(title)
        );
        let mut c = std::process::Command::new("osascript");
        c.arg("-e").arg(script);
        c
    } else {
        let mut c = std::process::Command::new("notify-send");
        c.arg(title).arg(body);
        c
    };
    if let Ok(mut child) = cmd.spawn() {
        std::thread::spawn(move || child.wait());
    }
}

/// Quote a string for AppleScript: backslashes and double quotes escaped.
fn applescript_string(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: u64 = 1_000_000;

    fn st(last_push: Option<u64>, last_ack: Option<u64>, last_shown: Option<u64>) -> DeviceStatus {
        DeviceStatus { id: "abc".into(), last_push, last_ack, last_shown, can_ack: true }
    }

    #[test]
    fn healthy_device_is_not_faulted() {
        assert_eq!(assess(&st(Some(NOW - 60), Some(NOW - 60), Some(NOW - 60)), NOW), None);
    }

    #[test]
    fn pushes_landing_with_no_acks_is_silent() {
        assert_eq!(assess(&st(Some(NOW - 60), None, None), NOW), Some(Fault::Silent));
        let long_ago = NOW - STALE_SECS - 1;
        assert_eq!(assess(&st(Some(NOW - 60), Some(long_ago), Some(long_ago)), NOW), Some(Fault::Silent));
    }

    #[test]
    fn acking_without_displaying_is_the_alerts_off_case() {
        let long_ago = NOW - STALE_SECS - 1;
        assert_eq!(assess(&st(Some(NOW - 60), Some(NOW - 60), Some(long_ago)), NOW), Some(Fault::NotShowing));
        assert_eq!(assess(&st(Some(NOW - 60), Some(NOW - 60), None), NOW), Some(Fault::NotShowing));
    }

    #[test]
    fn silence_alone_proves_nothing() {
        // Nothing pushed recently: the device has had no chance to ack.
        assert_eq!(assess(&st(Some(NOW - RECENT_PUSH_SECS - 1), None, None), NOW), None);
        assert_eq!(assess(&st(None, None, None), NOW), None);
        // Devices paired before acks existed can never ack; never fault them.
        let mut legacy = st(Some(NOW - 60), None, None);
        legacy.can_ack = false;
        assert_eq!(assess(&legacy, NOW), None);
    }

    #[test]
    fn applescript_strings_are_quoted() {
        assert_eq!(applescript_string(r#"a"b\c"#), r#""a\"b\\c""#);
    }
}
