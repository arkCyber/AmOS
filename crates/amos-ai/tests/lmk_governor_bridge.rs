//! Integration test for the container↔host LMK bridge: the container-side
//! `AndroidManagerService` LMK-proxy is wired to the daemon's shared
//! `ResourceGovernor` via `GovernorLmkHost`, so a container launch / Activity
//! lifecycle event / LMK kill shows up in the *same* governor the `Governor`
//! gRPC service exposes. (No socket needed — both services are driven in-process
//! against one shared `Arc<Mutex<ResourceGovernor>>`, exactly as `serve()` wires
//! them. See docs/lmk-proxy.md §8.)

use std::sync::{Arc, Mutex};

use amos_ai::governor::ResourceGovernor;
use amos_ai::governor_service::{GovernorLmkHost, GovernorService};
use amos_android::{AndroidManagerService, DemoRuntime};
use amos_proto::amos_governor::{
    governor_server::Governor, AppState as ProtoState, Empty as GovEmpty,
};
use amos_proto::android_compat::{
    android_manager_server::AndroidManager, ActivityEvent, ActivityEventRequest, AppLaunchRequest,
    LmkRequest, MemoryPressure,
};
use tonic::Request;

#[tokio::test]
async fn container_lifecycle_and_kill_reflect_into_shared_governor() {
    // One shared governor: the android service reports into it (GovernorLmkHost),
    // and GovernorService reads the same instance back out.
    let shared: Arc<Mutex<ResourceGovernor>> = Arc::new(Mutex::new(ResourceGovernor::default()));
    let android = AndroidManagerService::with_runtime_and_host(
        Arc::new(DemoRuntime::new()),
        Arc::new(GovernorLmkHost::new(Arc::clone(&shared))),
    );
    let gov = GovernorService::new(Arc::clone(&shared));

    // 1. Container launch -> host register at Foreground.
    android
        .launch_android_app(Request::new(AppLaunchRequest {
            package_name: "com.tencent.mm".into(),
        }))
        .await
        .unwrap();
    let st = read_state(&gov).await;
    assert_eq!(
        st.apps.len(),
        1,
        "host must adopt the launched container app"
    );
    assert_eq!(st.apps[0].app_id, "com.tencent.mm");
    assert_eq!(st.apps[0].state, ProtoState::Foreground as i32);

    // 2. Container top Activity hidden (OnActivity Stop) -> host Background.
    android
        .on_activity(Request::new(ActivityEventRequest {
            package_name: "com.tencent.mm".into(),
            event: ActivityEvent::Stop as i32,
        }))
        .await
        .unwrap();
    let st = read_state(&gov).await;
    assert_eq!(st.apps[0].state, ProtoState::Background as i32);
    assert_eq!(st.background_count, 1, "governor sees the backgrounded app");

    // 3. Container critical reclaim (TriggerLmk) kills it -> host drops it.
    android
        .trigger_lmk(Request::new(LmkRequest {
            pressure: MemoryPressure::Critical as i32,
            budget: 10,
        }))
        .await
        .unwrap();
    let st = read_state(&gov).await;
    assert!(
        st.apps.is_empty(),
        "a container LMK kill must unregister the app from the host governor"
    );
}

async fn read_state(gov: &GovernorService) -> amos_proto::amos_governor::GovernorState {
    gov.get_state(Request::new(GovEmpty {}))
        .await
        .unwrap()
        .into_inner()
}
