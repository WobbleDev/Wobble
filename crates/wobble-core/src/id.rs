//! Deterministic and production id sources. Parity with the B02 recorder (D-id
//! determinism) and the Node randomUUID sites.

use std::sync::atomic::{AtomicU64, Ordering};

/// A v4-shaped UUID whose final group is the counter in 12 lowercase hex digits,
/// byte-for-byte the B02 recorder's stub at the `pre-tauri-node` tag.
pub fn counter_id(counter: u64) -> String {
    format!("00000000-0000-4000-8000-{counter:012x}")
}

/// A production v4 UUID, matching node:crypto randomUUID.
pub fn random_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// An injectable id source (D-id determinism): tests set it to the recorder's counter.
pub trait IdSource {
    fn next_id(&self) -> String;
}

/// A thread-safe counter id source for replay tests (starts at 1, like the recorder).
pub struct CounterId {
    next: AtomicU64,
}

impl CounterId {
    pub fn new() -> Self {
        Self {
            next: AtomicU64::new(1),
        }
    }
}

impl Default for CounterId {
    fn default() -> Self {
        Self::new()
    }
}

impl IdSource for CounterId {
    fn next_id(&self) -> String {
        let counter = self.next.fetch_add(1, Ordering::SeqCst);
        counter_id(counter)
    }
}

/// The production source (a fresh v4 UUID each call).
pub struct RandomId;

impl IdSource for RandomId {
    fn next_id(&self) -> String {
        random_id()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counter_ids_match_the_recorder() {
        assert_eq!(counter_id(1), "00000000-0000-4000-8000-000000000001");
        assert_eq!(counter_id(10), "00000000-0000-4000-8000-00000000000a");
        assert_eq!(counter_id(16), "00000000-0000-4000-8000-000000000010");
    }

    #[test]
    fn counter_id_increments_from_one() {
        let ids = CounterId::new();
        assert_eq!(ids.next_id(), counter_id(1));
        assert_eq!(ids.next_id(), counter_id(2));
    }
}
