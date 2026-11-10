use super::*;

/// FNV-1a over the canonical state: a short deterministic token with no dependency and no
/// id consumption.
pub(super) fn fingerprint(input: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in input.bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

pub(super) fn refusal(
    code: &'static str,
    status: u16,
    message: impl Into<String>,
) -> ResolutionRefusal {
    ResolutionRefusal {
        code,
        status,
        message: message.into(),
    }
}

pub(super) fn stale() -> ResolutionRefusal {
    refusal(
        "stale_configuration_preview",
        409,
        "This Configuration preview is stale; nothing was saved. Review the changes again.",
    )
}

pub(super) fn missing_resolution(message: impl Into<String>) -> ResolutionRefusal {
    refusal("configuration_resolution_required", 409, message)
}

pub(super) fn invalid_replacement(message: impl Into<String>) -> ResolutionRefusal {
    refusal("configuration_replacement_invalid", 400, message)
}
