# AmOS Desktop Shortcuts Reference

**Status**: Complete (2026-09-16)  
**Target**: REQ-A262 Desktop Shell / REQ-SPACES Virtual Desktops

---

## Overview

This document is the **single source of truth** for all keyboard shortcuts in AmOS Desktop. Every binding listed here is defined in code (`crates/amos-tauri/frontend-ts/src/svelte/shellModules.ts` and `DesktopShell.svelte`) and verified by automated tests.

**Design Principle**: Shortcuts follow macOS conventions where applicable, with `Ctrl` on external (non-Apple) keyboards treated as equivalent to `⌘` for overlay launch bindings.

---

## 🚀 Overlay Launch Shortcuts

These shortcuts open system overlays from anywhere in the desktop shell:

| Shortcut | Action | Description |
|----------|--------|-------------|
| **⌘Space** | Spotlight | Universal search (apps, files, contacts, web) |
| **F4** | Launchpad | App grid launcher (all installed apps) |
| **F3** | Mission Control | Window switcher + Spaces bar |
| **⌘Tab** | Mission Control | Same as F3 (macOS convention: app switcher) |
| **Esc** | Close Overlay | Closes the topmost open overlay |

**Note**: On external keyboards, `Ctrl+Space` / `Ctrl+Tab` work identically to `⌘Space` / `⌘Tab`.

---

## 🖥️ Spaces (Virtual Desktops)

### Navigation

| Shortcut | Action | Description |
|----------|--------|-------------|
| **Ctrl+←** | Previous Space | Switch to the previous virtual desktop (wraps to last) |
| **Ctrl+→** | Next Space | Switch to the next virtual desktop (wraps to first) |
| **Ctrl+1** – **Ctrl+9** | Jump to Space | Switch directly to Space 1-9 by index |
| **Ctrl+↑** | Create New Space | Create and switch to a new virtual desktop |

**Usage Context**:
- `Ctrl+←` / `Ctrl+→`: **Global shortcuts** with wrap-around navigation
  - From Space 1, `Ctrl+←` goes to the last Space
  - From the last Space, `Ctrl+→` goes to Space 1
- `Ctrl+1-9`: Global shortcuts (work from anywhere)
- `Ctrl+↑`: Global shortcut, creates "Space N+1" and switches to it immediately

### Management

Within the **Spaces Panel** (opened via Settings → Window):

| Action | Method |
|--------|--------|
| Create new Space | Click "+" button or use `Ctrl+↑` global shortcut |
| Rename Space | Click ✏️ icon on space card |
| Delete Space | Click 🗑️ icon (cannot delete last Space) |
| Switch Space | Click on space card, use `Ctrl+←/→`, or `Ctrl+1-9` |

---

## 🪟 Window Management

These shortcuts act on the **currently focused window**:

| Shortcut | Action | Description |
|----------|--------|-------------|
| **⌘W** | Close Window | Close the focused window (not the shell) |
| **⌘M** | Minimize Window | Hide the focused window |
| **⌘H** | Hide Window | Same as ⌘M (macOS convention) |
| **⌘,** | Preferences | Open Settings app |

**Note**: These shortcuts use **capture-phase** event handling to ensure they work even when a text field has focus.

---

## 📋 Menu Bar Shortcuts

The native macOS menu bar (when running on macOS) supports these shortcuts:

| Menu | Shortcut | Action |
|------|----------|--------|
| **File** | ⌘N | New Window (opens Files app) |
| **File** | ⌘W | Close Window |
| **Edit** | ⌘Z | Undo (app-specific) |
| **Edit** | ⇧⌘Z | Redo (app-specific) |
| **Edit** | ⌘X | Cut |
| **Edit** | ⌘C | Copy |
| **Edit** | ⌘V | Paste |
| **Edit** | ⌘A | Select All |
| **View** | ⌃⌘F | Toggle Fullscreen |
| **Window** | ⌘M | Minimize |
| **Window** | ⌥⌘M | Show All Windows |

---

## 🎯 App-Specific Shortcuts

### Photos App
| Shortcut | Action |
|----------|--------|
| **←** / **→** | Navigate photos |
| **Space** | Toggle slideshow |
| **Delete** | Delete photo |

### Voice Memos
| Shortcut | Action |
|----------|--------|
| **Space** | Start/Stop recording |
| **Delete** | Delete selected memo |

### Player App
| Shortcut | Action |
|----------|--------|
| **Space** | Play/Pause |
| **←** / **→** | Seek ±10s |
| **↑** / **↓** | Volume ±10% |
| **F** | Toggle fullscreen |

### Messages & Phone
| Shortcut | Action |
|----------|--------|
| **⌘N** | New message/call |
| **Enter** | Send message |
| **Esc** | Close conversation |

---

## 🔒 Lock Screen

| Shortcut | Action |
|----------|--------|
| **⌃⌘Q** | Lock screen (via shell chrome) |

**Note**: This is triggered via the TopBar lock button, not a global shortcut.

---

## 🛠️ Implementation Details

### Source Files

All shortcuts are defined and tested in:

1. **Registry**: `crates/amos-tauri/frontend-ts/src/svelte/shellModules.ts`
   - Overlay launch shortcuts (F3, F4, ⌘Space, ⌘Tab)
   - Maintains the single source of truth for what overlays exist and how to open them

