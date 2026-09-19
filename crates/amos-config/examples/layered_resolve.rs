//! Resolve one key through the documented layer order, print **why** it has the
//! value it has (`Resolver::explain`), then read it back with a type.
//!
//! Offline and deterministic: the only configured layer is the process
//! environment (plus a registered default), so no file is read or written.
//!
//! ```bash
//! cargo run -p amos-config --example layered_resolve
//! AMOS_AI_PORT=9090 cargo run -p amos-config --example layered_resolve
//! AMOS_AI_PORT=not-a-number cargo run -p amos-config --example layered_resolve
//! ```

use amos_config::{Layer, ResolverBuilder, Schema, Type};

fn main() {
    let resolver = ResolverBuilder::new()
        .layer(Layer::Env)
        .with_default("amos.ai.port", serde_json::json!(8080))
        .schema(
            "amos.ai.port",
            Schema {
                ty: Type::Integer,
                minimum: Some(1.0),
                maximum: Some(65535.0),
                enum_values: None,
            },
        )
        .build();

    // Every layer's contribution, in priority order — the answer to
    // "why is this value what it is?".
    println!("{}", resolver.explain("amos.ai.port"));

    match resolver.get_typed::<u16>("amos.ai.port") {
        Ok(Some(port)) => println!("amos.ai.port = {port}"),
        Ok(None) => {
            println!("amos.ai.port is absent (no layer produced it and no default is registered)")
        }
        Err(e) => println!("amos.ai.port was refused: {e}"),
    }
}
