/**
 * a11y-name.ts — accessible-name lookup for the Svelte suite (REQ-A283).
 *
 * After the Settings rows were converted to the shared row primitives (`Field.svelte` +
 * `ToggleRow`/`ChoiceRow`), a control's name comes from `aria-labelledby` → the row's
 * *visible* label element, not from a hand-written `aria-label` string. Tests that located a
 * control by its `aria-label` attribute therefore broke on a change that made the UI **more**
 * accessible — so they now locate by name, which is the property the a11y audit is about.
 *
 * This resolves the three mechanisms the audit accepts, in accname precedence order:
 * `aria-label`, `aria-labelledby` (the referenced elements' text), `<label for=…>`.
 * It is intentionally small: not a full accname implementation (no name-from-content or
 * `aria-hidden` pruning), because the suite only needs "which control carries this name".
 */
export function accessibleName(el: Element): string {
  const label = el.getAttribute("aria-label");
  if (label && label.trim()) return label.trim();
  const ref = el.getAttribute("aria-labelledby");
  if (ref) {
    const text = ref
      .split(/\s+/)
      .map((id) => {
        const src = el.ownerDocument.getElementById(id);
        return src ? visibleText(src) : "";
      })
      .join(" ")
      .trim();
    if (text) return text;
  }
  const id = el.id;
  if (id) {
    const text = visibleText(
      el.ownerDocument.querySelector(`label[for="${id}"]`),
    ).trim();
    if (text) return text;
  }
  return "";
}

/**
 * The text a screen reader would read from `el`: `aria-hidden="true"` subtrees are decoration
 * and are skipped. This matters for rows with a leading glyph (`ToggleRow`'s `icon="🛡️"`), where
 * `textContent` would return `"🛡️ 外发网闸"` while the accessible name is `"外发网闸"`.
 */
function visibleText(el: Element | null): string {
  if (!el) return "";
  let out = "";
  for (const node of [...el.childNodes]) {
    if (node.nodeType === 3) out += node.textContent ?? "";
    else if (node.nodeType === 1 && node instanceof Element) {
      if (node.getAttribute("aria-hidden") === "true") continue;
      out += visibleText(node);
    }
  }
  return out;
}

/** The first element matching `selector` whose accessible name is `name` (`undefined` if none). */
export function controlByName<T extends Element>(
  root: ParentNode,
  selector: string,
  name: string,
): T | undefined {
  return [...root.querySelectorAll<T>(selector)].find((el) => accessibleName(el) === name);
}
