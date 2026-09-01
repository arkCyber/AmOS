# Getting Started with Amos

Welcome to Amos! This guide will help you set up and run the project.

## Prerequisites

- **macOS / Linux**: (Windows via WSL2)
- **Rust 1.80+**: Install from [rustup.rs](https://rustup.rs/)
- **Protoc**: Protocol buffer compiler
- **Tauri CLI** (optional): for UI development
- **Bun**: JavaScript runtime (optional, for frontend development)

## Installation

### 1. Install Rust

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
rustup update stable
```

Verify installation:
```bash
rustc --version
cargo --version
```

### 2. Install System Dependencies

**macOS:**
```bash
brew install protobuf
brew install bun  # optional, for frontend development
```

**Linux (Ubuntu/Debian):**
```bash
sudo apt-get update
sudo apt-get install -y \
  protobuf-compiler \
  build-essential \
  libssl-dev
  
# For Tauri development
sudo apt-get install -y \
  libwebkit2gtk-4.1-dev \
  libappindicator3-dev \
  librsvg2-dev \
  patchelf \
  libgtk-3-dev
```

### 3. Clone the Repository

```bash
git clone https://github.com/yourusername/amos.git
cd amos
```

### 4. Build the Project

```bash
# Build all crates
cargo build

# Or use the Makefile
make build
```

## Running Amos

The project consists of two main components that communicate via gRPC over Unix Domain Socket.

### Terminal 1: Start the AI Daemon

```bash
cargo run -p amos-ai
# Or: cargo run -p amos-ai --release
```

You should see:
```
[INFO] AI daemon listening on /tmp/amos-ai.sock
```

### Terminal 2: Launch the System UI

```bash
cargo run -p amos-tauri
# Or: cargo run -p amos-tauri --release
```

This will launch the Tauri desktop application.

## Custom Socket Path

To use a different socket path:

```bash
# Terminal 1
AMOS_SOCKET=/tmp/my-amos.sock cargo run -p amos-ai

# Terminal 2
AMOS_SOCKET=/tmp/my-amos.sock cargo run -p amos-tauri
```

## Running Tests

```bash
# Run all tests (Rust + frontend)
make test

# Run only Rust tests
cargo test --workspace

# Run specific crate tests
cargo test -p amos-ai

# Run only frontend tests
cd crates/amos-tauri/frontend && bun run test
```

## Code Quality Checks

```bash
# Format code
make fmt  # or: cargo fmt --all

# Lint code
make lint  # or: cargo clippy --workspace --all-targets -- -D warnings

# Check frontend syntax
cd crates/amos-tauri/frontend && bun run check
```

## Project Structure

```
amos/
├── Cargo.toml                 # Workspace root configuration
├── proto/
│   └── ai_agent.proto        # gRPC service definitions
├── crates/
│   ├── amos-proto/           # Protocol buffers (Rust generated)
│   ├── amos-ai/              # AI daemon (gRPC server)
│   ├── amos-wm/              # Window manager
│   ├── amos-android/         # Android/Waydroid compatibility
│   └── amos-tauri/           # System UI (gRPC client)
├── docs/                     # Documentation
├── deploy/                   # Deployment configs
└── scripts/                  # Build and utility scripts
```

## Key Crates

| Crate | Purpose | Entry Point |
|-------|---------|-------------|
| `amos-ai` | AI inference daemon | `src/main.rs` |
| `amos-tauri` | Desktop/mobile UI | `src/main.rs` |
| `amos-proto` | Protocol buffer definitions | Auto-generated |
| `amos-wm` | Window manager state machine | `src/lib.rs` |
| `amos-android` | Android/Waydroid support | `src/lib.rs` |

## Development Workflow

1. **Create a feature branch**:
   ```bash
   git checkout -b feature/your-feature
   ```

2. **Make changes** and test:
   ```bash
   make test
   make lint
   ```

3. **Commit with clear messages**:
   ```bash
   git commit -m "feat: add new feature"
   ```

4. **Push and create a PR**:
   ```bash
   git push origin feature/your-feature
   ```

See [CONTRIBUTING.md](../CONTRIBUTING.md) for detailed guidelines.

## Troubleshooting

### Error: "Could not find protoc"
Install protoc:
- macOS: `brew install protobuf`
- Linux: `apt-get install protobuf-compiler`

### Error: "Could not find bun"
Install bun:
```bash
curl -fsSL https://bun.sh/install | bash
```

### Tests fail but code works
```bash
cargo clean
cargo build
make test
```

### Socket already in use
The socket file persists. Remove it:
```bash
rm /tmp/amos-ai.sock
```

## Environment Variables

| Variable | Purpose | Example |
|----------|---------|---------|
| `AMOS_SOCKET` | Custom socket path | `/tmp/amos-test.sock` |
| `RUST_LOG` | Log level | `debug,info` |
| `RUST_BACKTRACE` | Backtrace on panic | `1` or `full` |

## Documentation

- [README.md](../README.md) — Project overview
- [ARCHITECTURE.md](../docs/ARCHITECTURE.md) — System design
- [CONTRIBUTING.md](../CONTRIBUTING.md) — Contribution guidelines
- [proto/ai_agent.proto](../proto/ai_agent.proto) — API definitions

## Next Steps

- Read [ARCHITECTURE.md](../docs/ARCHITECTURE.md) to understand the system design
- Check [docs/](../docs/) for detailed documentation
- Start coding by following [CONTRIBUTING.md](../CONTRIBUTING.md)
- Review the [gRPC contract](../proto/ai_agent.proto)

## Getting Help

- 📖 Read the [documentation](../docs/)
- 🐛 Check [existing issues](https://github.com/arksong/amos/issues)
- 💬 Open a [discussion](https://github.com/arksong/amos/discussions)
- 📧 Email: arksong2018@gmail.com

Happy coding! 🚀
