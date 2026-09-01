# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- New features and enhancements in development

### Changed
- Modifications to existing features

### Fixed
- Bug fixes

### Deprecated
- Features planned for removal

### Removed
- Features removed from the project

### Security
- Security-related changes and patches

## [0.1.0] - 2025-09-01

### Added
- Initial release with core architecture
- AI daemon (amos-ai) with gRPC server over UDS
- Tauri 2 System UI (amos-tauri) as gRPC client
- Window manager state machine (amos-wm)
- Protocol buffer definitions (amos-proto)
- Waydroid/APK compatibility layer (amos-android)
- CI/CD workflow with GitHub Actions
- Comprehensive documentation

### Notes
- This is the initial beta release
- API and architecture subject to change before 1.0

---

## Template for new releases

When creating a new release:

1. Update version numbers in `Cargo.toml` across all crates
2. Update version in `tauri.conf.json`
3. Add corresponding section below with:
   - Date in YYYY-MM-DD format
   - Clear categorization of changes
   - Links to related issues/PRs
4. Update any affected documentation

### Commit message format:

```
chore(release): v0.X.Y

- Brief description of major features
- Link to release notes
```

### Release checklist:

- [ ] All tests passing (`make test`)
- [ ] All linting clean (`make lint`)
- [ ] CHANGELOG.md updated
- [ ] Version numbers updated
- [ ] Documentation updated if needed
- [ ] Security audit completed
- [ ] Tagged in git: `git tag v0.X.Y`
- [ ] GitHub release created with release notes
