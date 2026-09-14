//! The in-process transport: a topic-keyed fan-out broker, plus the `Transport` seam.
//!
//! Everything above this module (typed publishers/subscribers, the node, the control
//! plane) is written against the [`Transport`] trait, so the same code runs on the
//! in-process [`Broker`] (the default: zero sockets, deterministic, fully unit-tested)
//! and on the Zenoh-backed transport (`src/zenoh.rs`, feature `zenoh`) that links the
//! robot board to the field server. That is the same "seam" discipline as
//! `amos-sensor`'s provider: a dumb, testable core with the real backend swapped in.
//!
//! Delivery model — one queue per subscriber, never one global queue, because a robot
//! link has consumers at wildly different speeds (a UI at 10 Hz, a recorder at 60 Hz,
//! a model at 200 Hz) and one slow reader must not stall the others:
//!
//! ```text
//!  publish(topic, frame) ──► match patterns ──┬──► subscriber A  [mpsc, best-effort, drop-newest]
//!                                             ├──► subscriber B  [slot, latest-wins]
//!                                             └──► subscriber C  [mpsc, reliable, back-pressure]
//! ```
//!
//! The publish path takes the registry lock only to *clone* the matching sinks, then
//! releases it before any `await`, so a reliable subscriber can never block an
//! unrelated topic's publish (the lock-across-await rule this workspace gates on).

use std::collections::BTreeSet;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex, Weak};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, Mutex, Notify};

use crate::error::{LinkError, Result};
use crate::keyexpr::Topic;
use crate::metrics::LinkMetrics;
use crate::qos::{Qos, Reliability};

/// One delivered frame as a subscriber sees it: the routing key + the raw bytes.
///
/// The bytes are an `Arc<[u8]>`, so a fan-out to *n* subscribers copies a pointer, not
/// a 1 MB depth frame — the difference between a middleware that scales to a stereo
/// pair at 60 Hz and one that does not.
#[derive(Clone, Debug)]
pub struct Ingress {
    /// The concrete topic the frame was published on (the routing key).
    pub topic: Topic,
    /// The encoded [`Envelope`](crate::codec::Envelope).
    pub frame: Arc<[u8]>,
}

/// What one publish did, as far as the transport can know.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PublishReport {
    /// Subscribers whose pattern matched; `None` when the transport cannot know
    /// (a network bus like Zenoh only knows its local fan-out).
    pub matched: Option<usize>,
    /// Frames accepted into a subscriber queue (or put on the wire).
    pub delivered: usize,
    /// Frames a best-effort QoS policy dropped.
    pub dropped: usize,
    /// Subscribers this publish had to **wait** for (a `Reliable` queue that was full).
    /// Zero on a healthy link; non-zero means a consumer is slower than this publisher,
    /// which is a fact about the link, not an error.
    pub blocked: usize,
}

/// Per-subscription counters, shared between the broker and the subscriber handle.
#[derive(Debug, Default)]
pub(crate) struct SubCounters {
    received: AtomicU64,
    dropped: AtomicU64,
    decode_errors: AtomicU64,
}

impl SubCounters {
    fn record_received(&self) {
        self.received.fetch_add(1, Ordering::Relaxed);
    }

    fn record_dropped(&self) {
        self.dropped.fetch_add(1, Ordering::Relaxed);
    }

    fn record_decode_error(&self) {
        self.decode_errors.fetch_add(1, Ordering::Relaxed);
    }

    /// A point-in-time reading.
    pub(crate) fn snapshot(&self) -> SubscriptionStats {
        SubscriptionStats {
            received: self.received.load(Ordering::Relaxed),
            dropped: self.dropped.load(Ordering::Relaxed),
            decode_errors: self.decode_errors.load(Ordering::Relaxed),
        }
    }
}

/// The live counters of one subscription: what it got, what it lost, what it could
/// not parse. A subscriber that reports `dropped > 0` is *working* (best-effort
/// policy doing its job); one that reports `decode_errors > 0` is a version skew.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SubscriptionStats {
    /// Frames handed to the consumer.
    pub received: u64,
    /// Frames dropped by this subscription's QoS policy.
    pub dropped: u64,
    /// Frames that arrived but could not be decoded.
    pub decode_errors: u64,
}

/// The transport seam: a byte-level, topic-addressed pub/sub bus.
#[async_trait]
pub trait Transport: Send + Sync + 'static {
    /// Hand an encoded frame to every matching subscriber.
    async fn publish(&self, topic: &Topic, frame: Arc<[u8]>) -> Result<PublishReport>;

    /// Register a subscription for a pattern; the QoS is validated here.
    async fn subscribe(&self, pattern: &Topic, qos: Qos) -> Result<Subscription>;

    /// Concrete topics the transport has seen *published* traffic on.
    ///
    /// A subscription contributes nothing: a pattern is not a topic, and the honest
    /// inventory of a bus is what was actually addressed. A network transport that cannot
    /// enumerate what other nodes publish answers empty (`PublishReport::matched` is then
    /// `None` too) rather than inventing a list.
    async fn topics(&self) -> Vec<String>;

    /// True when [`Transport::topics`] is the whole truth.
    ///
    /// A diagnostic list has to be honest about its own limits: the in-process broker
    /// answers `false` once it has hit [`MAX_TRACKED_TOPICS`] distinct topics (it stops
    /// growing rather than exhausting memory), and a network transport always answers
    /// `false` (it cannot enumerate what other nodes publish at all). A caller that
    /// presents the inventory must present this caveat with it.
    async fn topics_complete(&self) -> bool;

    /// Which implementation this is (`"broker"`, `"zenoh"`).
    fn name(&self) -> &'static str;
}

