// amos-device.swift — see and drive the **real** Amos UI on this machine (REQ-A486).
//
// Why this lives in the repository: it was written twice, from scratch, in `/tmp`
// (`/tmp/amos_ax.swift`, `/tmp/amos_drag.swift`) by the two device-verification rounds that found
// most of this session's real defects — the class rule whose x/y never reached a window, the
// debounced store with no poller, a context menu whose lower rows were clipped away, and a native
// menu bar advertising a key the shell no longer matched. Each time the *instrument* was the thing
// that made the defect visible, and each time it was thrown away with the session. A reading that
// cannot be re-run is not evidence, which is what this file fixes.
//
// Two capabilities, one program, because they are used together (dump the tree, then act on what
// you found):
//
//   * **`ax`** — walk the Accessibility tree of a running process: role, title, description, value,
//     frame, **enabled**, and (for menu items) the **key equivalent**. The shell is a webview, so
//     this reaches the DOM: a Dock tile or a context-menu row can be located *by name* and its
//     frame read, which is how every click in those rounds was aimed.
//   * **`click` / `rclick` / `double` / `drag`** — post real pointer events into the HID tap, i.e.
//     the same path a human's trackpad takes (AX can only *set* a window's position; it cannot
//     drag).
//   * **`press`** — activate a control through the Accessibility action (what VoiceOver does),
//     bypassing the pointer path. This is how "the handler works but the row is off-screen" was
//     told apart from "the handler is broken".
//
// Two lessons this file carries in its comments, because both cost a round:
//
//   * **An AX frame is DOM layout, not what the window shows.** A context menu's rows were reported
//     at y=913 while the window ended at 909: the frames were honest and the rows were invisible
//     (F-DEV-069).
//   * **A key equivalent is not in the title.** `AXMenuItemCmdChar` + `AXMenuItemCmdModifiers` are
//     the only reading of what the menu bar advertises (REQ-A485).
//
// usage: amos-device <command> [args]        (run through `make device-tool ARGS='…'`, or
//                                             `bash scripts/device.sh …` so the binary is built)
//   ax   [process] [filter] [maxDepth] [--min-width N] [--role R]
//   press <process> <substring> [--min-width N] [--role R]
//   click <x> <y> | rclick <x> <y> | double <x> <y>
//   drag <x1> <y1> <x2> <y2> [steps]
//   --selftest
import AppKit
import ApplicationServices
import Foundation

// MARK: - pure helpers (the `--selftest` half)

/// AppKit's `AXMenuItemCmdModifiers` bitmask → the words a keycap uses.
///
/// Bit 3 (8) means **no Command** — the mask is "modifiers" only for the *other* three, so a row
/// with `Cmd+Shift+N` reads as 0|1 = 1 and a row with `Shift+N` alone reads as 8|1 = 9. Getting this
/// backwards would report every plain ⌘-chord as unmodified, which is exactly the kind of silent
/// wrongness this tool exists to remove.
func modifierWords(_ mask: Int) -> [String] {
    var words: [String] = []
    if (mask & 8) == 0 { words.append("Cmd") }
    if (mask & 1) != 0 { words.append("Shift") }
    if (mask & 2) != 0 { words.append("Alt") }
    if (mask & 4) != 0 { words.append("Ctrl") }
    return words
}

/// The whole reading of a menu item's key equivalent, in one place.
func keyEquivalentText(char: String?, glyph: NSNumber?, mask: NSNumber?) -> String {
    if char == nil, glyph == nil, mask == nil { return "" }
    var parts = modifierWords(mask?.intValue ?? 0)
    if let c = char, !c.isEmpty { parts.append(c) }
    if let g = glyph { parts.append("glyph(\(g.intValue))") }
    return parts.joined(separator: "+")
}

/// Points and sizes are printed as integers: a frame that moves by a fraction of a point is noise,
/// and the comparisons this tool is used for (which row is above which, does the panel fit) are
/// about whole points.
func frameText(_ pos: CGPoint?, _ size: CGSize?) -> String {
    guard let p = pos, let s = size else { return "" }
    return "pos=(\(Int(p.x)),\(Int(p.y))) size=(\(Int(s.width))x\(Int(s.height)))"
}

func usage() -> String {
    """
    usage: amos-device <command> [args]
      ax   [process] [filter] [maxDepth] [--min-width N] [--role R] [--visible]
      press <process> <substring> [--role R] [--min-width N] [--exact] [--index N] [--near X,Y]
      activate <process>     (bring it to the front — needed before clicking its window)
      scroll <x> <y> <lines> (bring content that is laid out off-screen into the window)
      click <x> <y> | rclick <x> <y> | double <x> <y>
      key <chord>            (cmd+shift+n, ⌘⇧N, ctrl+alt+delete, f4, esc …)
      drag <x1> <y1> <x2> <y2> [steps]
      --selftest
    """
}

