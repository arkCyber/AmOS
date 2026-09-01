//! Local, mock inference engine with production backend abstractions.
//!
//! In production, the `real` module is used to swap in GPU/NPU accelerated
//! inference or external API calls. It deliberately exposes the same *streaming*
//! shape so the transport / UI layers never need to change.

pub mod real;

use std::time::Duration;

/// Deterministically "tokenize" a prompt into a stream of small pieces.
///
/// This is a placeholder that produces a plausible token-by-token echo so the
/// full RPC + event pipeline can be exercised end-to-end.
pub fn mock_tokens(prompt: &str) -> Vec<String> {
    let reply = format!(
        "[amos-ai] 收到指令：{prompt}。我运行在操作系统底层（UDS + gRPC），正在以流式方式返回结果。"
    );

    // Simulate tokenisation by splitting on every 4th character.
    let chars: Vec<char> = reply.chars().collect();
    let mut tokens = Vec::new();
    for chunk in chars.chunks(4) {
        tokens.push(chunk.iter().collect::<String>());
    }
    tokens
}

/// Delay injected between tokens to emulate real generation latency.
pub const TOKEN_INTERVAL: Duration = Duration::from_millis(18);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mock_tokens_are_non_empty_and_deterministic() {
        let a = mock_tokens("你好");
        let b = mock_tokens("你好");
        assert_eq!(a, b, "mock tokens must be deterministic");
        assert!(!a.is_empty());
        let joined: String = a.concat();
        assert!(joined.contains("amos-ai"));
        assert!(joined.contains("你好"));
    }

    #[test]
    fn mock_tokens_chunk_by_4_chars() {
        let tokens = mock_tokens("x");
        assert!(tokens.iter().all(|t| t.chars().count() <= 4));
    }
}