/// The largest topic inventory an in-process broker keeps.
///
/// A resource with a **static bound** (NASA Power of 10 #2): a robot addresses a fixed set
/// of topics, but a misbehaving or hostile publisher inside the process could otherwise
/// add a distinct topic name forever, growing this set for the lifetime of the node. Past
/// the ceiling the inventory stops growing and reports itself as incomplete — a *publish*
/// is never refused for a bookkeeping limit.
pub const MAX_TRACKED_TOPICS: usize = 4096;

/// A one-slot "latest sample wins" queue — the shape a sensor stream wants.
///
/// `offer` always succeeds by overwriting (counting the replaced frame as dropped),
/// `offer_blocking` waits for the consumer instead (the reliable variant), and `take`
/// is the consumer side. Two [`Notify`]s keep the two directions independent, so a
/// producer never spins and a consumer never misses a wake-up.
#[derive(Debug)]
struct LatestSlot {
    slot: StdMutex<Option<Ingress>>,
    /// Signalled when a frame becomes available.
    filled: Notify,
    /// Signalled when the consumer freed the slot.
    taken: Notify,
    closed: AtomicBool,
    counters: Arc<SubCounters>,
}

impl LatestSlot {
    fn new(counters: Arc<SubCounters>) -> Arc<Self> {
        Arc::new(Self {
            slot: StdMutex::new(None),
            filled: Notify::new(),
            taken: Notify::new(),
            closed: AtomicBool::new(false),
            counters,
        })
    }

    /// Move the frame in if the slot is empty; returns it back when it is occupied.
    /// (A plain sync helper — so no lock guard ever lives across an `await`.)
    ///
    /// A **poisoned** lock (someone panicked while a frame was being stored) is neither
    /// "stored" nor "occupied": the slot can never hand a frame to its consumer again, so
    /// it is reported as such. Reporting it as "occupied" — which is what this helper used
    /// to do — made `offer_blocking` wait for a `taken` notification that can never come,
    /// i.e. an **unbounded** wait inside a reliable control publish. A degraded slot must
    /// end the operation, not stall it (NASA Power of 10 #2: prove every loop ends).
    fn try_put(&self, ingress: Ingress) -> Result<Option<Ingress>> {
        match self.slot.lock() {
            Ok(mut g) if g.is_none() => {
                *g = Some(ingress);
                Ok(None)
            }
            // Occupied: hand the frame back so the caller can apply its policy.
            Ok(_) => Ok(Some(ingress)),
            Err(_) => Err(LinkError::Closed(
                "latest slot is poisoned: this consumer can no longer take frames".to_string(),
            )),
        }
    }

    /// Take the pending frame, freeing the slot.
    fn take(&self) -> Option<Ingress> {
        let out = self.slot.lock().ok().and_then(|mut g| g.take());
        if out.is_some() {
            self.taken.notify_waiters();
        }
        out
    }

    /// Best-effort store: overwrite whatever is pending (it is stale by definition).
    ///
    /// `false` means "this frame reached nobody": the slot was already occupied by a newer
    /// frame, or its lock is poisoned. Either way the caller counts a drop — a poisoned
    /// slot must not be reported as a delivery (see [`LatestSlot::try_put`]).
    fn offer(&self, ingress: Ingress) -> bool {
        let replaced = match self.slot.lock() {
            Ok(mut g) => {
                let replaced = g.is_some();
                *g = Some(ingress);
                replaced
            }
            Err(_) => true,
        };
        if replaced {
            self.counters.record_dropped();
        }
        self.filled.notify_waiters();
        !replaced
    }

    /// Reliable store: wait until the consumer took the previous frame.
    ///
    /// Returns `true` when it had to wait at least once (i.e. this publish was
    /// back-pressured), so the caller — which owns the counters — can record it.
    ///
    /// Bounded by construction: it waits only while the slot is provably alive. A closed
    /// slot (the consumer dropped, or the lock is poisoned) ends the call with a typed
    /// error instead of a wait nothing can end.
    async fn offer_blocking(&self, ingress: Ingress) -> Result<bool> {
        let mut pending = Some(ingress);
        let mut waited = false;
        // Terminates when the slot is free (stored), or when it cannot ever be (closed).
        loop {
            if self.is_closed() {
                return Err(LinkError::Closed(
                    "subscriber dropped while publishing".to_string(),
                ));
            }
            match pending.take() {
                Some(ing) => match self.try_put(ing)? {
                    None => {
                        self.filled.notify_waiters();
                        return Ok(waited);
                    }
                    Some(back) => {
                        waited = true;
                        pending = Some(back);
                    }
                },
                None => {
                    return Err(LinkError::Closed("publish aborted".to_string()));
                }
            }
            self.taken.notified().await;
        }
    }

    async fn recv(&self) -> Option<Ingress> {
        // Terminates when a frame is available, or with `None` after `close()` — and also
        // when the lock is poisoned, which is a closed consumer by definition (waiting for
        // a frame a poisoned slot can never produce would spin on every notify).
        loop {
            if let Some(ing) = self.take() {
                self.counters.record_received();
                return Some(ing);
            }
            if self.is_closed() {
                return None;
            }
            self.filled.notified().await;
        }
    }

    fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        self.filled.notify_waiters();
        self.taken.notify_waiters();
    }

    fn is_closed(&self) -> bool {
        // A poisoned lock is a closed consumer: it can never hand a frame over again, so
        // both the publisher's wait (`offer_blocking`) and the consumer's loop (`recv`)
        // must end here instead of waiting for a notification nothing can send.
        self.closed.load(Ordering::SeqCst) || self.slot.is_poisoned()
    }

    fn has_pending(&self) -> bool {
        self.slot.lock().map(|g| g.is_some()).unwrap_or(false)
    }
}