// MARK: - AX reading

func attr(_ el: AXUIElement, _ name: String) -> Any? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(el, name as CFString, &value) == .success else { return nil }
    return value
}

func str(_ el: AXUIElement, _ name: String) -> String {
    guard let v = attr(el, name) else { return "" }
    if let s = v as? String { return s }
    if let n = v as? NSNumber { return n.stringValue }
    return ""
}

func point(_ el: AXUIElement, _ name: String) -> CGPoint? {
    guard let v = attr(el, name), CFGetTypeID(v as CFTypeRef) == AXValueGetTypeID() else { return nil }
    var p = CGPoint.zero
    if AXValueGetValue(v as! AXValue, .cgPoint, &p) { return p }
    return nil
}

func size(_ el: AXUIElement, _ name: String) -> CGSize? {
    guard let v = attr(el, name), CFGetTypeID(v as CFTypeRef) == AXValueGetTypeID() else { return nil }
    var s = CGSize.zero
    if AXValueGetValue(v as! AXValue, .cgSize, &s) { return s }
    return nil
}

/// Resolve `process` (a name like `Amos`, or a pid) to a pid.
func pidFor(_ target: String) -> pid_t? {
    if let n = pid_t(target) { return n }
    for app in NSWorkspace.shared.runningApplications where app.localizedName == target {
        return app.processIdentifier
    }
    return nil
}

/// Walk the tree, printing every node that matches `filter` (or all of them).
func dumpAX(pid: pid_t, filter: String, maxDepth: Int, minWidth: Double, roleFilter: String?, visibleOnly: Bool = false) -> Int32 {
    let app = AXUIElementCreateApplication(pid)
    // The process's windows, for `--visible`: a node whose frame misses all of them is laid out but
    // scrolled out of sight (see `isVisible`).
    let windows: [CGRect] = ((attr(app, kAXWindowsAttribute) as? [AXUIElement]) ?? []).compactMap { w in
        guard let p = point(w, kAXPositionAttribute), let s = size(w, kAXSizeAttribute) else { return nil }
        return CGRect(origin: p, size: s)
    }
    var visited = 0
    var printed = 0
    var offscreen = 0
    func walk(_ el: AXUIElement, _ depth: Int) {
        if depth > maxDepth { return }
        visited += 1
        let role = str(el, kAXRoleAttribute)
        let title = str(el, kAXTitleAttribute)
        let desc = str(el, kAXDescriptionAttribute)
        let value = str(el, kAXValueAttribute)
        let hay = [role, title, desc, value].joined(separator: " ")
        let pos = point(el, kAXPositionAttribute)
        let frame = size(el, kAXSizeAttribute)
        let box: CGRect? = (pos != nil && frame != nil)
            ? CGRect(origin: pos!, size: frame!)
            : nil
        let visible = isVisible(box, in: windows)
        if !visible { offscreen += 1 }
        let matches = (filter.isEmpty || hay.localizedCaseInsensitiveContains(filter))
            && (frame?.width ?? 0) >= minWidth
            && (roleFilter == nil || role == roleFilter)
            && (!visibleOnly || visible)
        if matches {
            let enabled = (attr(el, kAXEnabledAttribute) as? NSNumber)?.boolValue
            let state = enabled == nil ? "" : (enabled! ? " enabled" : " DISABLED")
            let key = keyEquivalentText(
                char: attr(el, "AXMenuItemCmdChar") as? String,
                glyph: attr(el, "AXMenuItemCmdGlyph") as? NSNumber,
                mask: attr(el, "AXMenuItemCmdModifiers") as? NSNumber
            )
            let keyNote = key.isEmpty ? "" : "  keyEquivalent=\(key)"
            print(
                "\(String(repeating: "  ", count: depth))\(role) title=\"\(title)\" desc=\"\(desc)\" "
                    + "value=\"\(value.prefix(40))\" \(frameText(point(el, kAXPositionAttribute), frame))\(state)\(keyNote)"
            )
            printed += 1
        }
        guard let kids = attr(el, kAXChildrenAttribute) as? [AXUIElement] else { return }
        for k in kids { walk(k, depth + 1) }
    }
    walk(AXUIElementCreateApplication(pid), 0)
    let offscreenNote = offscreen > 0
        ? " (\(offscreen) laid out off-screen — `--visible` hides those, `scroll` brings them in)"
        : ""
    FileHandle.standardError.write(
        "amos-device: \(visited) node(s) visited, \(printed) printed\(offscreenNote); windows=\(windows.count)\n"
            .data(using: .utf8)!
    )
    return 0
}

