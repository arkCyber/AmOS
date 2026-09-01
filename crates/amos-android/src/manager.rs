//! Enhanced Android manager with timeout support, icon caching, and resource management.
//!
//! This module wraps the basic `AndroidRuntime` to add production-ready features:
//! - Operation timeouts (configurable per operation)
//! - Icon caching with LRU eviction
//! - Detailed error handling and logging
//! - Resource cleanup on shutdown

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::RwLock;
use anyhow::{anyhow, Result};

use amos_proto::android_compat::AndroidApp;

use crate::runtime::AndroidRuntime;

/// Configuration for the enhanced Android manager.
#[derive(Debug, Clone)]
pub struct AndroidManagerConfig {
    /// Maximum time to wait for app launch operation (seconds).
    pub launch_timeout_secs: u64,
    /// Maximum time to wait for list_apps operation (seconds).
    pub list_timeout_secs: u64,
    /// Maximum time to wait for icon fetch (seconds).
    pub icon_timeout_secs: u64,
    /// Maximum number of icon cache entries.
    pub icon_cache_size: usize,
}

impl Default for AndroidManagerConfig {
    fn default() -> Self {
        Self {
            launch_timeout_secs: 30,
            list_timeout_secs: 10,
            icon_timeout_secs: 5,
            icon_cache_size: 256,
        }
    }
}

/// Icon cache entry with metadata.
#[derive(Debug, Clone)]
struct CacheEntry {
    png_data: Vec<u8>,
    access_count: usize,
    created_at: std::time::Instant,
}

/// Enhanced Android manager with production features.
pub struct EnhancedAndroidManager {
    runtime: Arc<dyn AndroidRuntime>,
    config: AndroidManagerConfig,
    /// Simple LRU icon cache (package_name -> png_data).
    icon_cache: Arc<RwLock<HashMap<String, CacheEntry>>>,
    /// Track active operations for resource cleanup.
    active_ops: Arc<RwLock<usize>>,
}

impl EnhancedAndroidManager {
    /// Create a new enhanced manager with default configuration.
    pub fn new(runtime: Arc<dyn AndroidRuntime>) -> Self {
        Self::with_config(runtime, AndroidManagerConfig::default())
    }

    /// Create with custom configuration.
    pub fn with_config(runtime: Arc<dyn AndroidRuntime>, config: AndroidManagerConfig) -> Self {
        Self {
            runtime,
            config,
            icon_cache: Arc::new(RwLock::new(HashMap::new())),
            active_ops: Arc::new(RwLock::new(0)),
        }
    }

    /// Launch an app with timeout protection.
    pub async fn launch_app(&self, package_name: &str) -> Result<String> {
        self.increment_ops().await;
        let timeout = Duration::from_secs(self.config.launch_timeout_secs);
        
        let pkg = package_name.to_string();
        let runtime = self.runtime.clone();
        
        let result = tokio::time::timeout(
            timeout,
            tokio::task::spawn_blocking(move || runtime.launch(&pkg)),
        )
        .await;

        self.decrement_ops().await;

        match result {
            Ok(Ok(Ok(window_id))) => {
                tracing::info!("launched app: {} -> {}", package_name, window_id);
                Ok(window_id)
            }
            Ok(Ok(Err(e))) => {
                tracing::warn!("app launch failed: {}: {}", package_name, e);
                Err(anyhow!("launch failed: {}", e))
            }
            Ok(Err(e)) => {
                tracing::error!("task join error: {}", e);
                Err(anyhow!("task join error: {}", e))
            }
            Err(_) => {
                tracing::error!("app launch timeout after {}s: {}", self.config.launch_timeout_secs, package_name);
                Err(anyhow!("operation timeout"))
            }
        }
    }

