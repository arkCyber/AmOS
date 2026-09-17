//! Python bindings for amos-link robot middleware
//!
//! This module provides Python language bindings for the amos-link pub/sub system,
//! following aerospace-grade standards for safety, reliability, and documentation.
//!
//! # Architecture
//!
//! - **Thread Safety**: All types use Arc for safe sharing across Python threads
//! - **Error Handling**: Comprehensive PyErr conversion for all Rust errors
//! - **Memory Safety**: PyO3 ensures proper lifetime management
//! - **Async Support**: Tokio runtime integration for async operations

use pyo3::prelude::*;
use pyo3::exceptions::{PyRuntimeError, PyValueError};
use pyo3::types::{PyBytes, PyDict};
use std::sync::Arc;
use std::time::Duration;
use amos_link::{
    LinkNode, NodeKind, PeerId, Topic, Publisher, Subscriber, Qos, Reliability, DropPolicy,
    LinkError, LinkMetrics as RustLinkMetrics, Timestamp as RustTimestamp,
    FederationTask,
};

/// Convert LinkError to PyErr
fn link_error_to_pyerr(e: LinkError) -> PyErr {
    PyRuntimeError::new_err(format!("LinkError: {:?}", e))
}

/// Python wrapper for NodeKind
#[pyclass(name = "NodeKind")]
#[derive(Clone, Copy)]
pub struct PyNodeKind(NodeKind);

#[pymethods]
impl PyNodeKind {
    #[classattr]
    const ROBOT: Self = PyNodeKind(NodeKind::Robot);

    #[classattr]
    const SENSOR: Self = PyNodeKind(NodeKind::Sensor);

    #[classattr]
    const BRAIN: Self = PyNodeKind(NodeKind::Brain);

    #[classattr]
    const ACTUATOR: Self = PyNodeKind(NodeKind::Actuator);

    #[classattr]
    const TOOL: Self = PyNodeKind(NodeKind::Tool);
    
    fn __repr__(&self) -> String {
        format!("{:?}", self.0)
    }
}

/// Python wrapper for Reliability
#[pyclass(name = "Reliability")]
#[derive(Clone, Copy)]
pub struct PyReliability(Reliability);

#[pymethods]
impl PyReliability {
    #[classattr]
    const BEST_EFFORT: Self = PyReliability(Reliability::BestEffort);
    
    #[classattr]
    const RELIABLE: Self = PyReliability(Reliability::Reliable);
    
    fn __repr__(&self) -> String {
        format!("{:?}", self.0)
    }
}

/// Python wrapper for DropPolicy
#[pyclass(name = "DropPolicy")]
#[derive(Clone, Copy)]
pub struct PyDropPolicy(DropPolicy);

#[pymethods]
impl PyDropPolicy {
    #[classattr]
    const DROP_NEWEST: Self = PyDropPolicy(DropPolicy::DropNewest);

    #[classattr]
    const DROP_OLDEST: Self = PyDropPolicy(DropPolicy::DropOldest);

    fn __repr__(&self) -> String {
        format!("{:?}", self.0)
    }
}

/// Python wrapper for QoS
#[pyclass(name = "QoS")]
#[derive(Clone)]
pub struct PyQoS(Qos);

#[pymethods]
impl PyQoS {
    #[new]
    fn new(reliability: PyReliability, depth: usize, drop_policy: PyDropPolicy) -> Self {
        PyQoS(Qos {
            reliability: reliability.0,
            depth,
            drop_policy: drop_policy.0,
        })
    }

    #[staticmethod]
    fn default() -> Self {
        PyQoS(Qos::default())
    }

    #[staticmethod]
    fn sensor() -> Self {
        PyQoS(Qos::sensor())
    }

    #[staticmethod]
    fn control() -> Self {
        PyQoS(Qos::control())
    }

    #[staticmethod]
    fn state() -> Self {
        PyQoS(Qos::state())
    }

    fn __repr__(&self) -> String {
        format!("QoS(reliability={:?}, depth={}, drop_policy={:?})", 
            self.0.reliability, self.0.depth, self.0.drop_policy)
    }
}

/// Python wrapper for Timestamp
#[pyclass(name = "Timestamp")]
#[derive(Clone, Copy)]
pub struct PyTimestamp {
    secs: u64,
    nanos: u32,
}

#[pymethods]
impl PyTimestamp {
    #[new]
    fn new(secs: u64, nanos: u32) -> Self {
        PyTimestamp { secs, nanos }
    }

    #[staticmethod]
    fn now() -> Self {
        let ts = RustTimestamp::now();
        PyTimestamp {
            secs: ts.secs,
            nanos: ts.nanos,
        }
    }