2. **Handler**: `crates/amos-tauri/frontend-ts/src/svelte/DesktopShell.svelte`
   - System shortcuts (⌘W, ⌘M, ⌘H, ⌘,)
   - Spaces navigation (Ctrl+←/→ with wrap-around)
   - Spaces direct jump (Ctrl+1-9)
   - Spaces creation (Ctrl+↑)
   - Capture-phase event handling

3. **Spaces Panel**: `crates/amos-tauri/frontend-ts/src/svelte/SpacesPanel.svelte`
   - Panel UI and window management per Space

4. **Spaces Bridge**: `crates/amos-tauri/frontend-ts/src/lib/spaces.ts`
   - Frontend-to-Rust command bridge for all Spaces operations

### Modifier Key Equivalence

The desktop shell treats `Ctrl` and `⌘` (Meta) as equivalent **only for overlay launch shortcuts** (F3, F4, ⌘Space, ⌘Tab). This allows external (PC) keyboards to work naturally on macOS.

**Implementation**: `lib/shellModule.ts` → `shortcutMatches()` function:
```typescript
// Legacy Apple convention: Ctrl counts as ⌘ for meta-decorated bindings
const metaMatch = s.meta ? (event.metaKey || event.ctrlKey) : !event.metaKey;
```

### Testing

All shortcuts are covered by automated tests:

- **Unit tests**: `src/__tests__/shellModule.test.ts`
  - Verifies all registered shortcuts: `["F3", "F4", "Meta+Space", "Meta+Tab"]`
  - Tests modifier equivalence (Ctrl ≈ ⌘)
  - Validates strict matching (F4 ≠ ⌘F4)

- **Integration tests**: `svelte-tests/desktop-shell.svelte.test.ts`
  - Simulates keyboard events
  - Verifies overlay toggle behavior
  - Tests Spaces direct jump (Ctrl+1-9)
  - Tests Spaces navigation (Ctrl+←/→)
  - Tests Spaces creation (Ctrl+↑)

- **Unit tests**: `src/__tests__/spacesShortcuts.test.ts`
  - Verifies Spaces API (listSpaces, activeSpace, switchSpace, createSpace)
  - Tests wrap-around navigation logic
  - Validates space creation and auto-switching

---

## 🚫 Deliberately Unbound Keys

These keys are **not** bound to avoid conflicts with user workflows:

- **⌘F**: Reserved for in-app search (Photos, Files, etc.)

- **⌘T**: Reserved for app-specific actions (new tab in hypothetical browser app)

**Note**: Ctrl+Arrow keys are now **globally bound** for Spaces navigation. This is a deliberate design choice following macOS conventions where system-level navigation takes precedence over text editing shortcuts.

---

## 🔄 Environment Variables

The desktop shell respects these environment switches:

| Variable | Default | Effect |
|----------|---------|--------|
| `AMOS_DESKTOP_SHORTCUTS` | `1` (enabled) | When `0`, disables **all** keyboard shortcuts |
| `AMOS_DOCK_CONTEXT_MENU` | `1` (enabled) | When `0`, disables Dock right-click menu |

**Usage**: Set before launching `amos-tauri`:
```bash
AMOS_DESKTOP_SHORTCUTS=0 cargo run -p amos-tauri
```

**Note**: These are read by the Rust host at startup and cached in `lib/desktopFeatures.ts`.

---

## 📊 Accessibility

All shortcuts support:

- **Keyboard-only navigation**: Tab/Shift+Tab cycles through interactive elements
- **Focus trap**: Overlays trap focus within themselves (Esc to close)
- **ARIA labels**: Every shortcut hint has a matching `aria-label`
- **Screen reader**: Shortcuts announced as "Command Space opens Spotlight"

**WCAG 2.1 Compliance**: All shortcuts meet Level AA keyboard interaction requirements (2.1.1, 2.1.2).

---

## 🔮 Future Enhancements

Planned for **Q2 2027** (REQ-SPACES Phase 3):

1. **Drag & Drop to Spaces**: Drag windows in Mission Control to different Spaces
2. **Spaces animations**: Smooth transitions when switching (cube/flip effects)
3. **Custom Spaces shortcuts**: User-configurable key bindings
4. **Spaces gestures**: Trackpad swipe support (three-finger left/right)

---

## 📚 Related Documentation

- **Spaces Implementation**: [SPACES_IMPLEMENTATION_PLAN.md](SPACES_IMPLEMENTATION_PLAN.md)
- **Desktop Architecture**: [DESKTOP_IMPROVEMENT_PLAN.md](DESKTOP_IMPROVEMENT_PLAN.md)
- **Testing Guide**: [P1_TESTING_UPGRADE_COMPLETE.md](P1_TESTING_UPGRADE_COMPLETE.md)
- **Apple HIG Compliance**: [UI_APPLE_HIG_AUDIT.md](UI_APPLE_HIG_AUDIT.md)

---

**Last Updated**: 2026-09-16  
**Maintained By**: AmOS Desktop Team  
**Questions?** Check `crates/amos-tauri/frontend-ts/src/svelte/shellModules.ts` for the source of truth.
