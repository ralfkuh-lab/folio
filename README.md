# folio-rs

Cross-platform Markdown viewer — Tauri/Rust port of [Folio](https://github.com/fsrakul/Folio).

## Status

Migration in progress. See [`MIGRATION_LOG.md`](MIGRATION_LOG.md).

## Supported Platforms

- Windows (MSI)
- Linux (AppImage / deb)
- macOS (Stretch goal)

## Build

### Prerequisites

- Rust stable (latest)
- Node.js LTS
- `cargo install tauri-cli --version "^2"`

### Linux Build Dependencies

```bash
sudo apt-get install -y libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev \
  libayatana-appindicator3-dev patchelf
```

### Run

```bash
cargo tauri dev
```

### Build

```bash
# Linux AppImage
cargo tauri build --target x86_64-unknown-linux-gnu

# Windows MSI (cross-compile or Windows runner)
cargo tauri build --target x86_64-pc-windows-msvc
```