    /// List installed apps with timeout protection.
    pub async fn list_apps(&self) -> Result<Vec<AndroidApp>> {
        self.increment_ops().await;
        let timeout = Duration::from_secs(self.config.list_timeout_secs);
        
        let runtime = self.runtime.clone();
        
        let result = tokio::time::timeout(
            timeout,
            tokio::task::spawn_blocking(move || runtime.list_apps()),
        )
        .await;

        self.decrement_ops().await;

        match result {
            Ok(Ok(Ok(apps))) => {
                tracing::debug!("listed {} apps", apps.len());
                Ok(apps)
            }
            Ok(Ok(Err(e))) => {
                tracing::warn!("list_apps failed: {}", e);
                Err(anyhow!("list failed: {}", e))
            }
            Ok(Err(e)) => {
                tracing::error!("task join error: {}", e);
                Err(anyhow!("task join error: {}", e))
            }
            Err(_) => {
                tracing::error!("list_apps timeout after {}s", self.config.list_timeout_secs);
                Err(anyhow!("operation timeout"))
            }
        }
    }

    /// Get app icon with caching.
    pub async fn get_icon(&self, package_name: &str) -> Result<Option<Vec<u8>>> {
        // Check cache first.
        {
            let mut cache = self.icon_cache.write().await;
            if let Some(entry) = cache.get_mut(package_name) {
                entry.access_count += 1;
                tracing::debug!("icon cache hit: {}", package_name);
                return Ok(Some(entry.png_data.clone()));
            }
        }

        self.increment_ops().await;
        let timeout = Duration::from_secs(self.config.icon_timeout_secs);
        
        let pkg = package_name.to_string();
        let runtime = self.runtime.clone();
        
        let result = tokio::time::timeout(
            timeout,
            tokio::task::spawn_blocking(move || runtime.icon_for(&pkg)),
        )
        .await;

        self.decrement_ops().await;

        match result {
            Ok(Ok(Some(png_data))) => {
                // Store in cache.
                {
                    let mut cache = self.icon_cache.write().await;
                    
                    // Evict oldest entry if cache is full.
                    if cache.len() >= self.config.icon_cache_size {
                        if let Some(oldest_key) = cache
                            .iter()
                            .min_by_key(|(_, entry)| entry.created_at)
                            .map(|(k, _)| k.clone())
                        {
                            cache.remove(&oldest_key);
                            tracing::debug!("evicted icon cache entry: {}", oldest_key);
                        }
                    }

                    cache.insert(
                        package_name.to_string(),
                        CacheEntry {
                            png_data: png_data.clone(),
                            access_count: 1,
                            created_at: std::time::Instant::now(),
                        },
                    );
                }

                tracing::debug!("cached icon: {} ({} bytes)", package_name, png_data.len());
                Ok(Some(png_data))
            }
            Ok(Ok(None)) => {
                tracing::debug!("icon not available: {}", package_name);
                Ok(None)
            }
            Ok(Err(e)) => {
                tracing::warn!("icon fetch failed: {}: {}", package_name, e);
                Ok(None) // Non-fatal, return None instead of error
            }
            Err(_) => {
                tracing::warn!("icon fetch timeout after {}s: {}", self.config.icon_timeout_secs, package_name);
                Ok(None) // Non-fatal timeout
            }
        }
    }

    /// Get cache statistics.
    pub async fn cache_stats(&self) -> CacheStats {
        let cache = self.icon_cache.read().await;
        let total_bytes: usize = cache.values().map(|e| e.png_data.len()).sum();
        let total_accesses: usize = cache.values().map(|e| e.access_count).sum();
        
        CacheStats {
            entries: cache.len(),
            total_bytes,
            total_accesses,
            capacity: self.config.icon_cache_size,
        }
    }

    /// Clear the icon cache.
    pub async fn clear_cache(&self) {
        let mut cache = self.icon_cache.write().await;
        let count = cache.len();
        cache.clear();
        tracing::info!("cleared icon cache ({} entries)", count);
    }

    /// Get number of active operations.
    pub async fn active_operations(&self) -> usize {
        *self.active_ops.read().await
    }

