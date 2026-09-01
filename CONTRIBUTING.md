# Contributing to Amos

Thank you for your interest in contributing to Amos! We welcome contributions of all kinds, including bug reports, feature requests, documentation improvements, and code contributions.

## Code of Conduct

This project adheres to a [Code of Conduct](./CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code.

## Getting Started

### Prerequisites

- **Rust 1.80+** (see [rust-toolchain.toml](./rust-toolchain.toml))
- **Protoc** (for protocol buffer compilation)
- **Tauri CLI** (for desktop UI development)
- **Bun** (for JavaScript/TypeScript frontend)

### Local Development Setup

1. **Clone the repository:**
   ```bash
   git clone https://github.com/yourusername/amos.git
   cd amos
   ```

2. **Install Rust dependencies:**
   ```bash
   # The rust-toolchain.toml will automatically use the correct Rust version
   rustup update
   ```

3. **Install system dependencies (Linux only):**
   ```bash
   sudo apt-get update
   sudo apt-get install -y \
     libwebkit2gtk-4.1-dev \
     libappindicator3-dev \
     librsvg2-dev \
     patchelf \
     libgtk-3-dev
   ```

4. **Build the workspace:**
   ```bash
   make build
   ```

### Running the Project

```bash
# Terminal 1: Start the AI daemon (gRPC server over UDS)
cargo run -p amos-ai

# Terminal 2: Launch the System UI (Tauri app)
cargo run -p amos-tauri
```

To override the socket path:
```bash
AMOS_SOCKET=/custom/path.sock cargo run -p amos-ai
```

## Development Workflow

### Making Changes

1. **Create a feature branch:**
   ```bash
   git checkout -b feature/your-feature-name
   # or
   git checkout -b fix/your-bug-fix
   ```

2. **Make your changes:**
   - Follow the project's code style (see below)
   - Update tests as needed
   - Update documentation if relevant

3. **Run tests locally:**
   ```bash
   make test          # Run all tests (Rust + JavaScript)
   make lint          # Check formatting and linting
   ```

4. **Commit with clear messages:**
   ```bash
   git commit -m "feat: add new feature" -m "Detailed description"
   ```
   Follow [Conventional Commits](https://www.conventionalcommits.org/) format.

5. **Push and create a Pull Request:**
   ```bash
   git push origin feature/your-feature-name
   ```

### Code Style

#### Rust
- Format with `cargo fmt`
- Lint with `cargo clippy`
- All warnings must be resolved (`clippy -D warnings`)
- Write doc comments for public APIs

#### JavaScript/TypeScript (Frontend)
- Format with Prettier (configured in frontend package.json)
- Follow ESLint rules
- Write meaningful test cases

### Architecture & Design

Before making significant changes, review:
- [ARCHITECTURE.md](./docs/ARCHITECTURE.md) — System layers and crate responsibilities
- [proto/ai_agent.proto](./proto/ai_agent.proto) — gRPC contract (source of truth)

**Key principle:** The `.proto` file is the single source of truth. If you modify the gRPC contract, update the `.proto` file first, then regenerate Rust code on both sides during `cargo build`.

## Reporting Issues

### Bugs

Please use the GitHub issue tracker to report bugs. Include:
- A clear description of the problem
- Steps to reproduce
- Expected vs. actual behavior
- Environment details (OS, Rust version, etc.)
- Relevant logs or error messages

### Feature Requests

For feature requests, describe:
- The use case or problem you're solving
- Proposed solution (if any)
- Alternative approaches considered
- Why this feature would be useful to the project

## Pull Request Process

1. **Ensure all tests pass:**
   ```bash
   make lint
   make test
   ```

2. **Update documentation** if you've changed:
   - Public APIs
   - Configuration options
   - Build/deployment procedures

3. **Keep commits logical and atomic:**
   - Each commit should be a self-contained change
   - Use clear, descriptive commit messages

4. **Request review** from maintainers

5. **Address feedback** constructively and keep the conversation respectful

### PR Title & Description Template

```markdown
## Description
Brief summary of what this PR does.

## Type of Change
- [ ] Bug fix (non-breaking)
- [ ] New feature (non-breaking)
- [ ] Breaking change
- [ ] Documentation update

## Related Issues
Fixes #issue_number

## Testing
Describe how you tested these changes.

## Checklist
- [ ] I have formatted my code with `cargo fmt`
- [ ] I have run `cargo clippy` and resolved warnings
- [ ] I have added/updated tests
- [ ] I have updated relevant documentation
- [ ] All tests pass locally (`make test`)
```

## Testing Guidelines

### Running Tests

```bash
# All tests (Rust + JS)
make test

# Rust tests only
cargo test --workspace

# Specific crate
cargo test -p amos-ai

# End-to-end tests (RPC over UDS)
cargo test --test rpc_test

# Frontend tests
cd crates/amos-tauri/frontend && bun run test
```

### Writing Tests

- **Unit tests:** Place in the same file as the code using `#[cfg(test)]` modules
- **Integration tests:** Place in `tests/` directories
- **Property-based tests:** Use `quickcheck` or `proptest` where appropriate
- **End-to-end tests:** Test gRPC communication over UDS

Example:
```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_socket_connection() {
        // Test async code with tokio
    }
}
```

## Commit Message Convention

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>[optional scope]: <description>

[optional body]

[optional footer(s)]
```

**Types:**
- `feat:` A new feature
- `fix:` A bug fix
- `docs:` Documentation only
- `style:` Code style changes (formatting)
- `refactor:` Code refactoring without feature changes
- `perf:` Performance improvements
- `test:` Adding or updating tests
- `chore:` Dependency or tooling updates

**Example:**
```
feat(ai-daemon): add streaming token support

Implement proper streaming for token delivery over gRPC
to reduce latency in real-time inference.

Closes #123
```

## Documentation

- Keep README.md up to date
- Update docs/ files for architecture changes
- Add doc comments for public Rust APIs:
  ```rust
  /// Connects to the AI daemon over a Unix Domain Socket.
  ///
  /// # Arguments
  /// * `socket_path` - Path to the UDS socket
  ///
  /// # Examples
  /// ```
  /// let client = connect("/tmp/amos-ai.sock").await?;
  /// ```
  pub async fn connect(socket_path: &str) -> Result<Client> {
      // ...
  }
  ```

## Troubleshooting

### Common Issues

**"Could not find protoc"**
- Install protoc: `brew install protobuf` (macOS) or `apt-get install protobuf-compiler` (Linux)

**"Bun not found"**
- Install bun: `curl -fsSL https://bun.sh/install | bash`

**Tests fail in CI but pass locally**
- Ensure you're using the same Rust version as CI: `rustup update stable`
- Clear build cache: `cargo clean && make build`

## Licensing

By contributing to Amos, you agree that your contributions will be licensed under the same license as the project (MIT OR Apache-2.0).

## Questions?

If you have questions or need help:
1. Check existing issues and discussions
2. Open a new discussion if needed
3. Reach out to the maintainers at arksong2018@gmail.com

Thank you for contributing! 🎉
