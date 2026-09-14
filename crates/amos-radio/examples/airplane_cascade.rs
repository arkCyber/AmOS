//! `airplane_cascade` — airplane mode as a policy, not a flag switch.
//!
//! Turning airplane on shuts the radios down in a defined order; turning it off restores
//! **only what was on before**. The example also shows a platform-managed radio (a hotspot the
//! platform owns): it is refused *before* it is attempted, with the surface the screen should
//! offer instead — rather than a silent failure the user cannot act on.
//!
//! Usage:
//! ```text
//! cargo run -p amos-radio --example airplane_cascade
//! ```

use std::sync::Arc;

use amos_radio::provider::RadioControl;
use amos_radio::{MockRadioProvider, RadioManager, RadioMode, RadioSnapshot};

fn show(label: &str, snapshot: RadioSnapshot) {
    println!(
        "{label:<34} wifi={:<5} bluetooth={:<5} airplane={:<5} hotspot={}",
        snapshot.wifi, snapshot.bluetooth, snapshot.airplane, snapshot.hotspot
    );
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // A device with both radios on.
    let provider = Arc::new(MockRadioProvider::new(RadioSnapshot {
        wifi: true,
        bluetooth: true,
        airplane: false,
        hotspot: false,
    }));
    let manager = RadioManager::new(Arc::clone(&provider) as Arc<dyn amos_radio::RadioProvider>);
    show("start", manager.snapshot().await?);

    // `control` answers who owns the switch before anything is attempted.
    for radio in [RadioMode::Wifi, RadioMode::Bluetooth, RadioMode::Airplane] {
        match manager.control(radio).await {
            RadioControl::AppControlled => println!("{:?}: app-controlled", radio),
            RadioControl::PlatformManaged { surface, reason } => {
                println!("{:?}: platform-managed ({surface:?}, {reason:?})", radio)
            }
        }
    }

    // Airplane on: the cascade runs in the defined order and the snapshot reflects it.
    show("airplane on", manager.set(RadioMode::Airplane, true).await?);

    // While airplane is on, switching a radio on is refused (the guard, not a race).
    match manager.set(RadioMode::Wifi, true).await {
        Ok(s) => show("wifi on while airplane=on", s),
        Err(e) => println!("wifi on while airplane=on refused: {e}"),
    }

    // Airplane off: only the radios that were on before come back.
    show(
        "airplane off",
        manager.set(RadioMode::Airplane, false).await?,
    );
    Ok(())
}