/// A live subscription: the consumer end of one registered pattern.
///
/// Dropping it unregisters (best-effort: the next publish prunes the sink anyway) and
/// closes a latest-slot, which is what unblocks a `Reliable` publisher waiting on it.
#[derive(Debug)]
pub struct Subscription {
    id: u64,
    pattern: Topic,
    qos: Qos,
    rx: Option<mpsc::Receiver<Ingress>>,
    slot: Option<Arc<LatestSlot>>,
    counters: Arc<SubCounters>,
    registry: Option<Weak<Mutex<BrokerInner>>>,
}

impl Subscription {
    /// The registration id (unique per broker).
    pub fn id(&self) -> u64 {
        self.id
    }

    /// The pattern this subscription registered.
    pub fn pattern(&self) -> &Topic {
        &self.pattern
    }

    /// The QoS contract in force.
    pub fn qos(&self) -> Qos {
        self.qos
    }

    /// Wait for the next matching frame; `None` once the subscription is closed.
    pub async fn recv(&mut self) -> Option<Ingress> {
        if let Some(slot) = &self.slot {
            return slot.recv().await;
        }
        let ing = self.rx.as_mut()?.recv().await?;
        self.counters.record_received();
        Some(ing)
    }

    /// The next matching frame if one is already queued (the "poll without awaiting"
    /// path a control loop uses: never block the gait on the network).
    pub fn try_recv(&mut self) -> Option<Ingress> {
        let ing = match (&self.slot, self.rx.as_mut()) {
            (Some(slot), _) => slot.take(),
            (None, Some(rx)) => rx.try_recv().ok(),
            (None, None) => None,
        };
        if ing.is_some() {
            self.counters.record_received();
        }
        ing
    }

    /// The live counters of this subscription.
    pub fn stats(&self) -> SubscriptionStats {
        self.counters.snapshot()
    }

    /// True once the producer side is gone / the subscription was closed.
    pub fn is_closed(&self) -> bool {
        match (&self.slot, &self.rx) {
            (Some(slot), _) => slot.is_closed(),
            (None, Some(rx)) => rx.is_closed(),
            (None, None) => true,
        }
    }

    /// True when a frame is waiting to be consumed right now.
    ///
    /// Both queue shapes answer truthfully: the one-slot “latest wins” sink reports
    /// whether its slot is occupied, and a **buffered** sink (`depth > 1`) reports
    /// whether its channel holds anything — a control loop that polls before deciding
    /// to sleep must not be told “nothing is queued” while frames are waiting.
    pub fn has_pending(&self) -> bool {
        match (&self.slot, &self.rx) {
            (Some(slot), _) => slot.has_pending(),
            // `len()` is exact for `mpsc` and non-blocking; nothing is consumed.
            (None, Some(rx)) => !rx.is_empty(),
            (None, None) => false,
        }
    }

    /// Record that a received frame failed to decode into the subscriber's type.
    pub(crate) fn record_decode_error(&self) {
        self.counters.record_decode_error();
    }

    /// Build a subscription for a *remote* transport (Zenoh), whose frames arrive on
    /// a channel fed by a forwarding task instead of by the broker directly.
    #[cfg(feature = "zenoh")]
    pub(crate) fn remote(
        pattern: Topic,
        qos: Qos,
        rx: mpsc::Receiver<Ingress>,
        counters: Arc<SubCounters>,
    ) -> Self {
        Self {
            id: 0,
            pattern,
            qos,
            rx: Some(rx),
            slot: None,
            counters,
            registry: None,
        }
    }

    /// The per-subscription counters handle a transport wraps into its subscription.
    pub(crate) fn counters() -> Arc<SubCounters> {
        Arc::new(SubCounters::default())
    }
}

impl Drop for Subscription {
    fn drop(&mut self) {
        if let Some(slot) = &self.slot {
            // Unblocks a reliable publisher waiting for room.
            slot.close();
        }
        if let Some(weak) = &self.registry {
            if let Some(inner) = weak.upgrade() {
                // `try_lock` (not `lock`) because `Drop` cannot await; if the broker is
                // mid-publish the entry is pruned by the next publish's liveness sweep.
                if let Ok(mut guard) = inner.try_lock() {
                    guard.subs.retain(|e| e.id != self.id);
                }
            }
        }
    }
}

/// One registered subscription inside the broker.
#[derive(Debug)]
struct Entry {
    id: u64,
    pattern: Topic,
    qos: Qos,
    sink: Sink,
    counters: Arc<SubCounters>,
}

/// Where a subscriber's frames go.
#[derive(Debug)]
enum Sink {
    /// Buffered (`depth > 1`): best-effort drops the newest when full, reliable waits.
    Buffer(mpsc::Sender<Ingress>),
    /// One slot: the newest frame always wins (a sensor stream).
    Latest(Arc<LatestSlot>),
}

impl Entry {
    /// True when the consumer is gone (a dropped `Subscription` or a closed channel).
    fn is_closed(&self) -> bool {
        match &self.sink {
            Sink::Buffer(tx) => tx.is_closed(),
            Sink::Latest(slot) => slot.is_closed(),
        }
    }
}

/// The broker's shared state: the registrations and the topic inventory.
#[derive(Debug, Default)]
struct BrokerInner {
    subs: Vec<Entry>,
    topics: BTreeSet<String>,
    /// True once [`MAX_TRACKED_TOPICS`] distinct topics have been seen: the inventory is
    /// then **incomplete** (and says so through `topics_complete`), because a diagnostic
    /// must never grow without a bound just because a publisher keeps inventing names.
    topics_capped: bool,
}

