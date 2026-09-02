//! gRPC `AndroidManager` service backed by an [`EnhancedAndroidManager`], which
//! wraps the underlying [`AndroidRuntime`] with operation timeouts and an LRU
//! icon cache so the Tauri core gets a robust, bounded-memory surface.

use std::sync::Arc;

use amos_proto::android_compat::{
    android_manager_server::{AndroidManager, AndroidManagerServer},
    AppIconRequest, AppIconResponse, AppLaunchRequest, AppLaunchResponse, AppListResponse, Empty,
};
use tonic::{Request, Response, Status};

use crate::manager::EnhancedAndroidManager;
use crate::runtime::AndroidRuntime;

/// gRPC service exposing the Android-compat layer to the Tauri core.
///
/// All calls flow through [`EnhancedAndroidManager`], so every operation has a
/// configurable timeout and icon fetches are cached (LRU) rather than hitting
/// the container every time.
pub struct AndroidManagerService {
    manager: Arc<EnhancedAndroidManager>,
}

impl AndroidManagerService {
    /// Build a service around an enhanced manager (timeouts + icon cache).
    pub fn with_manager(manager: Arc<EnhancedAndroidManager>) -> Self {
        Self { manager }
    }

    /// Convenience: wrap a raw runtime in the default enhanced manager.
    pub fn with_runtime(runtime: Arc<dyn AndroidRuntime>) -> Self {
        Self::with_manager(Arc::new(EnhancedAndroidManager::new(runtime)))
    }
}

#[tonic::async_trait]
impl AndroidManager for AndroidManagerService {
    async fn launch_android_app(
        &self,
        request: Request<AppLaunchRequest>,
    ) -> Result<Response<AppLaunchResponse>, Status> {
        let package_name = request.into_inner().package_name;
        Ok(Response::new(
            match self.manager.launch_app(&package_name).await {
                Ok(window_id) => AppLaunchResponse {
                    success: true,
                    window_id,
                    error: String::new(),
                },
                Err(error) => AppLaunchResponse {
                    success: false,
                    window_id: String::new(),
                    error: error.to_string(),
                },
            },
        ))
    }

    async fn get_installed_apps(
        &self,
        _request: Request<Empty>,
    ) -> Result<Response<AppListResponse>, Status> {
        match self.manager.list_apps().await {
            Ok(apps) => Ok(Response::new(AppListResponse { apps })),
            Err(e) => Err(Status::internal(e.to_string())),
        }
    }

    async fn get_app_icon(
        &self,
        request: Request<AppIconRequest>,
    ) -> Result<Response<AppIconResponse>, Status> {
        let package_name = request.into_inner().package_name;
        Ok(Response::new(
            match self.manager.get_icon(&package_name).await {
                Ok(Some(png)) => AppIconResponse {
                    icon_png: png,
                    found: true,
                },
                // Icon not found / fetch timeout are non-fatal by design.
                Ok(None) | Err(_) => AppIconResponse {
                    icon_png: Vec::new(),
                    found: false,
                },
            },
        ))
    }
}

/// Convenience for wiring the service into a tonic server. Wraps the runtime in
/// the default enhanced manager so timeouts + caching apply automatically.
pub fn server(runtime: Arc<dyn AndroidRuntime>) -> AndroidManagerServer<AndroidManagerService> {
    AndroidManagerServer::new(AndroidManagerService::with_runtime(runtime))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::DemoRuntime;

    #[tokio::test]
    async fn get_installed_apps_returns_curated_list() {
        let svc = AndroidManagerService::with_runtime(Arc::new(DemoRuntime::new()));
        let reply = svc
            .get_installed_apps(Request::new(Empty {}))
            .await
            .unwrap()
            .into_inner();
        assert_eq!(reply.apps.len(), 4);
        assert_eq!(reply.apps[0].package_name, "com.tencent.mm");
    }

    #[tokio::test]
    async fn launch_returns_window_id() {
        let svc = AndroidManagerService::with_runtime(Arc::new(DemoRuntime::new()));
        let reply = svc
            .launch_android_app(Request::new(AppLaunchRequest {
                package_name: "com.tencent.mm".into(),
            }))
            .await
            .unwrap()
            .into_inner();
        assert!(reply.success);
        assert_eq!(reply.window_id, "waydroid_demo_com.tencent.mm");
    }

    #[tokio::test]
    async fn get_app_icon_returns_png_and_caches() {
        let svc = AndroidManagerService::with_runtime(Arc::new(DemoRuntime::new()));
        let reply = svc
            .get_app_icon(Request::new(AppIconRequest {
                package_name: "com.tencent.mm".into(),
            }))
            .await
            .unwrap()
            .into_inner();
        assert!(reply.found);
        assert_eq!(
            &reply.icon_png[..8],
            &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]
        );

        // Second call hits the LRU cache (no runtime round-trip).
        let stats = svc.manager.cache_stats().await;
        assert_eq!(stats.entries, 1, "icon cached after first fetch");
        assert_eq!(stats.total_accesses, 1, "first access counted");
        let again = svc
            .get_app_icon(Request::new(AppIconRequest {
                package_name: "com.tencent.mm".into(),
            }))
            .await
            .unwrap()
            .into_inner();
        assert!(again.found);
        let stats2 = svc.manager.cache_stats().await;
        assert_eq!(stats2.total_accesses, 2, "cache hit bumps access count");
    }
}