/// One candidate a `press` could act on: what it is, and where it sits.
///
/// `fields` are kept separately from `text` because the two options need different questions answered:
/// a **substring** search over the joined text, and an **exact** match against one field (comparing the
/// joined string would never equal a bare title — that bug was caught by this struct's own selftest).
struct PressCandidate {
    let role: String
    let title: String
    let fields: [String]
    let frame: CGRect?

    var text: String { fields.joined(separator: " ") }

    /// `--exact`: does any single field equal the needle (case-insensitively)?
    func matchesExactly(_ needle: String) -> Bool {
        fields.contains { $0.compare(needle, options: .caseInsensitive) == .orderedSame }
    }
}

/// The centre of a frame, or `nil` when the node reports none.
func centre(_ frame: CGRect?) -> CGPoint? {
    guard let frame else { return nil }
    return CGPoint(x: frame.midX, y: frame.midY)
}

/// Plain Euclidean distance; a missing frame is infinitely far, so a node that *has* a frame always
/// wins a `--near` choice (a node without one cannot be chosen by `--near` — stated in the usage).
func distance(_ a: CGPoint?, _ b: CGPoint) -> Double {
    guard let a else { return .infinity }
    return ((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y)).squareRoot()
}

/// Which candidate `press` should act on (REQ-A493).
///
/// `press` took the **first** match in walk order. That is fine until two controls share a name — and
/// the real UI does: the keyboard page has sixteen identical ✕ buttons, and the settings toolbar has a
/// 「重置全部」 beside a dialog's 「重置」. Twice that meant the instrument pressed the *wrong* control
/// and reported success, which is worse than finding nothing: the reading then looks like a product
/// result. The options mirror the three ways out of an ambiguity:
///
/// * default — first match (historical behaviour, and still the right default);
/// * `exact` — the whole haystack must equal the needle (for "重置" vs "重置全部");
/// * `index` — the n-th match in **document order** (the order the AX walk visits), for repeats;
/// * `near` — the match whose **centre** is closest to a point, for "the one in the dialog".
///
/// `nil` means "nothing matched under these options": the caller reports that instead of pressing
/// something else.
func selectCandidate(
    _ candidates: [PressCandidate],
    needle: String,
    exact: Bool = false,
    index: Int? = nil,
    near: CGPoint? = nil
) -> Int? {
    var matches: [Int] = []
    for (i, c) in candidates.enumerated() {
        let hit = exact
            ? c.matchesExactly(needle)
            : c.text.localizedCaseInsensitiveContains(needle)
        if hit { matches.append(i) }
    }
    guard !matches.isEmpty else { return nil }
    if let near {
        // Ties keep document order, so repeating the same reading gives the same answer.
        var best = matches[0]
        var bestDistance = distance(centre(candidates[best].frame), near)
        for i in matches.dropFirst() {
            let d = distance(centre(candidates[i].frame), near)
            if d < bestDistance {
                best = i
                bestDistance = d
            }
        }
        return best
    }
    let wanted = index ?? 0
    guard wanted >= 0, wanted < matches.count else { return nil }
    return matches[wanted]
}

/// Activate the first matching control through the accessibility action.
///
/// The walk collects **candidates** (values + frames) in document order, `selectCandidate` picks one,
/// and a second walk of the same order gives back the element to act on — the same order by
/// construction, so the choice cannot drift from the node. When more than one control matches, the
/// reading says so (`chose 1 of N matches`): an ambiguous press is still *reported* as ambiguous.
func press(
    pid: pid_t,
    needle: String,
    minWidth: Double,
    roleFilter: String?,
    exact: Bool = false,
    index: Int? = nil,
    near: CGPoint? = nil
) -> Int32 {
    func consider(_ el: AXUIElement) -> PressCandidate? {
        let role = str(el, kAXRoleAttribute)
        let sz = size(el, kAXSizeAttribute) ?? .zero
        guard sz.width >= minWidth, roleFilter == nil || role == roleFilter else { return nil }
        let pos = point(el, kAXPositionAttribute)
        return PressCandidate(
            role: role,
            title: str(el, kAXTitleAttribute),
            fields: [
                role, str(el, kAXTitleAttribute), str(el, kAXDescriptionAttribute),
                str(el, kAXValueAttribute),
            ],
            frame: pos != nil ? CGRect(origin: pos!, size: sz) : nil
        )
    }
    func walk(_ el: AXUIElement, _ depth: Int, _ visit: (AXUIElement) -> Void) {
        if depth > 20 { return }
        visit(el)
        guard let kids = attr(el, kAXChildrenAttribute) as? [AXUIElement] else { return }
        for k in kids { walk(k, depth + 1, visit) }
    }

    let app = AXUIElementCreateApplication(pid)
    var candidates: [PressCandidate] = []
    walk(app, 0) { el in
        if let c = consider(el) { candidates.append(c) }
    }
    let hitCount = candidates.filter {
        exact ? $0.matchesExactly(needle) : $0.text.localizedCaseInsensitiveContains(needle)
    }.count
    guard let chosen = selectCandidate(
        candidates, needle: needle, exact: exact, index: index, near: near
    ) else {
        FileHandle.standardError.write(
            ("amos-device: no node matching '\(needle)' (min-width \(minWidth)"
                + "\(roleFilter.map { ", role \($0)" } ?? "")\(exact ? ", --exact" : "")"
                + "\(index.map { ", --index \($0)" } ?? "")"
                + "\(near.map { ", --near \(Int($0.x)),\(Int($0.y))" } ?? "")"
                + "); \(candidates.count) node(s) considered\n"
            ).data(using: .utf8)!
        )
        return 1
    }
    var nodes: [AXUIElement] = []
    walk(app, 0) { el in
        if consider(el) != nil { nodes.append(el) }
    }
    guard chosen < nodes.count else { return 1 }
    let label = "\(candidates[chosen].role) \(candidates[chosen].title)"
    let note = hitCount > 1 ? " (chose 1 of \(hitCount) matches)" : ""
    let ok = AXUIElementPerformAction(nodes[chosen], kAXPressAction as CFString)
    print("pressed \(label)\(note) -> \(ok == .success ? "AXPRESS OK" : "error \(ok.rawValue)")")
    return ok == .success ? 0 : 1
}