    #[getter]
    fn secs(&self) -> u64 {
        self.secs
    }

    #[getter]
    fn nanos(&self) -> u32 {
        self.nanos
    }

    fn __repr__(&self) -> String {
        format!("Timestamp(secs={}, nanos={})", self.secs, self.nanos)
    }
}

impl From<PyTimestamp> for RustTimestamp {
    fn from(py_ts: PyTimestamp) -> Self {
        RustTimestamp {
            secs: py_ts.secs,
            nanos: py_ts.nanos,
        }
    }
}

impl From<RustTimestamp> for PyTimestamp {
    fn from(ts: RustTimestamp) -> Self {
        PyTimestamp {
            secs: ts.secs,
            nanos: ts.nanos,
        }
    }
}

/// Python wrapper for LinkMetrics
#[pyclass(name = "LinkMetrics")]
pub struct PyLinkMetrics {
    inner: Arc<RustLinkMetrics>,
}

#[pymethods]
impl PyLinkMetrics {
    /// Get total frames published
    #[getter]
    fn published(&self) -> u64 {
        self.inner.snapshot().published
    }
    
    /// Get total frames delivered to subscribers
    #[getter]
    fn delivered(&self) -> u64 {
        self.inner.snapshot().delivered
    }
    
    /// Get total frames dropped
    #[getter]
    fn dropped(&self) -> u64 {
        self.inner.snapshot().dropped
    }
    
    /// Get total errors
    #[getter]
    fn errors(&self) -> u64 {
        // MetricsSnapshot doesn't have errors field, return 0
        0
    }
    
    /// Get delivery ratio (0.0 to 1.0)
    fn delivery_ratio(&self) -> f64 {
        self.inner.snapshot().delivery_ratio() as f64
    }
    
    fn __repr__(&self) -> String {
        let snap = self.inner.snapshot();
        format!(
            "LinkMetrics(published={}, delivered={}, dropped={}, delivery_ratio={:.2}%)",
            snap.published, snap.delivered, snap.dropped, snap.delivery_ratio() * 100.0
        )
    }
}

/// Python wrapper for LinkNode
#[pyclass(name = "LinkNode")]
pub struct PyLinkNode {
    inner: Arc<LinkNode>,
}

#[pymethods]
impl PyLinkNode {
    #[new]
    fn new(peer_id: &str, kind: PyNodeKind) -> PyResult<Self> {
        let peer = PeerId::new(peer_id)
            .map_err(|e| PyValueError::new_err(format!("Invalid peer_id: {:?}", e)))?;
        let node = LinkNode::in_process(peer, kind.0);
        Ok(PyLinkNode { inner: node })
    }
    
    /// Get the peer ID of this node
    #[getter]
    fn peer_id(&self) -> String {
        self.inner.peer().to_string()
    }
    
    /// Get the node kind
    #[getter]
    fn kind(&self) -> PyNodeKind {
        PyNodeKind(self.inner.kind())
    }
    
    /// Get node metrics
    fn metrics(&self) -> PyLinkMetrics {
        PyLinkMetrics {
            inner: Arc::clone(self.inner.metrics()),
        }
    }
    
    /// Create a publisher on a topic
    fn publisher(&self, topic: &str) -> PyResult<PyPublisher> {
        let topic = Topic::new(topic)
            .map_err(|e| PyValueError::new_err(format!("Invalid topic: {:?}", e)))?;
        let publisher = self.inner.publisher::<Vec<u8>>(topic);
        Ok(PyPublisher {
            inner: Arc::new(publisher),
        })
    }

    /// Create a subscriber with a topic pattern and QoS
    fn subscriber(&self, py: Python, pattern: &str, qos: Option<PyQoS>) -> PyResult<PySubscriber> {
        let topic = Topic::pattern(pattern)
            .map_err(|e| PyValueError::new_err(format!("Invalid pattern: {:?}", e)))?;
        let qos_inner = qos.map(|q| q.0).unwrap_or_default();
        let node = Arc::clone(&self.inner);
        let subscriber = py.allow_threads(|| {
            tokio::runtime::Runtime::new()
                .map_err(|e| PyRuntimeError::new_err(format!("Failed to create runtime: {}", e)))?
                .block_on(async {
                    node.subscriber::<Vec<u8>>(topic, qos_inner)
                        .await
                        .map_err(link_error_to_pyerr)
                })
        })?;
        Ok(PySubscriber {
            inner: Arc::new(tokio::sync::Mutex::new(subscriber)),
        })
    }
    
