//! gRPC `AndroidManager` service backed by an [`AndroidRuntime`] driver.

use std::sync::Arc;

use amos_proto::android_compat::{
    android_manager_server::{AndroidManager, AndroidManagerServer},
    AppIconRequest, AppIconResponse, AppLaunchRequest, AppLaunchResponse, AppListResponse, Empty,
};
use tonic::{Request, Response, Status};

use crate::runtime::AndroidRuntime;

/// gRPC service exposing the Android-compat layer to the Tauri core.
///
/// Runtime calls are moved onto a blocking thread (`spawn_blocking`) so a
/// subprocess call never stalls the async executor.
pub struct AndroidManagerService {
    runtime: Arc<dyn AndroidRuntime>,
}

impl AndroidManagerService {
    /// Build a service around an Android runtime driver.
    pub fn with_runtime(runtime: Arc<dyn AndroidRuntime>) -> Self {
        Self { runtime }
    }
}

#[tonic::async_trait]
impl AndroidManager for AndroidManagerService {
    async fn launch_android_app(
        &self,
        request: Request<AppLaunchRequest>,
    ) -> Result<Response<AppLaunchResponse>, Status> {
        let package_name = request.into_inner().package_name;
        let runtime = self.runtime.clone();
        let result = tokio::task::spawn_blocking(move || runtime.launch(&package_name))
            .await
            .unwrap_or_else(|e| Err(format!("task join error: {e}")));
        Ok(Response::new(match result {
            Ok(window_id) => AppLaunchResponse {
                success: true,
                window_id,
                error: String::new(),
            },
            Err(error) => AppLaunchResponse {
                success: false,
                window_id: String::new(),
                error,
            },
        }))
    }

    async fn get_installed_apps(
        &self,
        _request: Request<Empty>,
    ) -> Result<Response<AppListResponse>, Status> {
        let runtime = self.runtime.clone();
        let result = tokio::task::spawn_blocking(move || runtime.list_apps())
            .await
            .unwrap_or_else(|e| Err(format!("task join error: {e}")));
        match result {
            Ok(apps) => Ok(Response::new(AppListResponse { apps })),
            Err(e) => Err(Status::internal(e)),
        }
    }

    async fn get_app_icon(
        &self,
        request: Request<AppIconRequest>,
    ) -> Result<Response<AppIconResponse>, Status> {
        let package_name = request.into_inner().package_name;
        let runtime = self.runtime.clone();
        let icon = tokio::task::spawn_blocking(move || runtime.icon_for(&package_name))
            .await
            .unwrap_or_else(|e| {
                tracing::warn!("icon task join error: {e}");
                None
            });
        Ok(Response::new(match icon {
            Some(png) => AppIconResponse {
                icon_png: png,
                found: true,
            },
            None => AppIconResponse {
                icon_png: Vec::new(),
                found: false,
            },
        }))
    }
}

/// Convenience for wiring the service into a tonic server.
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
    async fn get_app_icon_returns_png() {
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
    }
}
