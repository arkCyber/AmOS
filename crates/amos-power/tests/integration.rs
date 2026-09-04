//! End-to-end integration of the energy governor with `amos-sensor`: a
//! [`SensorManager`] is backed by a deterministic [`MockSensorProvider`], the
//! governor turns a low-battery snapshot into a [`SensorMode`] decision, and
//! [`Decision::apply_to`] actually flips the manager's gating (a 30 FPS camera
//! preview becomes refused under `PowerSave`, and is allowed again once the
//! charger attaches / the battery recovers).

use std::sync::Arc;

use amos_power::{decide, Decision, EnergyGovernor, Policy, Telemetry};
use amos_sensor::{
    CameraConfig, CameraId, MockSensorProvider, PixelFormat, Resolution, SensorError,
    SensorManager, SensorMode,
};

fn manager_in(mode: SensorMode) -> SensorManager {
    let cfg = CameraConfig {
        id: CameraId::REAR,
        resolution: Resolution::new(640, 480),
        fps: 30, // above the PowerSave camera ceiling (15) but fine in Balanced
        format: PixelFormat::Rgba8,
    };
    let provider = MockSensorProvider::new(vec![cfg], 200, false);
    SensorManager::new(Arc::new(provider), mode)
}

#[test]
fn low_battery_decision_actually_gates_the_sensor_manager() {
    let mut governor = EnergyGovernor::new(Policy::default());
    let sensors = manager_in(SensorMode::Balanced);

    // Balanced allows the 30 FPS rear-camera preview.
    assert!(sensors.camera_capture(CameraId::REAR).is_ok());

    // Low battery (15 %) → PowerSave decision applied to the real manager.
    let low = Telemetry::new(
        amos_power::BatteryState::on_battery(15.0),
        Default::default(),
        None,
    );
    let d: Decision = governor.observe(&low);
    assert_eq!(d.sensor_mode, SensorMode::PowerSave);
    d.apply_to(&sensors);
    assert_eq!(sensors.mode(), SensorMode::PowerSave);

    // The same 30 FPS camera is now refused by the manager's PowerSave gating.
    let err = sensors.camera_capture(CameraId::REAR).unwrap_err();
    assert!(
        matches!(
            err,
            SensorError::PowerSaveRate {
                kind: amos_sensor::SensorKind::Camera,
                ..
            }
        ),
        "{err}"
    );

    // Attach the charger → Performance decision restores full access.
    let charging = Telemetry::new(
        amos_power::BatteryState::charging(15.0),
        Default::default(),
        None,
    );
    let d2 = governor.observe(&charging);
    assert_eq!(d2.sensor_mode, SensorMode::Performance);
    d2.apply_to(&sensors);
    assert_eq!(sensors.mode(), SensorMode::Performance);
    assert!(sensors.camera_capture(CameraId::REAR).is_ok());
}

#[test]
fn plain_decide_without_governor_matches_governor_first_tick() {
    // The pure rule and the stateful governor agree on the first observation.
    let low = Telemetry::new(
        amos_power::BatteryState::on_battery(12.0),
        Default::default(),
        None,
    );
    let pure = decide(&Policy::default(), &low, None);
    let mut g = EnergyGovernor::default();
    assert_eq!(pure, g.observe(&low));
}
