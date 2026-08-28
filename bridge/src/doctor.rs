//! `pager-bridge doctor` — one command that answers "why am I not getting paged?"
//!
//! The chain has five links (extension → bridge → relay → push service → device)
//! and each one fails quietly in its own way. Diagnosing it by hand means
//! checking a listening port, a signed round trip, a device list, a quiet-hours
//! window, and per-device acknowledgements. This walks all of them in order and
//! prints a verdict per link, so the first ✗ or ⚠ is the answer.

use std::fmt;

use pager_proto::DeviceStatus;
use reqwest::Client;

use crate::health;
use crate::store::Devices;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Level {
    Ok,
    Warn,
    Fail,
}

impl fmt::Display for Level {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Level::Ok => "✓",
            Level::Warn => "⚠",
            Level::Fail => "✗",
        })
    }
}

pub struct Check {
    pub name: &'static str,
    pub level: Level,
    pub detail: String,
}

impl Check {
    pub fn new(name: &'static str, level: Level, detail: impl Into<String>) -> Self {
        Check {
            name,
            level,
            detail: detail.into(),
        }
    }
    pub fn ok(name: &'static str, detail: impl Into<String>) -> Self {
        Check::new(name, Level::Ok, detail)
    }
    pub fn warn(name: &'static str, detail: impl Into<String>) -> Self {
        Check::new(name, Level::Warn, detail)
    }
    pub fn fail(name: &'static str, detail: impl Into<String>) -> Self {
        Check::new(name, Level::Fail, detail)
    }
}

/// Print the checklist. Returns false if anything is outright broken, so the
/// caller can exit non-zero and the command is usable from a script.
pub fn report(checks: &[Check]) -> bool {
    let width = checks.iter().map(|c| c.name.len()).max().unwrap_or(0);
    for c in checks {
        println!("{} {:width$}  {}", c.level, c.name, c.detail);
    }
    let broken = checks.iter().filter(|c| c.level == Level::Fail).count();
    let warned = checks.iter().filter(|c| c.level == Level::Warn).count();
    println!();
    match (broken, warned) {
        (0, 0) => println!("all clear"),
        (0, w) => println!("{w} warning(s) — paging works but something needs attention"),
        (b, _) => println!("{b} failure(s) — paging is broken"),
    }
    broken == 0
}

/// The capture server the extension posts to. Run inside the same process as the
/// service and this is trivially true; run as a separate `doctor` invocation and
/// it is the check that catches a bridge that isn't running at all.
pub async fn check_capture(http: &Client, addr: &str) -> Check {
    match http.get(format!("http://{addr}/health")).send().await {
        Ok(r) if r.status().is_success() => {
            Check::ok("capture server", format!("listening on {addr}"))
        }
        Ok(r) => Check::warn("capture server", format!("{addr} answered {}", r.status())),
        Err(_) => Check::fail(
            "capture server",
            format!("nothing listening on {addr} — the bridge service isn't running"),
        ),
    }
}

/// The relay's contract version against the one this binary speaks.
pub fn check_contract(theirs: Option<u64>) -> Check {
    let ours = pager_proto::PAGER_CONTRACT_VERSION as u64;
    match theirs {
        Some(v) if v == ours => Check::ok("relay contract", format!("v{v}")),
        Some(v) => Check::fail(
            "relay contract",
            format!("relay speaks v{v}, this bridge speaks v{ours}"),
        ),
        None => Check::warn("relay contract", "relay did not report a contract version"),
    }
}

/// Quiet hours are a rule, not a fault — but being inside the window explains a
/// silent phone completely, so it earns a line.
pub fn check_quiet(quiet: Option<(u32, u32)>, hour: u32) -> Check {
    match quiet {
        None => Check::ok("quiet hours", "not configured"),
        Some((start, end)) if crate::in_quiet(hour, start, end) => Check::warn(
            "quiet hours",
            format!("inside {start}-{end} right now — pushes are being dropped"),
        ),
        Some((start, end)) => Check::ok("quiet hours", format!("{start}-{end}, not active")),
    }
}

