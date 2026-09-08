//! Clipboard provider seam the guest agent uses to reach the Android
//! `ClipboardManager` — mirroring the `MediaProvider`/`SensorProvider` pattern:
//! a deterministic [`MockClipboardProvider`] (headless-testable today) and, behind
//! `--features android`, the real [`crate::android::AndroidClipboardProvider`]
//! (compile-checked; needs a device + Context at runtime).
//!
//! The seam is deliberately tiny: read the primary text, replace it, and install a
//! change listener. All richer semantics (echo suppression, framing, the guest
//! agent) live on top so they can be tested without Android.

use std::sync::{Arc, Mutex};

/// A callback fired whenever the platform clipboard's primary text changes. The
/// argument is the new plain text.
pub type ChangeSink = Arc<dyn Fn(&str) + Send + Sync>;

/// The minimal platform surface a clipboard needs, abstracted so the guest agent
/// and host transport can be tested against [`MockClipboardProvider`].
pub trait ClipboardProvider: Send + Sync {
    /// A stable human/`log` name for diagnostics.
    fn name(&self) -> &'static str;
    /// The current primary clip's plain text, if any.
    fn primary_text(&self) -> Option<String>;
    /// Replace the primary clip with plain `text`. Errors must never panic.
    fn set_primary_text(&self, text: &str) -> Result<(), String>;
    /// Install (or clear, with `None`) the change listener. Best-effort: a provider
    /// that cannot observe external changes returns an error rather than lying.
    fn set_change_listener(&self, listener: Option<ChangeSink>) -> Result<(), String>;
}

/// Shared state behind [`MockClipboardProvider`].
#[derive(Default)]
struct MockInner {
    text: Option<String>,
    listener: Option<ChangeSink>,
    /// How many times [`MockClipboardProvider::set_primary_text`] actually changed
    /// the value (a same-value set is a no-op, like AOSP).
    set_calls: usize,
    /// True while a change listener is being dispatched synchronously. Guards
    /// against unbounded recursion if a listener re-enters `set_primary_text`
    /// (a real provider dispatches asynchronously, so it can never recurse inline).
    firing: bool,
}

/// A deterministic, in-memory [`ClipboardProvider`] for headless tests and demo
/// bring-up. Fires the change listener synchronously on a real change — so the
/// guest agent's echo suppression is exercised exactly as it would be on-device.
/// Dispatch is **bounded**: at most one synchronous change is dispatched per set;
/// a listener that re-enters `set_primary_text` updates the value but is not
/// dispatched again from inside the callback (mirroring a real, async provider).
#[derive(Clone, Default)]
pub struct MockClipboardProvider {
    inner: Arc<Mutex<MockInner>>,
}

impl MockClipboardProvider {
    /// A fresh, empty mock clipboard.
    pub fn new() -> Self {
        Self::default()
    }

    /// Read current text (test helper).
    pub fn text(&self) -> Option<String> {
        self.inner.lock().ok().and_then(|i| i.text.clone())
    }

    /// Number of real (value-changing) sets (test helper).
    pub fn set_calls(&self) -> usize {
        self.inner.lock().map(|i| i.set_calls).unwrap_or(0)
    }

    /// Whether a change listener is currently installed (test helper).
    pub fn has_listener(&self) -> bool {
        self.inner
            .lock()
            .map(|i| i.listener.is_some())
            .unwrap_or(false)
    }
}

impl ClipboardProvider for MockClipboardProvider {
    fn name(&self) -> &'static str {
        "mock-guest-clipboard"
    }

    fn primary_text(&self) -> Option<String> {
        self.text()
    }

    fn set_primary_text(&self, text: &str) -> Result<(), String> {
        let listener = {
            let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
            if inner.text.as_deref() == Some(text) {
                return Ok(()); // no change -> no event, matching AOSP
            }
            inner.text = Some(text.to_string());
            inner.set_calls += 1;
            if inner.firing {
                // Already dispatching a change up the stack: record the value but do
                // not nest another synchronous dispatch (bounded, like a real async
                // provider). The outermost dispatch resets `firing`.
                return Ok(());
            }
            inner.firing = true;
            inner.listener.clone()
        };
        // Fire outside the lock so a listener may safely re-enter the provider.
        if let Some(cb) = listener {
            cb(text);
        }
        // Always reset, even if there was no listener or a listener re-entered.
        if let Ok(mut inner) = self.inner.lock() {
            inner.firing = false;
        }
        Ok(())
    }

    fn set_change_listener(&self, listener: Option<ChangeSink>) -> Result<(), String> {
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        inner.listener = listener;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mock_starts_empty() {
        let m = MockClipboardProvider::new();
        assert_eq!(m.primary_text(), None);
        assert_eq!(m.set_calls(), 0);
    }

    #[test]
    fn mock_round_trips_text() {
        let m = MockClipboardProvider::new();
        m.set_primary_text("hello").unwrap();
        assert_eq!(m.primary_text().as_deref(), Some("hello"));
        assert_eq!(m.set_calls(), 1);
    }

    #[test]
    fn mock_same_value_set_is_a_no_op() {
        let m = MockClipboardProvider::new();
        m.set_primary_text("same").unwrap();
        m.set_primary_text("same").unwrap();
        assert_eq!(m.set_calls(), 1, "a same-value set must not re-fire");
    }

    #[test]
    fn mock_fires_listener_only_on_real_change() {
        let m = MockClipboardProvider::new();
        let seen: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let sink: ChangeSink = {
            let seen = seen.clone();
            Arc::new(move |text: &str| {
                seen.lock().unwrap().push(text.to_string());
            })
        };
        m.set_change_listener(Some(sink)).unwrap();
        assert!(m.has_listener());

        m.set_primary_text("one").unwrap();
        m.set_primary_text("one").unwrap(); // no-op
        m.set_primary_text("two").unwrap();
        assert_eq!(
            *seen.lock().unwrap(),
            vec!["one".to_string(), "two".to_string()]
        );
    }

    #[test]
    fn mock_listener_can_be_cleared() {
        let m = MockClipboardProvider::new();
        m.set_change_listener(Some(Arc::new(|_| {}))).unwrap();
        assert!(m.has_listener());
        m.set_change_listener(None).unwrap();
        assert!(!m.has_listener());
    }

    #[test]
    fn mock_reentrant_set_does_not_recursively_overflow() {
        let m = MockClipboardProvider::new();
        let calls = Arc::new(Mutex::new(0usize));
        let m2 = m.clone();
        let sink: ChangeSink = {
            let calls = calls.clone();
            Arc::new(move |_text: &str| {
                *calls.lock().unwrap() += 1;
                // On the first dispatch only, re-enter the provider with a new value.
                if *calls.lock().unwrap() == 1 {
                    let _ = m2.set_primary_text("nested");
                }
            })
        };
        m.set_change_listener(Some(sink)).unwrap();
        m.set_primary_text("outer").unwrap();
        // The nested set must NOT dispatch a second callback (no unbounded recursion);
        // it only records the value + count.
        assert_eq!(*calls.lock().unwrap(), 1, "one synchronous dispatch only");
        assert_eq!(
            m.text().as_deref(),
            Some("nested"),
            "nested set is recorded"
        );
        assert_eq!(m.set_calls(), 2, "both sets counted");
        // A later non-reentrant set dispatches normally again (firing was reset).
        m.set_primary_text("after").unwrap();
        assert_eq!(
            *calls.lock().unwrap(),
            2,
            "firing flag was reset after the outer set"
        );
        assert_eq!(m.text().as_deref(), Some("after"));
    }
}
