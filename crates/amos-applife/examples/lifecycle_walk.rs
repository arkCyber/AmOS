//! `lifecycle_walk` — one app through the real states, and the reclaim it makes possible.
//!
//! Nothing is faked: the same `AppLifecycle` the daemon's LMK path uses decides here. The
//! example launches an app, backgrounds it, freezes it (a tombstone), does the same for a
//! second app, prints the per-state counts a diagnostics tile shows, and finally asks for the
//! reclaim plan under a bounded budget — which is the *decision*, not a kill (the caller, on
//! a device, is what kills).
//!
//! Usage:
//! ```text
//! cargo run -p amos-applife --example lifecycle_walk
//! ```

use amos_applife::{AppId, AppLifecycle, AppState};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut life = AppLifecycle::new();
    let notes = AppId::new("notes");
    let camera = AppId::new("camera");

    // The app the user is looking at.
    life.launch(notes.clone())?;
    life.go_foreground(notes.clone())?;
    println!("notes: {:?}", life.state(&notes)?);

    // A second app comes forward: the first is still on screen (split), then goes back.
    life.launch(camera.clone())?;
    life.go_foreground(camera.clone())?;
    life.go_background(notes.clone())?;
    println!(
        "notes: {:?}  camera: {:?}",
        life.state(&notes)?,
        life.state(&camera)?
    );

    // Background → frozen tombstone: alive, no work scheduled, eligible for reclaim.
    life.freeze(notes.clone())?;
    life.go_background(camera.clone())?;
    life.freeze(camera.clone())?;
    println!(
        "after freezing: notes={:?} camera={:?}",
        life.state(&notes)?,
        life.state(&camera)?
    );

    // What a diagnostics tile shows, straight from the model.
    for (state, count) in life.counts() {
        println!("  {:?}: {count}", state);
    }

    // The reclaim *decision* under a budget of 1 victim: the frozen app with the oldest
    // activity goes first. Note what never appears: a foreground app.
    let victims = life.reclaim_candidates(1);
    println!("reclaim plan (budget=1): {victims:?}");

    // Starting a foreground service changes what is reclaimable — the caller does not have to
    // special-case it, the rank does.
    life.thaw(camera.clone())?;
    life.start_service(camera.clone())?;
    println!(
        "camera with a foreground service: {:?}, reclaim plan (budget=5) = {:?}",
        life.state(&camera)?,
        life.reclaim_candidates(5)
    );

    // A killed app leaves the model: it is not running and not tracked, and the reclaim plan
    // is unchanged (kill is the *action* a caller takes; reclaiming is the decision above).
    let killed = life.kill(&notes);
    println!(
        "after kill: removed={killed} contains={} reclaim plan (budget=5) = {:?}",
        life.contains(&notes),
        life.reclaim_candidates(5)
    );
    println!("stopped is the default state: {:?}", AppState::default());
    Ok(())
}