/// The in-process transport: topic-keyed fan-out with per-subscriber queues.
///
/// Cheap to share (`Arc`), and the only transport that can answer
/// `PublishReport::matched` and [`Transport::topics`] — it owns the subscriber table.
#[derive(Debug)]
pub struct Broker {
    inner: Arc<Mutex<BrokerInner>>,
    metrics: Arc<LinkMetrics>,
    next_id: AtomicU64,
}

impl Broker {
    /// A broker reporting into a fresh counter set.
    pub fn new() -> Self {
        Self::with_metrics(Arc::new(LinkMetrics::new()))
    }

    /// A broker reporting into shared counters (so `LinkNode` and the broker agree).
    pub fn with_metrics(metrics: Arc<LinkMetrics>) -> Self {
        Self {
            inner: Arc::new(Mutex::new(BrokerInner::default())),
            metrics,
            next_id: AtomicU64::new(1),
        }
    }

    /// Share this broker as a [`Transport`] (the handle a [`LinkNode`] holds).
    ///
    /// [`LinkNode`]: crate::node::LinkNode
    pub fn shared(self) -> Arc<dyn Transport> {
        Arc::new(self)
    }

    /// The counters this broker writes into.
    pub fn metrics(&self) -> &Arc<LinkMetrics> {
        &self.metrics
    }

    /// How many subscriptions are registered right now.
    ///
    /// The count is of **live** registrations: a dropped subscriber whose entry survived
    /// (`Drop` removes it with `try_lock`, which cannot run while a publish holds the
    /// registry) is swept here rather than counted as if it were still listening — the
    /// same liveness sweep `publish` does, so the number never flatters the link.
    pub async fn subscriber_count(&self) -> usize {
        let mut inner = self.inner.lock().await;
        inner.subs.retain(|e| !e.is_closed());
        inner.subs.len()
    }
}

impl Default for Broker {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Transport for Broker {
    /// Fan a frame out to every matching subscription.
    ///
    /// The registry lock is held only long enough to *select and clone* the matching sinks;
    /// the actual delivery happens after it is released, so a reliable subscriber that is
    /// back-pressuring cannot stall an unrelated topic. The work inside the lock is
    /// **bounded**: `Topic::matches` is an `O(n·m) ≤ 32·32` dynamic program (no recursion,
    /// no backtracking — see `keyexpr`), so a wildcard-heavy pattern cannot hold the broker
    /// while it explores combinations.
    async fn publish(&self, topic: &Topic, frame: Arc<[u8]>) -> Result<PublishReport> {
        let mut buffered: Vec<(mpsc::Sender<Ingress>, Ingress, bool, Arc<SubCounters>)> =
            Vec::new();
        let mut latest: Vec<(Arc<LatestSlot>, bool)> = Vec::new();
        let ingress = Ingress {
            topic: topic.clone(),
            frame,
        };

        let matched = {
            let mut inner = self.inner.lock().await;
            // A bounded inventory: the set is a diagnostic, never a reason to fail a
            // publish — past the ceiling it stops growing and *says* it is incomplete.
            if !inner.topics.contains(topic.as_str()) {
                if inner.topics.len() < MAX_TRACKED_TOPICS {
                    inner.topics.insert(topic.as_str().to_string());
                } else if !inner.topics_capped {
                    inner.topics_capped = true;
                    tracing::warn!(
                        ceiling = MAX_TRACKED_TOPICS,
                        "topic inventory is full: further distinct topics are not tracked \
                         (the inventory reports itself incomplete)"
                    );
                }
            }
            // Drop the registrations whose consumer went away without unregistering.
            inner.subs.retain(|e| !e.is_closed());
            let mut matched = 0usize;
            for entry in inner.subs.iter() {
                if !topic.matches(&entry.pattern) {
                    continue;
                }
                matched += 1;
                let reliable = entry.qos.reliability == Reliability::Reliable;
                match &entry.sink {
                    Sink::Latest(slot) => latest.push((Arc::clone(slot), reliable)),
                    Sink::Buffer(tx) => {
                        buffered.push((
                            tx.clone(),
                            ingress.clone(),
                            reliable,
                            Arc::clone(&entry.counters),
                        ));
                    }
                }
            }
            matched
        };

        let mut delivered = 0usize;
        let mut dropped = 0usize;
        // Publishes that had to wait for a `Reliable` subscriber (see
        // [`LinkMetrics::record_blocked`]): the honest cost of back-pressure.
        let mut blocked = 0usize;

        for (slot, reliable) in latest {
            if reliable {
                // Applies the publisher's own back-pressure: a slow consumer of a
                // one-slot control stream throttles the producer instead of losing it.
                // The slot reports whether it had to wait, so the *broker* (which owns
                // the counters) can record the throttle — the slot stays dumb.
                match slot.offer_blocking(ingress.clone()).await {
                    Ok(waited) => {
                        delivered += 1;
                        if waited {
                            blocked += 1;
                        }
                    }
                    // Racy path: the subscriber closed between the broker's liveness sweep
                    // and this wait. The frame reached nobody, so it is a drop — reporting
                    // neither delivered nor dropped would leave an operator with a 0/0
                    // report for a lost frame.
                    Err(_) => dropped += 1,
                }
            } else if slot.offer(ingress.clone()) {
                delivered += 1;
            } else {
                dropped += 1;
            }
        }

        for (tx, ing, reliable, counters) in buffered {
            if reliable {
                // Try first, then wait: an immediate accept is not back-pressure, and
                // counting it as such would make the counter useless. `try_send` is the
                // only way to tell the two apart without measuring time.
                match tx.try_send(ing) {
                    Ok(()) => delivered += 1,
                    Err(mpsc::error::TrySendError::Full(ing)) => {
                        blocked += 1;
                        match tx.send(ing).await {
                            Ok(()) => delivered += 1,
                            Err(_) => {
                                dropped += 1;
                                counters.record_dropped();
                            }
                        }
                    }
                    Err(mpsc::error::TrySendError::Closed(_)) => {
                        dropped += 1;
                        counters.record_dropped();
                    }
                }
            } else {
                match tx.try_send(ing) {
                    Ok(()) => delivered += 1,
                    // A full (or closed) best-effort queue *is* the policy working: the
                    // drop is counted on both the publish report and the subscription,
                    // so `sub.stats().dropped` explains where the frames went.
                    Err(mpsc::error::TrySendError::Full(_)) => {
                        dropped += 1;
                        counters.record_dropped();
                    }
                    Err(mpsc::error::TrySendError::Closed(_)) => {
                        dropped += 1;
                        counters.record_dropped();
                    }
                }
            }
        }

        self.metrics.record_published(1);
        self.metrics.record_delivered(delivered as u64);
        self.metrics.record_dropped(dropped as u64);
        self.metrics.record_blocked(blocked as u64);
        Ok(PublishReport {
            matched: Some(matched),
            delivered,
            dropped,
            blocked,
        })
    }

