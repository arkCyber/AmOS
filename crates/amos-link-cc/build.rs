fn main() {
    // cbindgen is run manually (see README).
    // We emit a note so `cargo build` gives a reminder.
    if let Ok(_header) = std::env::var("OUT_DIR").map(|d| {
        std::path::Path::new(&d).join("amos_link.h")
    }) {
        eprintln!(
            "[build.rs] NOTE: run `cbindgen --config cbindgen.toml \
             --crate amos-link-cc --output c-headers/amos_link.h` \
             to regenerate the C header."
        );
    }
}
