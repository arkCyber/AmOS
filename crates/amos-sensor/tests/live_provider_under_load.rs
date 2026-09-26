//! Under-load integration test for the live bridge (Gap 3 / TODO 3.3).
//!
//! A real camera producer pushes frames far faster than the UI drains them, so
//! the bus holds **only the latest** frame per camera (a bounded backlog) and
//! hands out strictly monotonic `seq`s. This test pushes 1 000 frames across two
//! cameras and asserts both properties, plus that every accepted frame was
//! counted — a producer that silently stops delivering is the failure mode the
//! drop counters exist to surface (F-SEN-001/002).

use amos_sensor::{
    CameraConfig, CameraId, PixelFormat, Resolution, SensorManager, SensorMode, SimHarness,
};

const FRAMES: u64 = 1_000;

fn cam(id: CameraId, w: u32, h: u32, fps: u32) -> CameraConfig {
    CameraConfig {
        id,
        resolution: Resolution::new(w, h),
        fps,
        format: PixelFormat::Rgba8,
    }
}

#[test]
fn one_thousand_frames_keep_seq_monotonic_and_the_backlog_bounded() {
    let rear = cam(CameraId::REAR, 32, 32, 30); // 4096 B
    let front = cam(CameraId::FRONT, 16, 16, 60); // 1024 B
    let h = SimHarness::new(vec![rear, front], 200);
    let m = SensorManager::new(h.provider(), SensorMode::Performance);

    let mut last = (0u64, 0u64);
    for i in 0..FRAMES {
        let seqs = h.step(i).unwrap();
        assert_eq!(seqs.len(), 2, "one frame per advertised camera");
        // Strictly monotonic, one increment per accepted frame.
        assert_eq!(seqs[0], last.0 + 1);
        assert_eq!(seqs[1], last.1 + 1);
        last = (seqs[0], seqs[1]);
    }

    assert_eq!(h.frames_accepted(), FRAMES * 2);
    assert_eq!(h.frames_dropped(), 0);
    assert_eq!(h.imu_accepted(), FRAMES);

    // Bounded backlog: after 1 000 pushes each store still holds exactly one
    // frame — the latest — not a growing queue. The read agrees with the store.
    let r = m.camera_capture(CameraId::REAR).unwrap();
    let f = m.camera_capture(CameraId::FRONT).unwrap();
    assert_eq!(r.seq, FRAMES);
    assert_eq!(f.seq, FRAMES);
    assert_eq!(h.seq_of(CameraId::REAR), Some(FRAMES));
    assert_eq!(r.bytes.len(), rear.frame_len() as usize);
    assert_eq!(f.bytes.len(), front.frame_len() as usize);
}

#[test]
fn drops_are_accounted_when_the_producer_is_misbehaving_under_load() {
    // Interleave good frames with wrong-length ones: the accepted/dropped split
    // must stay exact, and the live value must always be a *good* frame.
    let rear = cam(CameraId::REAR, 32, 32, 30);
    let h = SimHarness::new(vec![rear], 100);
    let m = SensorManager::new(h.provider(), SensorMode::Performance);

    for i in 0..FRAMES {
        if i % 10 == 0 {
            // A truncated payload every tenth push.
            assert!(h.push_frame(rear, vec![0u8; 100]).is_err());
        } else {
            h.next_frame(rear, i).unwrap();
        }
    }

    assert_eq!(h.frames_dropped(), FRAMES / 10);
    assert_eq!(h.frames_accepted(), FRAMES - FRAMES / 10);
    // The surviving frame is the most recent *good* one: the last accepted push
    // is i = 999 (not divisible by 10), which is the 900th accepted frame.
    let live = m.camera_capture(CameraId::REAR).unwrap();
    assert_eq!(live.seq, FRAMES - FRAMES / 10);
    assert_eq!(live.bytes.len(), rear.frame_len() as usize);
}