    async fn subscribe(&self, pattern: &Topic, qos: Qos) -> Result<Subscription> {
        qos.validate()?;
        let counters = Subscription::counters();
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (sink, rx, slot) = if qos.is_latest_only() {
            let slot = LatestSlot::new(Arc::clone(&counters));
            (Sink::Latest(Arc::clone(&slot)), None, Some(slot))
        } else {
            let (tx, rx) = mpsc::channel(qos.depth());
            (Sink::Buffer(tx), Some(rx), None)
        };
        self.inner.lock().await.subs.push(Entry {
            id,
            pattern: pattern.clone(),
            qos,
            sink,
            counters: Arc::clone(&counters),
        });
        Ok(Subscription {
            id,
            pattern: pattern.clone(),
            qos,
            rx,
            slot,
            counters,
            registry: Some(Arc::downgrade(&self.inner)),
        })
    }

    async fn topics(&self) -> Vec<String> {
        self.inner.lock().await.topics.iter().cloned().collect()
    }

    async fn topics_complete(&self) -> bool {
        !self.inner.lock().await.topics_capped
    }

    fn name(&self) -> &'static str {
        "broker"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn topic(s: &str) -> Topic {
        Topic::new(s).expect("topic")
    }

    fn pattern(s: &str) -> Topic {
        Topic::pattern(s).expect("pattern")
    }

    fn frame(tag: u8) -> Arc<[u8]> {
        Arc::from(vec![tag].into_boxed_slice())
    }

    #[tokio::test]
    async fn broker_fans_out_to_matching_patterns_only() {
        let broker = Broker::new();
        let exact = broker
            .subscribe(&topic("amos/dog1/sensor/imu"), Qos::state())
            .await
            .expect("subscribe");
        let wild = broker
            .subscribe(&pattern("amos/*/sensor/*"), Qos::state())
            .await
            .expect("subscribe");
        let other = broker
            .subscribe(&pattern("amos/dog1/control/**"), Qos::state())
            .await
            .expect("subscribe");

        assert_eq!(broker.subscriber_count().await, 3);
        let report = broker
            .publish(&topic("amos/dog1/sensor/imu"), frame(1))
            .await
            .expect("publish");
        assert_eq!(
            report.matched,
            Some(2),
            "exact + wildcard match, control does not"
        );
        assert_eq!(report.delivered, 2);
        assert_eq!(report.dropped, 0);

        // The topic inventory is what the control plane lists.
        assert_eq!(
            broker.topics().await,
            vec!["amos/dog1/sensor/imu".to_string()]
        );
        assert_eq!(broker.name(), "broker");

        // A publish with no subscriber is legal and reported as such.
        let none = broker
            .publish(&topic("amos/dog2/state/mode"), frame(2))
            .await
            .expect("publish");
        assert_eq!(none.matched, Some(0));
        assert_eq!(none.delivered, 0);

        let _ = (exact, wild, other, broker.metrics().snapshot());
    }