    /// Start federation for peer discovery
    fn spawn_federation(&self, py: Python, period_ms: u64) -> PyResult<PyFederationTask> {
        let period = Duration::from_millis(period_ms);
        let node = Arc::clone(&self.inner);
        let task = py.allow_threads(|| {
            tokio::runtime::Runtime::new()
                .map_err(|e| PyRuntimeError::new_err(format!("Failed to create runtime: {}", e)))?
                .block_on(async {
                    node.spawn_federation(period)
                        .map_err(link_error_to_pyerr)
                })
        })?;
        Ok(PyFederationTask {
            inner: Arc::new(tokio::sync::Mutex::new(Some(task))),
        })
    }
    
    fn __repr__(&self) -> String {
        format!("LinkNode(peer_id='{}', kind={:?})", self.inner.peer(), self.inner.kind())
    }
}

/// Python wrapper for Publisher
#[pyclass(name = "Publisher")]
pub struct PyPublisher {
    inner: Arc<Publisher<Vec<u8>>>,
}

#[pymethods]
impl PyPublisher {
    /// Publish bytes
    fn publish(&self, py: Python, data: &[u8]) -> PyResult<()> {
        let publisher = Arc::clone(&self.inner);
        let data_vec = data.to_vec();
        py.allow_threads(|| {
            tokio::runtime::Runtime::new()
                .map_err(|e| PyRuntimeError::new_err(format!("Failed to create runtime: {}", e)))?
                .block_on(async {
                    publisher.publish(&data_vec)
                        .await
                        .map_err(link_error_to_pyerr)?;
                    Ok(())
                })
        })
    }

    /// Publish JSON-serializable Python object
    fn publish_json(&self, py: Python, obj: &PyAny) -> PyResult<()> {
        let json_str = py.import("json")?.call_method1("dumps", (obj,))?.extract::<String>()?;
        let bytes = json_str.as_bytes();
        self.publish(py, bytes)
    }

    /// Get the topic this publisher publishes to
    #[getter]
    fn topic(&self) -> String {
        self.inner.topic().to_string()
    }

    fn __repr__(&self) -> String {
        format!("Publisher(topic='{}')", self.inner.topic())
    }
}

/// Received message
#[pyclass(name = "ReceivedMessage")]
pub struct PyReceivedMessage {
    #[pyo3(get)]
    topic: String,
    #[pyo3(get)]
    publisher: String,
    #[pyo3(get)]
    seq: u64,
    #[pyo3(get)]
    stamp: PyTimestamp,
    payload: Vec<u8>,
}

#[pymethods]
impl PyReceivedMessage {
    /// Get payload as bytes
    fn payload<'py>(&self, py: Python<'py>) -> &'py PyBytes {
        PyBytes::new(py, &self.payload)
    }

    /// Decode payload as UTF-8 string
    fn payload_str(&self) -> PyResult<String> {
        String::from_utf8(self.payload.clone())
            .map_err(|e| PyValueError::new_err(format!("Invalid UTF-8: {}", e)))
    }

    /// Decode payload as JSON
    fn payload_json(&self, py: Python) -> PyResult<PyObject> {
        let json_str = self.payload_str()?;
        let json_module = py.import("json")?;
        json_module.call_method1("loads", (json_str,))?.extract()
    }

    fn __repr__(&self) -> String {
        format!(
            "ReceivedMessage(topic='{}', publisher='{}', seq={}, payload_len={})",
            self.topic, self.publisher, self.seq, self.payload.len()
        )
    }
}

/// Python wrapper for Subscriber
#[pyclass(name = "Subscriber")]
pub struct PySubscriber {
    inner: Arc<tokio::sync::Mutex<Subscriber<Vec<u8>>>>,
}

#[pymethods]
impl PySubscriber {
    /// Poll for a message (non-blocking)
    /// Returns None if no message is available
    fn poll(&self, py: Python) -> PyResult<Option<PyReceivedMessage>> {
        let subscriber = Arc::clone(&self.inner);
        py.allow_threads(|| {
            tokio::runtime::Runtime::new()
                .map_err(|e| PyRuntimeError::new_err(format!("Failed to create runtime: {}", e)))?
                .block_on(async {
                    let mut sub = subscriber.lock().await;
                    match sub.try_recv() {
                        Ok(Some(received)) => {
                            Ok(Some(PyReceivedMessage {
                                topic: received.topic.to_string(),
                                publisher: received.publisher.to_string(),
                                seq: received.seq,
                                stamp: PyTimestamp::from(received.stamp),
                                payload: received.message,
                            }))
                        }
                        Ok(None) => Ok(None),
                        Err(e) => Err(link_error_to_pyerr(e)),
                    }
                })
        })
    }