// MARK: - pointer driving (the path a human's trackpad takes)

func post(_ type: CGEventType, _ p: CGPoint, _ button: CGMouseButton = .left) {
    let e = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: p, mouseButton: button)
    e?.post(tap: .cghidEventTap)
}

func click(_ p: CGPoint, right: Bool = false, settleUs: UInt32 = 80_000) {
    post(.mouseMoved, p)
    usleep(settleUs)
    if right {
        post(.rightMouseDown, p, .right)
        usleep(60_000)
        post(.rightMouseUp, p, .right)
    } else {
        post(.leftMouseDown, p)
        usleep(60_000)
        post(.leftMouseUp, p)
    }
}

func drag(_ from: CGPoint, _ to: CGPoint, steps: Int) {
    post(.mouseMoved, from)
    usleep(150_000)
    post(.leftMouseDown, from)
    usleep(150_000)
    for i in 1...max(steps, 1) {
        let t = Double(i) / Double(max(steps, 1))
        post(.leftMouseDragged, CGPoint(x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t))
        usleep(25_000)
    }
    usleep(150_000)
    post(.leftMouseUp, to)
}

// MARK: - key events (the other half of driving: this tool could click but not type)

/// A chord as text → the virtual keycode plus the flags a human's fingers would set.
///
/// Pure, so the key table is testable without a device — the same split the rest of this file uses,
/// and the reason it exists: **every device verification in this repository is about chords**
/// (REQ-A484 the menu hints, REQ-A485 the native bar's accelerators, REQ-A487 the disabled row), and
/// none of them could be *pressed* on the device before this. Reading a label is not pressing a key.
///
/// Grammar: `+`-separated, case-insensitive, modifiers in any order and any mix of words/symbols
/// (`cmd+shift+n`, `⌘⇧N`, `ctrl+alt+delete`). A **modifier-only** chord is refused rather than
/// posting a bare modifier press: it would change the state of the machine's modifiers and look like
/// a success (the "instrument that reports a result without acting" family).
func parseChord(_ text: String) -> (key: CGKeyCode, flags: CGEventFlags)? {
    var flags: CGEventFlags = []
    var code: CGKeyCode?
    // Split on `+` first, then peel glyph modifiers off each token's characters: that is what makes
    // **both** spellings work — `cmd+shift+n` (three tokens) and `⌘⇧N` (one token, no separators).
    // The single-token form was in this function's own doc-comment, usage text and selftest before it
    // was in the code; the selftest is what caught the difference (`FAIL: glyph form ⌘⇧N`).
    for raw in text.lowercased().split(separator: "+") {
        var name = ""
        for ch in raw {
            switch ch {
            case "⌘": flags.insert(.maskCommand)
            case "⇧": flags.insert(.maskShift)
            case "⌥": flags.insert(.maskAlternate)
            case "⌃": flags.insert(.maskControl)
            default: name.append(ch)
            }
        }
        let token = name.trimmingCharacters(in: .whitespaces)
        if token.isEmpty { continue }
        switch token {
        case "cmd", "command", "meta": flags.insert(.maskCommand)
        case "shift": flags.insert(.maskShift)
        case "alt", "option": flags.insert(.maskAlternate)
        case "ctrl", "control", "ctl": flags.insert(.maskControl)
        // Two keys in one chord (`a+b` without a modifier between them) is a typo, not a chord.
        default:
            guard let found = KEYCODES[token], code == nil else { return nil }
            code = found
        }
    }
    guard let keyCode = code else { return nil }
    return (keyCode, flags)
}