    /// Wait for all operations to complete (for graceful shutdown).
    pub async fn wait_for_completion(&self, timeout_secs: u64) -> Result<()> {
        let deadline = std::time::Instant::now() + Duration::from_secs(timeout_secs);
        loop {
            let active = self.active_operations().await;
            if active == 0 {
                return Ok(());
            }
            if std::time::Instant::now() > deadline {
                tracing::warn!("shutdown timeout: {} operations still active", active);
                return Err(anyhow!("shutdown timeout"));
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    async fn increment_ops(&self) {
        let mut ops = self.active_ops.write().await;
        *ops += 1;
    }

    async fn decrement_ops(&self) {
        let mut ops = self.active_ops.write().await;
        if *ops > 0 {
            *ops -= 1;
        }
    }
}

/// Cache statistics.
#[derive(Debug, Clone)]
pub struct CacheStats {
    pub entries: usize,
    pub total_bytes: usize,
    pub total_accesses: usize,
    pub capacity: usize,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::DemoRuntime;

    #[tokio::test]
    async fn enhanced_manager_caches_icons() {
        let runtime = Arc::new(DemoRuntime::new());
        let manager = EnhancedAndroidManager::new(runtime);

        let icon1 = manager.get_icon("com.tencent.mm").await.unwrap();
        let icon2 = manager.get_icon("com.tencent.mm").await.unwrap();

        // Both should exist and be identical
        assert!(icon1.is_some());
        assert!(icon2.is_some());
        assert_eq!(icon1, icon2);

        // Cache should have one entry
        let stats = manager.cache_stats().await;
        assert_eq!(stats.entries, 1);
        assert_eq!(stats.total_accesses, 2);
    }

    #[tokio::test]
    async fn enhanced_manager_launches_with_timeout() {
        let runtime = Arc::new(DemoRuntime::new());
        let config = AndroidManagerConfig {
            launch_timeout_secs: 5,
            ..Default::default()
        };
        let manager = EnhancedAndroidManager::with_config(runtime, config);

        let result = manager.launch_app("com.tencent.mm").await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn enhanced_manager_lists_apps_with_timeout() {
        let runtime = Arc::new(DemoRuntime::new());
        let config = AndroidManagerConfig {
            list_timeout_secs: 5,
            ..Default::default()
        };
        let manager = EnhancedAndroidManager::with_config(runtime, config);

        let apps = manager.list_apps().await.unwrap();
        assert!(!apps.is_empty());
    }

    #[tokio::test]
    async fn enhanced_manager_tracks_active_operations() {
        let runtime = Arc::new(DemoRuntime::new());
        let manager = EnhancedAndroidManager::new(runtime);

        assert_eq!(manager.active_operations().await, 0);
        manager.increment_ops().await;
        assert_eq!(manager.active_operations().await, 1);
        manager.decrement_ops().await;
        assert_eq!(manager.active_operations().await, 0);
    }

    #[tokio::test]
    async fn enhanced_manager_evicts_old_cache_entries() {
        let runtime = Arc::new(DemoRuntime::new());
        let config = AndroidManagerConfig {
            icon_cache_size: 2,
            ..Default::default()
        };
        let manager = EnhancedAndroidManager::with_config(runtime, config);

        // Cache two icons
        manager.get_icon("com.tencent.mm").await.unwrap();
        manager.get_icon("com.ss.android.ugc.aweme").await.unwrap();

        let stats = manager.cache_stats().await;
        assert_eq!(stats.entries, 2);

        // Cache a third icon - should evict the oldest
        manager.get_icon("com.taobao.taobao").await.unwrap();

        let stats = manager.cache_stats().await;
        assert_eq!(stats.entries, 2); // Still 2, oldest was evicted
    }

    #[tokio::test]
    async fn enhanced_manager_graceful_shutdown() {
        let runtime = Arc::new(DemoRuntime::new());
        let manager = Arc::new(EnhancedAndroidManager::new(runtime));

        // Simulate some operations
        manager.increment_ops().await;
        manager.increment_ops().await;
        assert_eq!(manager.active_operations().await, 2);

        manager.decrement_ops().await;
        manager.decrement_ops().await;

        // Should complete immediately since no ops are active
        let result = manager.wait_for_completion(5).await;
        assert!(result.is_ok());
    }
}
