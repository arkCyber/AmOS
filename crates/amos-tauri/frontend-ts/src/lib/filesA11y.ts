/**
 * filesA11y.ts — Accessibility helpers for FilesApp (keyboard navigation,
 * focus management, ARIA state). Pure functions + one side-effect hook for
 * keyboard events.
 */

export interface A11yNavState {
  /** Currently focused entry ID (null = no focus) */
  focusedId: string | null;
  /** All visible entry IDs in display order */
  visibleIds: readonly string[];
}

/**
 * Given current focus and a direction, return the next focused ID.
 * Returns `null` if there's nowhere to go (e.g., at start and pressing Up).
 */
export function navNext(
  state: A11yNavState,
  dir: "up" | "down" | "home" | "end",
): string | null {
  const { focusedId, visibleIds } = state;
  if (visibleIds.length === 0) return null;

  if (dir === "home") return visibleIds[0] ?? null;
  if (dir === "end") return visibleIds[visibleIds.length - 1] ?? null;

  const idx = focusedId ? visibleIds.indexOf(focusedId) : -1;
  
  if (dir === "up") {
    if (idx <= 0) return focusedId; // stay at first or no focus
    return visibleIds[idx - 1] ?? null;
  }
  
  // dir === "down"
  if (idx < 0) return visibleIds[0] ?? null; // no focus → focus first
  if (idx >= visibleIds.length - 1) return focusedId; // stay at last
  return visibleIds[idx + 1] ?? null;
}

/**
 * Keyboard event handler factory for file list navigation.
 * Returns a handler that calls the provided callbacks based on key presses.
 */
export interface KeyboardCallbacks {
  onNav: (dir: "up" | "down" | "home" | "end") => void;
  onOpen: () => void; // Enter on focused item
  onDelete: () => void; // Delete/Backspace on focused item
  onToggle: () => void; // Space to toggle selection (if selecting mode)
  onSelectAll: () => void; // Cmd/Ctrl+A
}

export function createKeyboardHandler(
  callbacks: KeyboardCallbacks,
): (e: KeyboardEvent) => void {
  return (e: KeyboardEvent) => {
    // Ignore if user is typing in an input/textarea
    const target = e.target as HTMLElement;
    if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") {
      return;
    }

    const { key, metaKey, ctrlKey } = e;
    const mod = metaKey || ctrlKey;

    switch (key) {
      case "ArrowUp":
        e.preventDefault();
        callbacks.onNav("up");
        break;
      case "ArrowDown":
        e.preventDefault();
        callbacks.onNav("down");
        break;
      case "Home":
        e.preventDefault();
        callbacks.onNav("home");
        break;
      case "End":
        e.preventDefault();
        callbacks.onNav("end");
        break;
      case "Enter":
        e.preventDefault();
        callbacks.onOpen();
        break;
      case "Delete":
      case "Backspace":
        e.preventDefault();
        callbacks.onDelete();
        break;
      case " ":
        e.preventDefault();
        callbacks.onToggle();
        break;
      case "a":
      case "A":
        if (mod) {
          e.preventDefault();
          callbacks.onSelectAll();
        }
        break;
    }
  };
}

/**
 * Scroll an element into view if it's not fully visible.
 * Used after keyboard navigation to ensure the focused item is on screen.
 * 
 * Note: Uses a cross-browser compatible approach to check visibility
 * before scrolling, avoiding unnecessary scroll operations.
 */
export function scrollIntoViewIfNeeded(
  element: HTMLElement | null,
): void {
  if (!element) return;
  
  const parent = element.parentElement;
  if (!parent) {
    element.scrollIntoView({ block: "nearest", behavior: "smooth" });
    return;
  }
  
  const parentRect = parent.getBoundingClientRect();
  const elementRect = element.getBoundingClientRect();
  
  // Check if element is fully visible within parent
  const isVisible = 
    elementRect.top >= parentRect.top &&
    elementRect.bottom <= parentRect.bottom &&
    elementRect.left >= parentRect.left &&
    elementRect.right <= parentRect.right;
  
  if (!isVisible) {
    element.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
}

/**
 * Generate an ARIA label for a file/folder entry.
 */
export function entryAriaLabel(
  name: string,
  type: "file" | "folder",
  isFavorite: boolean,
  isSelected: boolean,
  timestamp: number,
): string {
  const parts: string[] = [];
  parts.push(type === "folder" ? "Folder" : "File");
  parts.push(name);
  if (isFavorite) parts.push("(favorite)");
  if (isSelected) parts.push("(selected)");
  // Include timestamp for screen readers
  const date = new Date(timestamp);
  parts.push(`modified ${date.toLocaleDateString()}`);
  return parts.join(" ");
}
