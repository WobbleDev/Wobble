//! The quit guard: a quit request (Cmd+Q, the app menu's Quit, the Dock) never exits by
//! itself. It asks the page to run the unsaved-changes guard; the page acknowledges with
//! `quit_ack` and quits with `exit_app` (staying simply never calls it). If the page never
//! acknowledges (crashed or hung) the app quits anyway, so a broken page cannot trap the
//! organizer.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

/// The event the frontend listens for.
pub const QUIT_REQUESTED_EVENT: &str = "quit-requested";

/// How long the page gets to answer before the app quits anyway.
pub const ANSWER_TIMEOUT: Duration = Duration::from_secs(5);

/// What the gate needs from the running app; faked in the tests.
pub trait QuitHost: Send + Sync + 'static {
    fn emit_quit_requested(&self);
    fn exit(&self);
}

pub struct QuitGate<H: QuitHost> {
    host: Arc<H>,
    /// Bumped by every request and every answer, so a stale timeout cannot quit
    /// after the organizer chose to stay.
    generation: Arc<AtomicU64>,
    timeout: Duration,
}

impl<H: QuitHost> QuitGate<H> {
    pub fn new(host: H, timeout: Duration) -> Self {
        Self {
            host: Arc::new(host),
            generation: Arc::new(AtomicU64::new(0)),
            timeout,
        }
    }

    /// A quit was asked for: tell the page, do not exit, and arm the fallback.
    pub fn request(&self) {
        let mine = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        self.host.emit_quit_requested();

        let host = Arc::clone(&self.host);
        let generation = Arc::clone(&self.generation);
        let timeout = self.timeout;
        std::thread::spawn(move || {
            std::thread::sleep(timeout);
            if generation.load(Ordering::SeqCst) == mine {
                host.exit();
            }
        });
    }

    /// The page took the request and answers itself: the fallback is disarmed.
    pub fn acknowledge(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
    }

    /// The page said quit.
    pub fn exit(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
        self.host.exit();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    #[derive(Default)]
    struct Fake {
        emitted: AtomicUsize,
        exited: AtomicUsize,
    }

    impl QuitHost for Arc<Fake> {
        fn emit_quit_requested(&self) {
            self.emitted.fetch_add(1, Ordering::SeqCst);
        }
        fn exit(&self) {
            self.exited.fetch_add(1, Ordering::SeqCst);
        }
    }

    fn gate(timeout: Duration) -> (QuitGate<Arc<Fake>>, Arc<Fake>) {
        let fake = Arc::new(Fake::default());
        (QuitGate::new(Arc::clone(&fake), timeout), fake)
    }

    #[test]
    fn a_quit_request_emits_the_event_and_does_not_exit() {
        let (gate, fake) = gate(Duration::from_secs(60));
        gate.request();
        assert_eq!(fake.emitted.load(Ordering::SeqCst), 1);
        assert_eq!(fake.exited.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn the_exit_command_exits() {
        let (gate, fake) = gate(Duration::from_secs(60));
        gate.exit();
        assert_eq!(fake.exited.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn an_unanswered_request_quits_after_the_timeout() {
        let (gate, fake) = gate(Duration::from_millis(30));
        gate.request();
        std::thread::sleep(Duration::from_millis(200));
        assert_eq!(fake.exited.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn acknowledging_disarms_the_timeout() {
        let (gate, fake) = gate(Duration::from_millis(30));
        gate.request();
        gate.acknowledge();
        std::thread::sleep(Duration::from_millis(200));
        assert_eq!(fake.exited.load(Ordering::SeqCst), 0);
    }
}