    /// Poison a latest slot exactly the way a panic while storing a frame would: hold the
    /// lock and unwind. (`Mutex` poisoning is sticky, so this reproduces the state.)
    fn poison(slot: &LatestSlot) {
        let unwound = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = slot.slot.lock().expect("lock");
            panic!("a panic while a frame was being stored");
        }));
        assert!(unwound.is_err(), "the helper must really unwind");
        assert!(slot.slot.is_poisoned(), "…and leave the lock poisoned");
    }

    /// One frame addressed to a concrete topic (what a publish hands to a sink).
    fn ingress(key: &str) -> Ingress {
        Ingress {
            topic: topic(key),
            frame: frame(1),
        }
    }

    #[tokio::test]
    async fn a_poisoned_reliable_slot_refuses_instead_of_waiting_for_a_notification_nothing_can_send(
    ) {
        // The defect this pins: `try_put` reported "occupied" for a poisoned lock, so
        // `offer_blocking` waited on a `taken` notification that could never arrive — an
        // **unbounded** wait inside a reliable control publish. A degraded consumer must
        // end the operation with a typed refusal instead.
        let slot = LatestSlot::new(Subscription::counters());
        poison(&slot);

        let err = tokio::time::timeout(
            Duration::from_millis(500),
            slot.offer_blocking(ingress("amos/dog1/control/joints")),
        )
        .await
        .expect("the publish must return, not wait forever")
        .expect_err("a poisoned slot must refuse the frame");
        assert!(matches!(err, LinkError::Closed(_)), "got: {err:?}");

        // The consumer side ends too: `recv` must not spin on notifications that can never
        // become a frame.
        assert!(
            tokio::time::timeout(Duration::from_millis(500), slot.recv())
                .await
                .expect("recv must not spin on a poisoned slot")
                .is_none(),
            "a poisoned slot is a closed consumer"
        );
    }

    #[tokio::test]
    async fn a_poisoned_sensor_slot_is_a_dead_consumer_not_a_silent_delivery() {
        // Best-effort path: no wait to get stuck in, but the store must not claim success.
        let broker = Broker::new();
        let sub = broker
            .subscribe(&pattern("amos/**"), Qos::sensor())
            .await
            .expect("subscribe");
        let slot = Arc::clone(sub.slot.as_ref().expect("a latest slot"));
        poison(&slot);
        assert!(!slot.offer(ingress("amos/dog1/sensor/imu")), "not stored");
        assert_eq!(
            sub.stats().dropped,
            1,
            "the subscription says where the frame went"
        );

        // Through the broker a poisoned slot is a **dead consumer**: the liveness sweep
        // removes it, so the publish neither delivers nor *claims* a subscriber — the same
        // honest answer the cancelled-subscription test below pins, because a slot that can
        // never hand a frame over is not listening.
        let report = broker
            .publish(&topic("amos/dog1/sensor/imu"), frame(9))
            .await
            .expect("publish");
        assert_eq!(report.matched, Some(0));
        assert_eq!(report.delivered, 0);
        assert_eq!(broker.subscriber_count().await, 0);
        assert_eq!(broker.metrics().snapshot().published, 1);
    }

    #[tokio::test]
    async fn a_cancelled_subscription_is_pruned_and_counted_in_the_metrics() {
        let broker = Broker::new();
        let sub = broker
            .subscribe(&pattern("amos/**"), Qos::state())
            .await
            .expect("subscribe");
        drop(sub);
        // The registry sweep drops the dead entry, so no phantom match is reported.
        let report = broker
            .publish(&topic("amos/dog1/state/mode"), frame(1))
            .await
            .expect("publish");
        assert_eq!(report.matched, Some(0));
        assert_eq!(broker.subscriber_count().await, 0);
        assert_eq!(broker.metrics().snapshot().published, 1);
    }

    #[tokio::test]
    async fn best_effort_drops_the_newest_frame_when_the_queue_is_full() {
        let broker = Broker::new();
        let mut sub = broker
            .subscribe(
                &pattern("amos/**"),
                Qos::new(
                    Reliability::BestEffort,
                    2,
                    crate::qos::DropPolicy::DropNewest,
                ),
            )
            .await
            .expect("subscribe");
        for tag in 1..=3u8 {
            broker
                .publish(&topic("amos/dog1/sensor/imu"), frame(tag))
                .await
                .expect("publish");
        }
        // Queue holds the first two; the third was dropped, never blocking.
        assert_eq!(sub.try_recv().expect("frame 1").frame[0], 1);
        assert_eq!(sub.try_recv().expect("frame 2").frame[0], 2);
        assert!(sub.try_recv().is_none());
        let stats = sub.stats();
        assert_eq!(stats.received, 2);
        assert_eq!(stats.dropped, 1);
        assert_eq!(sub.pattern().as_str(), "amos/**");
        assert_eq!(sub.qos().reliability, Reliability::BestEffort);
        assert!(sub.id() > 0);
    }

    #[tokio::test]
    async fn latest_only_keeps_the_newest_frame_and_counts_the_overwritten_ones() {
        let broker = Broker::new();
        let mut sub = broker
            .subscribe(&pattern("amos/**"), Qos::sensor())
            .await
            .expect("subscribe");
        assert!(sub.qos().is_latest_only());
        for tag in 1..=5u8 {
            broker
                .publish(&topic("amos/dog1/sensor/stereo_left"), frame(tag))
                .await
                .expect("publish");
        }
        // Five frames in, one consumer wake-up: it sees frame 5, not a backlog.
        let got = sub.recv().await.expect("frame");
        assert_eq!(got.frame[0], 5);
        assert_eq!(got.topic.as_str(), "amos/dog1/sensor/stereo_left");
        assert_eq!(sub.stats().dropped, 4);
        assert!(!sub.has_pending());

        // `recv` waits for the next frame instead of spinning.
        let waiter = tokio::spawn(async move {
            let ing = sub.recv().await.expect("frame");
            ing.frame[0]
        });
        tokio::task::yield_now().await;
        broker
            .publish(&topic("amos/dog1/sensor/stereo_left"), frame(9))
            .await
            .expect("publish");
        let seen = tokio::time::timeout(Duration::from_secs(1), waiter)
            .await
            .expect("delivered")
            .expect("join");
        assert_eq!(seen, 9);
    }

    #[tokio::test]
    async fn has_pending_reports_buffered_frames_too() {
        // The one-slot sink used to be the only shape that answered this correctly: a
        // buffered queue (`depth > 1`) returned `false` even with frames waiting, so a
        // poll-before-sleep control loop would have slept through its own backlog.
        let broker = Broker::new();
        let mut sub = broker
            .subscribe(&pattern("amos/**"), Qos::state())
            .await
            .expect("subscribe");
        assert!(!sub.qos().is_latest_only(), "this is the buffered shape");
        assert!(!sub.has_pending(), "nothing published yet");

        broker
            .publish(&topic("amos/dog1/state/mode"), frame(1))
            .await
            .expect("publish");
        assert!(sub.has_pending(), "a queued frame is reported");
        assert_eq!(sub.try_recv().expect("frame").frame[0], 1);
        assert!(!sub.has_pending(), "draining clears the report");

        // A reliable buffer uses the same sink shape and must answer identically.
        let mut control = broker
            .subscribe(
                &pattern("amos/dog1/control/**"),
                Qos::new(Reliability::Reliable, 2, crate::qos::DropPolicy::DropNewest),
            )
            .await
            .expect("subscribe");
        broker
            .publish(&topic("amos/dog1/control/joints"), frame(7))
            .await
            .expect("publish");
        assert!(control.has_pending());
        assert_eq!(control.try_recv().expect("frame").frame[0], 7);
        assert!(!control.has_pending());
    }

    #[tokio::test]
    async fn reliable_delivery_back_pressures_the_publisher() {
        let broker = Broker::new();
        let mut sub = broker
            .subscribe(
                &pattern("amos/**"),
                Qos::new(Reliability::Reliable, 1, crate::qos::DropPolicy::DropNewest),
            )
            .await
            .expect("subscribe");
        // The first frame fills the single slot (an immediate accept — not back-pressure).
        let first = broker
            .publish(&topic("amos/dog1/control/joints"), frame(1))
            .await
            .expect("publish");
        assert_eq!(first.delivered, 1);
        assert_eq!(first.blocked, 0, "an immediate accept is not back-pressure");

        // ...so the second publish cannot complete until the consumer takes it.
        let publisher = {
            let broker_frame = frame(2);
            let t = topic("amos/dog1/control/joints");
            let inner = broker.inner.clone();
            tokio::spawn(async move {
                let broker = Broker {
                    inner,
                    metrics: Arc::new(LinkMetrics::new()),
                    next_id: AtomicU64::new(1),
                };
                broker.publish(&t, broker_frame).await
            })
        };
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(
            !publisher.is_finished(),
            "reliable publish is back-pressured"
        );

        assert_eq!(sub.try_recv().expect("frame 1").frame[0], 1);
        let report = tokio::time::timeout(Duration::from_secs(1), publisher)
            .await
            .expect("unblocked once the consumer made room")
            .expect("join")
            .expect("publish");
        assert_eq!(report.delivered, 1, "it landed once the queue made room");
        assert_eq!(
            report.blocked, 1,
            "the wait is reported as back-pressure, not hidden"
        );
        assert_eq!(
            sub.stats().received,
            1,
            "the subscription saw exactly the frames it consumed"
        );
    }

    #[tokio::test]
    async fn back_pressure_is_counted_for_the_one_slot_reliable_queue_too() {
        // The other `Reliable` shape: a one-slot "coalescing but never-dropping" queue.
        // Both shapes must report the throttle the same way, or the counter lies about
        // half the control streams.
        let metrics = Arc::new(LinkMetrics::new());
        let broker = Broker::with_metrics(Arc::clone(&metrics));
        let mut sub = broker
            .subscribe(
                &pattern("amos/**"),
                Qos::new(Reliability::Reliable, 1, crate::qos::DropPolicy::DropOldest),
            )
            .await
            .expect("subscribe");
        assert!(sub.qos().is_latest_only());

        let first = broker
            .publish(&topic("amos/dog1/control/joints"), frame(1))
            .await
            .expect("publish");
        assert_eq!((first.delivered, first.blocked), (1, 0));

        // The slot is occupied, so this publish waits for the consumer.
        let publisher = {
            let broker = Broker {
                inner: broker.inner.clone(),
                metrics: Arc::clone(&metrics),
                next_id: AtomicU64::new(1),
            };
            let t = topic("amos/dog1/control/joints");
            tokio::spawn(async move { broker.publish(&t, frame(2)).await })
        };
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(!publisher.is_finished(), "the slot is still occupied");
        assert_eq!(sub.try_recv().expect("frame 1").frame[0], 1);
        let report = tokio::time::timeout(Duration::from_secs(1), publisher)
            .await
            .expect("unblocked")
            .expect("join")
            .expect("publish");
        assert_eq!(report.delivered, 1);
        assert_eq!(report.blocked, 1, "the wait is reported");

        // …and the node-wide counter carries the same fact (it is what an operator reads).
        assert_eq!(metrics.snapshot().blocked, 1);
    }

    #[tokio::test]
    async fn a_closed_slot_refuses_a_reliable_publish_instead_of_hanging() {
        // The contract behind the broker's `Err(_) => dropped` mapping: once the
        // subscriber is gone, a reliable one-slot publish returns at once instead of
        // waiting forever. Inside `publish` this is a *race* (the subscriber can close
        // between the liveness sweep and the wait), so it is pinned here, on the slot —
        // deterministically, without pretending to control the scheduler.
        let counters = Subscription::counters();
        let slot = LatestSlot::new(Arc::clone(&counters));
        slot.close();
        let err = slot
            .offer_blocking(Ingress {
                topic: topic("amos/dog1/control/joints"),
                frame: frame(1),
            })
            .await
            .expect_err("a closed slot refuses");
        assert!(matches!(err, LinkError::Closed(_)), "got: {err:?}");
        assert!(!slot.has_pending(), "and it stored nothing");
        assert_eq!(
            counters.snapshot().received,
            0,
            "nothing was handed to the consumer"
        );
    }

    #[tokio::test]
    async fn subscriber_count_never_counts_a_dead_registration() {
        // `Drop for Subscription` removes its entry with `try_lock` (it cannot await), so a
        // drop that races a publish leaves the entry behind. The count must still be the
        // truth — a diagnostic that flatters the link is worse than none.
        let broker = Broker::new();
        let sub = broker
            .subscribe(&pattern("amos/**"), Qos::state())
            .await
            .expect("subscribe");
        assert_eq!(broker.subscriber_count().await, 1);

        // Hold the registry lock across the drop, so `Drop`'s `try_lock` cannot run.
        let guard = broker.inner.lock().await;
        drop(sub);
        drop(guard);

        assert_eq!(
            broker.subscriber_count().await,
            0,
            "a dead registration is not a subscriber"
        );
        // …and a publish agrees: nobody matches.
        let report = broker
            .publish(&topic("amos/dog1/state/mode"), frame(1))
            .await
            .expect("publish");
        assert_eq!(report.matched, Some(0));
        assert_eq!(report.delivered, 0);
    }

    #[tokio::test]
    async fn the_topic_inventory_is_bounded_and_says_when_it_is_incomplete() {
        // Power of 10 #2: a resource with a static bound. A publisher that keeps inventing
        // topic names must not be able to grow this set for the lifetime of the node —
        // and a *diagnostic* that stopped early must say so instead of looking complete.
        let broker = Broker::new();
        assert!(
            broker.topics_complete().await,
            "an empty inventory is complete"
        );
        assert!(broker.topics().await.is_empty());

        for i in 0..MAX_TRACKED_TOPICS + 8 {
            broker
                .publish(&topic(&format!("amos/dog1/sensor/t{i}")), frame(1))
                .await
                .expect("publish");
        }
        let inventory = broker.topics().await;
        assert_eq!(
            inventory.len(),
            MAX_TRACKED_TOPICS,
            "the set stops growing at the ceiling"
        );
        assert!(
            !broker.topics_complete().await,
            "and the inventory reports itself incomplete"
        );

        // A publish is never refused for a bookkeeping limit…
        let report = broker
            .publish(&topic("amos/dog1/sensor/one-more"), frame(2))
            .await
            .expect("publishing must not fail on a full inventory");
        assert_eq!(report.delivered, 0, "nobody is subscribed here");
        // …and re-publishing a *known* topic changes nothing (no double counting).
        broker
            .publish(
                &inventory[0].parse().expect("the recorded topic parses"),
                frame(3),
            )
            .await
            .expect("publish");
        assert_eq!(broker.topics().await.len(), MAX_TRACKED_TOPICS);
        assert!(!broker.topics_complete().await);
    }

    #[tokio::test]
    async fn a_publish_with_no_live_subscriber_reports_nobody_matched() {
        // A dead registration is pruned *before* matching, so a publish to a topic whose
        // only subscriber vanished reports `matched == 0` with nothing delivered and
        // nothing dropped — "nobody was listening" is not "a frame was lost", and the
        // report must not blur the two.
        let broker = Broker::new();
        let sub = broker
            .subscribe(
                &pattern("amos/**"),
                Qos::new(Reliability::Reliable, 1, crate::qos::DropPolicy::DropNewest),
            )
            .await
            .expect("subscribe");
        drop(sub);
        let report = tokio::time::timeout(
            Duration::from_secs(1),
            broker.publish(&topic("amos/dog1/control/joints"), frame(1)),
        )
        .await
        .expect("no hang")
        .expect("publish");
        assert_eq!(report.matched, Some(0), "the dead registration was pruned");
        assert_eq!(report.delivered, 0);
        assert_eq!(report.dropped, 0, "no subscriber means no drop");
        assert_eq!(report.blocked, 0, "and nothing to wait for");
    }

    #[tokio::test]
    async fn a_reliable_latest_publish_unblocks_when_the_subscriber_is_dropped() {
        let broker = Broker::new();
        let sub = broker
            .subscribe(
                &pattern("amos/**"),
                Qos::new(Reliability::Reliable, 1, crate::qos::DropPolicy::DropOldest),
            )
            .await
            .expect("subscribe");
        broker
            .publish(&topic("amos/dog1/sensor/imu"), frame(1))
            .await
            .expect("publish");
        assert_eq!(sub.stats().received, 0);
        drop(sub);
        // A closed subscription releases the waiting publisher with a report, not a hang.
        let report = tokio::time::timeout(
            Duration::from_secs(1),
            broker.publish(&topic("amos/dog1/sensor/imu"), frame(2)),
        )
        .await
        .expect("no hang")
        .expect("publish");
        assert_eq!(report.delivered, 0);
    }

    #[tokio::test]
    async fn an_invalid_qos_is_refused_at_subscribe() {
        let broker = Broker::new();
        let bad = Qos::new(
            Reliability::BestEffort,
            4,
            crate::qos::DropPolicy::DropOldest,
        );
        let err = broker
            .subscribe(&pattern("amos/**"), bad)
            .await
            .expect_err("depth-4 drop-oldest is unsupported");
        assert!(matches!(err, LinkError::Unsupported(_)));
        assert_eq!(broker.subscriber_count().await, 0);
    }

    #[tokio::test]
    async fn try_recv_never_blocks_a_collection_loop() {
        let broker = Broker::new();
        let mut sub = broker
            .subscribe(&pattern("amos/**"), Qos::state())
            .await
            .expect("subscribe");
        assert!(sub.try_recv().is_none(), "nothing published yet");
        broker
            .publish(&topic("amos/dog1/telemetry/beat"), frame(7))
            .await
            .expect("publish");
        assert_eq!(sub.try_recv().expect("frame").frame[0], 7);
        assert!(sub.try_recv().is_none());
        assert!(!sub.is_closed(), "the broker still holds the registration");
    }
}
