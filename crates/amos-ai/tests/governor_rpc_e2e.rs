//! End-to-end test of the resource-governor RPC over a real Unix Domain Socket:
//! a client (as the System UI / per-app host would) registers apps & jobs and
//! reads state back from the daemon's mounted `Governor` service.

use amos_proto::amos_governor::governor_client::GovernorClient;
use amos_proto::amos_governor::{
    AppRef, Empty, JobType as ProtoJobType, MoveAppRequest, ScheduleJobRequest,
};
use std::path::PathBuf;
use tokio::net::UnixStream;
use tonic::transport::{Endpoint, Uri};
use tower::service_fn;

async fn connect(
    path: &std::path::Path,
) -> Result<GovernorClient<tonic::transport::Channel>, String> {
    let owned_path = path.to_owned();
    let endpoint = Endpoint::try_from("http://[::1]:50051").map_err(|e| e.to_string())?;
    let channel = endpoint
        .connect_with_connector(service_fn(move |_: Uri| {
            let path = owned_path.clone();
            async move {
                let stream = UnixStream::connect(path).await?;
                Ok::<_, std::io::Error>(hyper_util::rt::TokioIo::new(stream))
            }
        }))
        .await
        .map_err(|e| e.to_string())?;
    Ok(GovernorClient::new(channel))
}

async fn wait_for_socket(path: &std::path::Path) {
    for _ in 0..50 {
        if path.exists() {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn register_move_schedule_and_get_state_over_uds() {
    let path: PathBuf = std::env::temp_dir().join(format!("amos-gov-{}.sock", std::process::id()));
    let _ = std::fs::remove_file(&path);

    let server_path = path.clone();
    let server = tokio::spawn(async move {
        amos_ai::server::serve(server_path).await.unwrap();
    });

    wait_for_socket(&path).await;
    let mut client = connect(&path).await.expect("connect");

    client
        .register_app(AppRef {
            app_id: "photos".to_string(),
        })
        .await
        .expect("register_app");
    client
        .move_app(MoveAppRequest {
            app_id: "photos".to_string(),
            to: 2, // APP_STATE_BACKGROUND
        })
        .await
        .expect("move_app");
    client
        .schedule_job(ScheduleJobRequest {
            job_id: "photos.refresh".to_string(),
            job_type: ProtoJobType::Deferred as i32,
            earliest: 0,
            latest: 500,
        })
        .await
        .expect("schedule_job");

    let state = client
        .get_state(Empty {})
        .await
        .expect("get_state")
        .into_inner();
    assert_eq!(state.background_count, 1);
    assert_eq!(state.apps.len(), 1);
    assert_eq!(state.apps[0].app_id, "photos");
    assert_eq!(state.apps[0].state, 2); // BACKGROUND
    assert_eq!(state.jobs.len(), 1);
    assert_eq!(state.jobs[0].job_type, ProtoJobType::Deferred as i32);

    // Moving an unregistered app must surface NotFound.
    let err = client
        .move_app(MoveAppRequest {
            app_id: "nope".to_string(),
            to: 2,
        })
        .await
        .expect_err("unregistered app should be NotFound");
    assert_eq!(err.code(), tonic::Code::NotFound);

    // Clean shutdown of the daemon task.
    server.abort();
    let _ = std::fs::remove_file(&path);
}
