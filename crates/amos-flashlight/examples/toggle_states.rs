//! `toggle_states` — what a real toggle reports, and what a torch-less device refuses.
//!
//! Two managers, two devices: one with torch hardware (on → off → toggle), one without. The
//! second is the interesting half — the crate never answers `on=true` unless the provider
//! accepted it, so a device with no LED produces an **error**, not a fake lit torch.
//!
//! Usage:
//! ```text
//! cargo run -p amos-flashlight --example toggle_states
//! ```

use std::sync::Arc;

use amos_flashlight::{FlashlightManager, FlashlightState, MockFlashlightProvider};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // A device that really has a torch.
    let phone = FlashlightManager::new(Arc::new(MockFlashlightProvider::new(
        FlashlightState::off_with_torch(),
    )));
    println!("snapshot: {:?}", phone.snapshot().await?);
    println!("set_on(true):  {:?}", phone.set_on(true).await?);
    println!(
        "set_on(true) again (idempotent): {:?}",
        phone.set_on(true).await?
    );
    println!("toggle: {:?}", phone.toggle().await?);
    println!("snapshot: {:?}", phone.snapshot().await?);

    // A device with no usable torch: a refusal, and the snapshot says why.
    let bare = FlashlightManager::new(Arc::new(MockFlashlightProvider::new(
        FlashlightState::no_torch(),
    )));
    println!("no-torch snapshot: {:?}", bare.snapshot().await?);
    match bare.set_on(true).await {
        Ok(state) => println!("UNEXPECTED success: {state:?}"),
        Err(e) => println!("no-torch set_on(true) refused: {e}"),
    }
    match bare.toggle().await {
        Ok(state) => println!("UNEXPECTED toggle success: {state:?}"),
        Err(e) => println!("no-torch toggle refused: {e}"),
    }
    Ok(())
}