/// macOS virtual keycodes (`kVK_*`) for the keys a desktop shortcut can name.
///
/// The numbers are the IOKit constants, spelled out because this file has no IOKit import; the
/// selftest pins the ones the shell actually binds (letters, digits, `,`, `\`, `[`, `]`, space, the
/// arrows, F1–F12) so a typo in this table fails in `make lint` instead of pressing the wrong key.
let KEYCODES: [String: CGKeyCode] = [
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
    "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17,
    "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27,
    "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "l": 37, "j": 38,
    "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44, "n": 45, "m": 46, ".": 47, "`": 50,
    "space": 49, "return": 36, "enter": 36, "tab": 48, "esc": 53, "escape": 53,
    "delete": 51, "backspace": 51, "forwarddelete": 117,
    "left": 123, "right": 124, "down": 125, "up": 126,
    "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
    "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100,
    "f9": 101, "f10": 109, "f11": 103, "f12": 111,
]

/// Post a chord into the HID tap: key down, a human-length hold, key up — all with the modifiers
/// held, which is how the window server sees a real ⌘-chord (flags on the key event, not a separate
/// modifier press; a chord that sets flags only on the way down leaves the up-stroke unmodified and
/// some apps read that as a different chord).
func key(_ chord: String, holdUs: UInt32 = 45_000) -> Int32 {
    guard let (code, flags) = parseChord(chord) else {
        FileHandle.standardError.write(
            "amos-device: '\(chord)' is not a chord — see `key` in the usage (a modifier alone presses nothing)\n"
                .data(using: .utf8)!
        )
        return 2
    }
    let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true)
    down?.flags = flags
    down?.post(tap: .cghidEventTap)
    usleep(holdUs)
    let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false)
    up?.flags = flags
    up?.post(tap: .cghidEventTap)
    return 0
}

/// Bring a process to the front, the way clicking its Dock icon does.
///
/// Needed because of a **macOS rule this tool had no way to satisfy**: a click on the content of an
/// *inactive* window is consumed by activation unless the view opts into `acceptsFirstMouse` — so a
/// single synthetic click on a background app's webview does nothing, and it looks exactly like a
/// click that missed. Measured on the Settings window: `click` on a row's ✕ reported success and the
/// row did not change; with `activate` first, the same click works. (The Dock was never affected:
/// its tiles are always interactive, which is why this went unnoticed until the tool drove a window.)
func activate(_ target: String) -> Int32 {
    guard let pid = pidFor(target) else { return 2 }
    guard let app = NSRunningApplication(processIdentifier: pid) else { return 2 }
    let ok = app.activate(options: [.activateAllWindows])
    print("activate \(target) pid=\(pid) -> \(ok ? "frontmost" : "refused")")
    return ok ? 0 : 1
}

/// Do two global rectangles overlap? (The pure half of `--visible`.)
func rectIntersects(_ a: CGRect, _ b: CGRect) -> Bool { a.intersects(b) }

/// A node is **visible** when its frame meets at least one of the process's windows.
///
/// `nil` means "this node reports no frame" (layout containers do): those are not filtered, because
/// the tree stays readable and the *children* carry the frames. This is the measured lesson from
/// driving the Settings window (REQ-A489): inside a scrolled web view, AX reports **document**
/// coordinates — the 隐藏应用 row of the keyboard page came back at y=945 while the window ended at
/// y=790, i.e. honest frames describing something that was scrolled out of sight. A reader that
/// acts on such a frame clicks outside the window, and the click silently does nothing.
func isVisible(_ frame: CGRect?, in windows: [CGRect]) -> Bool {
    guard let frame else { return true }
    return windows.contains { rectIntersects(frame, $0) }
}

/// The wheel delta for `lines` of scrolling: **negative is down** (the content moves up).
///
/// Extracted so the sign is testable without a device — getting it backwards scrolls the wrong way,
/// which on a long settings page looks like "the click did nothing" all over again.
func scrollDelta(lines: Int) -> Int32 { Int32(-lines * 40) }

/// Scroll the view under (x, y) — the wheel event a trackpad would send there.
///
/// Exists because of the same lesson: a row whose AX frame is below the window's bottom edge is not
/// reachable by `click` at all, so "read the frames, then act on them" needs a way to bring the
/// content into the window. `lines` is positive to scroll down.
func scroll(_ p: CGPoint, lines: Int, settleUs: UInt32 = 60_000) {
    post(.mouseMoved, p)
    usleep(settleUs)
    let event = CGEvent(
        scrollWheelEvent2Source: nil,
        units: .pixel,
        wheelCount: 1,
        wheel1: scrollDelta(lines: lines),
        wheel2: 0,
        wheel3: 0
    )
    event?.post(tap: .cghidEventTap)
    usleep(settleUs)
}

// MARK: - selftest (the device-free half, wired into `make lint`)

/// The pure readings only: modifier decoding, key-equivalent text, frame text, and the argument
/// shape. Anything that needs a running app or a real pointer stays out of this — the same split
/// `scripts/device-ui-eval.mjs --selftest` follows for the Android tool (a gate must not need a
/// device).
func runSelftest() -> Int32 {
    var failures = 0
    func ok(_ name: String, _ cond: Bool) {
        if !cond {
            print("FAIL: \(name)")
            failures += 1
        }
    }

    // A plain ⌘-chord has bit 3 **clear** (that bit means "no Command"), which is the reading that
    // makes `Cmd+N` come out as `Cmd+N` rather than as an unmodified key.
    ok("plain command", modifierWords(0) == ["Cmd"])
    ok("command+shift", modifierWords(1) == ["Cmd", "Shift"])
    ok("shift alone (bit 3 set)", modifierWords(9) == ["Shift"])
    ok("command+option", modifierWords(2) == ["Cmd", "Alt"])
    ok("command+control", modifierWords(4) == ["Cmd", "Ctrl"])
    ok("everything", modifierWords(7) == ["Cmd", "Shift", "Alt", "Ctrl"])

    ok("key equivalent text", keyEquivalentText(char: "N", glyph: nil, mask: 0) == "Cmd+N")
    ok("shifted key equivalent", keyEquivalentText(char: "N", glyph: nil, mask: 1) == "Cmd+Shift+N")
    ok("glyph-only row keeps the glyph", keyEquivalentText(char: nil, glyph: 3, mask: 0) == "Cmd+glyph(3)")
    ok("an item with no chord reads as nothing", keyEquivalentText(char: nil, glyph: nil, mask: nil) == "")

    ok(
        "frame text is whole points",
        frameText(CGPoint(x: 10.4, y: 20.6), CGSize(width: 30.2, height: 40.9)) == "pos=(10,20) size=(30x40)"
    )
    ok("a missing frame prints nothing", frameText(nil, nil) == "")

    ok(
        "usage names every command",
        usage().contains("press") && usage().contains("drag") && usage().contains("--selftest")
            && usage().contains("key <chord>") && usage().contains("activate") && usage().contains("scroll") && usage().contains("--visible")
    )

    // REQ-A489 — the key table and the chord grammar. The shell's own bindings are what these pin:
    // a wrong keycode would press *something else* while reporting success.
    ok("cmd+n", parseChord("cmd+n")?.key == 45 && parseChord("cmd+n")?.flags == [.maskCommand])
    ok("shift+cmd+n is order-insensitive",
       parseChord("shift+cmd+n")?.flags == [.maskCommand, .maskShift])
    ok("glyph form ⌘⇧N", parseChord("⌘⇧N")?.key == 45
        && parseChord("⌘⇧N")?.flags == [.maskCommand, .maskShift])
    ok("the shell's own chords",
       parseChord("cmd+w")?.key == 13 && parseChord("cmd+m")?.key == 46
           && parseChord("cmd+h")?.key == 4 && parseChord("cmd+,")?.key == 43
           && parseChord("cmd+\\")?.key == 42 && parseChord("cmd+space")?.key == 49
           && parseChord("cmd+[")?.key == 33 && parseChord("ctrl+1")?.key == 18
           && parseChord("ctrl+down")?.key == 125)
    // The F-keys separately, because two of them are what the overlays are bound to: F3 (Mission
    // Control) and F4 (Launchpad). No `|| true` here — an assertion that cannot fail is decoration.
    ok("F3 and F4 are distinct keycodes", parseChord("f3")?.key == 99 && parseChord("f4")?.key == 118)
    ok("alt counts as option", parseChord("alt+h")?.flags == [.maskAlternate])
    ok("a bare key has no flags", parseChord("f4")?.flags == [] && parseChord("esc")?.key == 53)
    ok("a modifier alone is not a chord", parseChord("cmd") == nil && parseChord("⌘") == nil)
    ok("two keys in one chord is a typo", parseChord("cmd+a+b") == nil)
    ok("an unknown key is refused, not guessed", parseChord("cmd+nope") == nil
        && parseChord("") == nil && parseChord("+") == nil)

    // REQ-A489 — `--visible`: the numbers are the ones this round *measured* on the Settings window
    // (AXWindow "设置" pos=(236,70) size=(1024x720) ⇒ its bottom edge is y=790; the keyboard page's
    // 隐藏应用 row came back at pos=(268,945) size=(60x19), i.e. honest frames describing content
    // scrolled out of sight). Acting on such a frame clicks outside the window and does nothing —
    // which is exactly what happened before `--visible` and `scroll` existed.
    let settingsWindow = CGRect(x: 236, y: 70, width: 1024, height: 720)
    let offscreenRow = CGRect(x: 268, y: 945, width: 60, height: 19)
    let onscreenRow = CGRect(x: 252, y: 234, width: 783, height: 36)
    ok("a row below the window's bottom edge is not visible",
       !isVisible(offscreenRow, in: [settingsWindow]))
    ok("a row inside the window is visible", isVisible(onscreenRow, in: [settingsWindow]))
    ok("a node without a frame is not filtered (containers carry no frame)",
       isVisible(nil, in: [settingsWindow]))
    ok("no windows at all ⇒ nothing is visible", !isVisible(offscreenRow, in: []))
    ok("scrolling down moves the content up", scrollDelta(lines: 3) < 0)

    // REQ-A493 — which control `press` acts on. The fixture is the real ambiguity this round hit: a
    // toolbar 「重置全部」 beside a dialog 「重置」, and three identical ✕ buttons in document order.
    let fixture: [PressCandidate] = [
        PressCandidate(role: "AXButton", title: "重置全部", fields: ["AXButton", "重置全部", "", ""],
                       frame: CGRect(x: 1162, y: 236, width: 76, height: 32)),
        PressCandidate(role: "AXButton", title: "✕", fields: ["AXButton", "✕", "", ""],
                       frame: CGRect(x: 1202, y: 330, width: 21, height: 25)),
        PressCandidate(role: "AXButton", title: "✕", fields: ["AXButton", "✕", "", ""],
                       frame: CGRect(x: 1202, y: 382, width: 21, height: 25)),
        PressCandidate(role: "AXButton", title: "✕", fields: ["AXButton", "✕", "", ""],
                       frame: CGRect(x: 1202, y: 434, width: 21, height: 25)),
        PressCandidate(role: "AXButton", title: "重置", fields: ["AXButton", "重置", "", ""],
                       frame: CGRect(x: 856, y: 458, width: 65, height: 37)),
        PressCandidate(role: "AXStaticText", title: "", fields: ["AXStaticText", "", "没有边框", ""],
                       frame: nil),
    ]
    ok("the default is still the first match (document order)",
       selectCandidate(fixture, needle: "重置") == 0)
    ok("--exact separates 重置 from 重置全部",
       selectCandidate(fixture, needle: "重置", exact: true) == 4)
    ok("--index picks the n-th repeat", selectCandidate(fixture, needle: "✕", index: 2) == 3)
    ok("--index past the end is 'nothing matched', not the last one",
       selectCandidate(fixture, needle: "✕", index: 9) == nil)
    ok("--near picks the nearest match by centre",
       selectCandidate(fixture, needle: "重置", near: CGPoint(x: 888, y: 476)) == 4)
    ok("--near alone flips the default: nearest to the toolbar coordinate picks the toolbar row",
       selectCandidate(fixture, needle: "重置", near: CGPoint(x: 1200, y: 250)) == 0)
    ok("--exact makes the toolbar row unmatchable, so the dialog row is the only answer",
       selectCandidate(fixture, needle: "重置", exact: true, near: CGPoint(x: 1200, y: 250)) == 4)
    ok("a frameless node loses --near to a framed one (both match 'AX')",
       selectCandidate(fixture, needle: "AX", near: CGPoint(x: 1202, y: 330)) != 5)
    ok("…but it can still be chosen when it is the only match",
       selectCandidate(fixture, needle: "没有边框", near: CGPoint(x: 0, y: 0)) == 5)
    ok("no match at all is nil", selectCandidate(fixture, needle: "不存在") == nil)

    if failures == 0 {
        print("amos-device --selftest: all assertions passed")
    }
    return failures == 0 ? 0 : 1
}

// MARK: - entry point
//
// `@main` rather than top-level statements: Swift only treats top-level code as the entry point in
// a file named `main.swift`, and this file is not one. Measured 2026-09-19: compiled as it was, the
// binary linked an empty main — it exited 0 and printed nothing, so `--selftest` "passed" while
// testing nothing. (The wrapper also refuses a silent selftest: a gate that cannot tell "the tool
// says OK" from "the tool says nothing" is not a gate.)
@main
struct AmosDevice {
    static func main() {
        let args = Array(CommandLine.arguments.dropFirst())
        guard let command = args.first else {
            FileHandle.standardError.write((usage() + "\n").data(using: .utf8)!)
            exit(2)
        }

        /// `--min-width N` / `--role R` may appear anywhere after the command; the positional arguments are
        /// everything else, in order.
        func option(_ name: String, in args: [String]) -> String? {
            guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
            return args[i + 1]
        }

        /// `--flag` options are dropped wherever they appear; `--opt value` options also drop their value.
        func positional(_ args: [String], skipping options: [String], flags: [String] = []) -> [String] {
            var out: [String] = []
            var skipNext = false
            for a in args {
                if skipNext {
                    skipNext = false
                    continue
                }
                if options.contains(a) {
                    skipNext = true
                    continue
                }
                if flags.contains(a) { continue }
                out.append(a)
            }
            return out
        }

        let minWidth = Double(option("--min-width", in: args) ?? "") ?? 1.0
        let roleFilter = option("--role", in: args)
        let visibleOnly = args.contains("--visible")
        let rest = Array(
            positional(
                args,
                skipping: ["--min-width", "--role", "--index", "--near"],
                flags: ["--exact", "--visible"]
            ).dropFirst()
        )
        let exactMatch = args.contains("--exact")
        let indexOption = option("--index", in: args).flatMap { Int($0) }
        let nearOption: CGPoint? = option("--near", in: args).flatMap { raw in
            let parts = raw.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
            guard parts.count == 2, let x = Double(parts[0]), let y = Double(parts[1]) else { return nil }
            return CGPoint(x: x, y: y)
        }

        func noProcess(_ target: String) -> Never {
            FileHandle.standardError.write("amos-device: no running process '\(target)'\n".data(using: .utf8)!)
            exit(2)
        }

        switch command {
        case "--selftest":
            exit(runSelftest())

        case "ax":
            let target = rest.first ?? "Amos"
            guard let pid = pidFor(target) else { noProcess(target) }
            let filter = rest.count > 1 ? rest[1] : ""
            let depth = rest.count > 2 ? (Int(rest[2]) ?? 12) : 12
            exit(dumpAX(
                pid: pid, filter: filter, maxDepth: depth, minWidth: minWidth,
                roleFilter: roleFilter, visibleOnly: visibleOnly
            ))

        case "press":
            guard rest.count > 1 else {
                FileHandle.standardError.write((usage() + "\n").data(using: .utf8)!)
                exit(2)
            }
            guard let pid = pidFor(rest[0]) else { noProcess(rest[0]) }
            exit(
                press(
                    pid: pid, needle: rest[1], minWidth: minWidth, roleFilter: roleFilter,
                    exact: exactMatch, index: indexOption, near: nearOption
                )
            )

        case "click", "rclick", "double":
            guard rest.count >= 2, let x = Double(rest[0]), let y = Double(rest[1]) else {
                FileHandle.standardError.write("amos-device: \(command) needs <x> <y>\n".data(using: .utf8)!)
                exit(2)
            }
            let p = CGPoint(x: x, y: y)
            if command == "rclick" {
                click(p, right: true)
            } else if command == "double" {
                click(p)
                usleep(120_000) // under macOS's double-click interval, so the two land as one gesture
                click(p)
            } else {
                click(p)
            }
            print("\(command) at (\(Int(x)),\(Int(y)))")

        case "scroll":
            guard rest.count >= 3, let x = Double(rest[0]), let y = Double(rest[1]),
                  let lines = Int(rest[2]) else {
                FileHandle.standardError.write("amos-device: scroll needs <x> <y> <lines>\n".data(using: .utf8)!)
                exit(2)
            }
            scroll(CGPoint(x: x, y: y), lines: lines)
            print("scrolled \(lines) line(s) at (\(Int(x)),\(Int(y)))")

        case "activate":
            guard let target = rest.first else {
                FileHandle.standardError.write((usage() + "\n").data(using: .utf8)!)
                exit(2)
            }
            guard pidFor(target) != nil else { noProcess(target) }
            exit(activate(target))

        case "key":
            guard let chord = rest.first else {
                FileHandle.standardError.write((usage() + "\n").data(using: .utf8)!)
                exit(2)
            }
            let status = key(chord)
            if status == 0 { print("key \(chord)") }
            exit(status)

        case "drag":
            guard rest.count >= 4, let x1 = Double(rest[0]), let y1 = Double(rest[1]),
                  let x2 = Double(rest[2]), let y2 = Double(rest[3]) else {
                FileHandle.standardError.write("amos-device: drag needs <x1> <y1> <x2> <y2> [steps]\n".data(using: .utf8)!)
                exit(2)
            }
            let steps = rest.count > 4 ? (Int(rest[4]) ?? 20) : 20
            drag(CGPoint(x: x1, y: y1), CGPoint(x: x2, y: y2), steps: steps)
            print("dragged (\(Int(x1)),\(Int(y1))) -> (\(Int(x2)),\(Int(y2))) in \(steps) steps")

        default:
            FileHandle.standardError.write(
                "amos-device: unknown command '\(command)'\n\(usage())\n".data(using: .utf8)!
            )
            exit(2)
        }
    }
}