/// Paired devices, and what the relay knows about each one's deliveries.
pub fn check_devices(devices: &Devices, status: Option<&[DeviceStatus]>, now: u64) -> Vec<Check> {
    if devices.devices.is_empty() {
        return vec![Check::fail(
            "devices",
            "none paired — run `pager-bridge pair`",
        )];
    }
    let mut out = vec![Check::ok(
        "devices",
        format!("{} paired", devices.devices.len()),
    )];
    let Some(status) = status else {
        out.push(Check::warn(
            "delivery state",
            "relay did not report it; cannot tell if devices are still paging",
        ));
        return out;
    };
    for dev in &devices.devices {
        let short = &dev.id[..dev.id.len().min(8)];
        let detail = |d: String| format!("{} ({short})  {d}", dev.label);
        match status.iter().find(|s| s.id == dev.id) {
            None => out.push(Check::new(
                "device",
                Level::Fail,
                detail("not subscribed on the relay — re-pair".into()),
            )),
            Some(st) if !st.can_ack => out.push(Check::new(
                "device",
                Level::Warn,
                detail(
                    "paired before acknowledgements — re-pair to see whether it is still paging"
                        .into(),
                ),
            )),
            Some(st) => match health::assess(st, now) {
                Some(f) => out.push(Check::new("device", Level::Fail, detail(f.detail().into()))),
                None => out.push(Check::new(
                    "device",
                    Level::Ok,
                    detail("acknowledging deliveries".into()),
                )),
            },
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Device;

    fn dev(id: &str) -> Device {
        Device {
            id: id.into(),
            label: "iPhone".into(),
            paired_at: 0,
            last_delivered: None,
        }
    }

    fn status(id: &str, can_ack: bool, last_ack: Option<u64>) -> DeviceStatus {
        DeviceStatus {
            id: id.into(),
            last_push: Some(1000),
            last_ack,
            last_shown: last_ack,
            can_ack,
        }
    }

    #[test]
    fn contract_mismatch_is_a_failure() {
        assert_eq!(check_contract(Some(0)).level, Level::Ok);
        assert_eq!(check_contract(Some(99)).level, Level::Fail);
        assert_eq!(check_contract(None).level, Level::Warn);
    }

    #[test]
    fn active_quiet_hours_are_worth_saying_out_loud() {
        assert_eq!(check_quiet(None, 3).level, Level::Ok);
        assert_eq!(check_quiet(Some((22, 7)), 3).level, Level::Warn);
        assert_eq!(check_quiet(Some((22, 7)), 12).level, Level::Ok);
    }

    #[test]
    fn no_devices_is_a_failure_not_a_warning() {
        let checks = check_devices(&Devices::default(), None, 1000);
        assert_eq!(checks.len(), 1);
        assert_eq!(checks[0].level, Level::Fail);
    }

    #[test]
    fn a_device_the_relay_has_never_heard_of_fails() {
        let devices = Devices {
            devices: vec![dev("aaaa1111")],
        };
        let checks = check_devices(&devices, Some(&[]), 1000);
        assert_eq!(checks[1].level, Level::Fail);
        assert!(checks[1].detail.contains("re-pair"));
    }

    #[test]
    fn a_silent_ack_capable_device_fails_and_a_legacy_one_only_warns() {
        let devices = Devices {
            devices: vec![dev("aaaa1111")],
        };
        // Pushed a minute ago and never acknowledged: recent enough to judge.
        let now = 1060;

        let silent = check_devices(&devices, Some(&[status("aaaa1111", true, None)]), now);
        assert_eq!(silent[1].level, Level::Fail);

        let legacy = check_devices(&devices, Some(&[status("aaaa1111", false, None)]), now);
        assert_eq!(legacy[1].level, Level::Warn);
    }

    #[test]
    fn healthy_devices_report_clean() {
        let devices = Devices {
            devices: vec![dev("aaaa1111")],
        };
        let checks = check_devices(
            &devices,
            Some(&[status("aaaa1111", true, Some(1000))]),
            1000,
        );
        assert!(checks.iter().all(|c| c.level == Level::Ok));
        assert!(report(&checks));
    }

    #[test]
    fn report_is_false_only_when_something_is_broken() {
        assert!(report(&[Check::warn("x", "y")]));
        assert!(!report(&[Check::fail("x", "y")]));
    }
}
