fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Paths are resolved relative to this crate's directory (crates/amos-proto).
    // tonic-prost-build (tonic 0.14+) is the crate that compiles protos for tonic.
    tonic_prost_build::configure()
        .build_client(true)
        .build_server(true)
        .compile_protos(
            &[
                "../../proto/ai_agent.proto",
                "../../proto/android_compat.proto",
                "../../proto/translate.proto",
                "../../proto/telephony.proto",
            ],
            &["../../proto"],
        )?;
    println!("cargo:rerun-if-changed=../../proto/ai_agent.proto");
    println!("cargo:rerun-if-changed=../../proto/android_compat.proto");
    println!("cargo:rerun-if-changed=../../proto/translate.proto");
    println!("cargo:rerun-if-changed=../../proto/telephony.proto");
    Ok(())
}