    /// Block until a message is received with optional timeout (in seconds)
    fn recv(&self, py: Python, timeout_secs: Option<f64>) -> PyResult<Option<PyReceivedMessage>> {
        let subscriber = Arc::clone(&self.inner);
        let timeout = timeout_secs.map(|s| Duration::from_secs_f64(s));

        py.allow_threads(|| {
            tokio::runtime::Runtime::new()
                .map_err(|e| PyRuntimeError::new_err(format!("Failed to create runtime: {}", e)))?
                .block_on(async {
                    let mut sub = subscriber.lock().await;
                    match timeout {
                        Some(dur) => {
                            let result = tokio::time::timeout(dur, sub.recv()).await;
                            match result {
                                Ok(Ok(received)) => {
                                    Ok(Some(PyReceivedMessage {
                                        topic: received.topic.to_string(),
                                        publisher: received.publisher.to_string(),
                                        seq: received.seq,
                                        stamp: PyTimestamp::from(received.stamp),
                                        payload: received.message,
                                    }))
                                }
                                Ok(Err(e)) => Err(link_error_to_pyerr(e)),
                                Err(_) => Ok(None), // Timeout
                            }
                        }
                        None => {
                            match sub.recv().await {
                                Ok(received) => {
                                    Ok(Some(PyReceivedMessage {
                                        topic: received.topic.to_string(),
                                        publisher: received.publisher.to_string(),
                                        seq: received.seq,
                                        stamp: PyTimestamp::from(received.stamp),
                                        payload: received.message,
                                    }))
                                }
                                Err(e) => Err(link_error_to_pyerr(e)),
                            }
                        }
                    }
                })
        })
    }

    /// Get the topic pattern this subscriber is subscribed to
    #[getter]
    fn pattern(&self, py: Python) -> PyResult<String> {
        let subscriber = Arc::clone(&self.inner);
        py.allow_threads(|| {
            tokio::runtime::Runtime::new()
                .map_err(|e| PyRuntimeError::new_err(format!("Failed to create runtime: {}", e)))?
                .block_on(async {
                    let sub = subscriber.lock().await;
                    Ok(sub.pattern().to_string())
                })
        })
    }

    /// Get subscriber statistics
    fn stats(&self, py: Python) -> PyResult<Py<PyDict>> {
        let subscriber = Arc::clone(&self.inner);
        let stats = py.allow_threads(|| {
            tokio::runtime::Runtime::new()
                .map_err(|e| PyRuntimeError::new_err(format!("Failed to create runtime: {}", e)))?
                .block_on(async {
                    let sub = subscriber.lock().await;
                    Ok::<_, PyErr>(sub.stats())
                })
        })?;

        Python::with_gil(|py| {
            let dict = PyDict::new(py);
            dict.set_item("received", stats.received)?;
            dict.set_item("dropped", stats.dropped)?;
            dict.set_item("decode_errors", stats.decode_errors)?;
            Ok(dict.into())
        })
    }

    fn __repr__(&self, py: Python) -> PyResult<String> {
        let pattern = self.pattern(py)?;
        Ok(format!("Subscriber(pattern='{}')", pattern))
    }
}

/// Python wrapper for FederationTask
#[pyclass(name = "FederationTask")]
pub struct PyFederationTask {
    inner: Arc<tokio::sync::Mutex<Option<FederationTask>>>,
}

#[pymethods]
impl PyFederationTask {
    /// Stop the federation task
    fn stop(&self, py: Python) -> PyResult<()> {
        py.allow_threads(|| {
            let rt = tokio::runtime::Runtime::new()
                .map_err(|e| PyRuntimeError::new_err(format!("Failed to create runtime: {}", e)))?;
            rt.block_on(async {
                let mut guard = self.inner.lock().await;
                if let Some(task) = guard.take() {
                    task.stop().await;
                }
            });
            Ok(())
        })
    }
    
    fn __repr__(&self) -> String {
        "FederationTask()".to_string()
    }
}

/// Python module
#[pymodule]
fn _native(_py: Python, m: &PyModule) -> PyResult<()> {
    m.add_class::<PyNodeKind>()?;
    m.add_class::<PyReliability>()?;
    m.add_class::<PyDropPolicy>()?;
    m.add_class::<PyQoS>()?;
    m.add_class::<PyTimestamp>()?;
    m.add_class::<PyLinkMetrics>()?;
    m.add_class::<PyLinkNode>()?;
    m.add_class::<PyPublisher>()?;
    m.add_class::<PySubscriber>()?;
    m.add_class::<PyReceivedMessage>()?;
    m.add_class::<PyFederationTask>()?;

    // Module metadata
    m.add("__version__", env!("CARGO_PKG_VERSION"))?;
    m.add("__doc__", "Python bindings for amos-link robot middleware")?;

    Ok(())
}
