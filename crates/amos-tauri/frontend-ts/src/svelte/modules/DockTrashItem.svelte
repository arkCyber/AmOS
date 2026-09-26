<script lang="ts">
  /**
   * DockTrashItem.svelte — the 🗑️ tile at the end of the dock (after the separator).
   *
   * **Audit finding (fixed here):** this tile used to be a live button whose handler was
   * `if (id === "trash") return;` — a control that looks pressable, is announced as
   * pressable, and does nothing when pressed (FMEA F-SH-001, the same shape as the
   * control centre in REQ-A261).
   *
   * It then spent one round **greyed** (REQ-A455 shipped the trash itself, so the old
   * "there is no trash view" reason had stopped being true and was corrected rather than
   * left standing — a reason that has expired sends the reader looking for a feature that
   * already exists). The reason it stayed disabled was a claim about the *window route*:
   * "`wm_open(label)` carries a label and nothing else, so a Dock tile cannot open *the
   * trash pane* of another window's screen."
   *
   * **That claim was true about `wm_open` and false about the shell (REQ-A783).** The label
   * was never the whole channel: the cross-window reveal intent (REQ-A458) already carries a
   * destination *inside* the target window through the shared store, and a destination is all
   * a trash tile needs. So the tile is now live and does what macOS's trash tile does —
   * `openFilesAt("trash")` records the view, `wmOpen("files")` creates-or-focuses the window,
   * and the Files screen lands on its trash pane and clears the intent. Write-then-open is the
   * required order: a window that does not exist yet seeds its store subscription from what is
   * already stored.
   */
  import { wmOpenReported } from "../../lib/wm";
  import { openFilesAt } from "../appLinks";
  import { t } from "../locale.svelte";
  import DockTileButton from "./DockTileButton.svelte";
  import IconTrash from "../../assets/icons/IconTrash.svelte";

  /**
   * Record the destination, then open the window (both, and in this order — see the header).
   *
   * The answer is **read, not discarded**. A refused store write is not merely a diagnostic here:
   * the window still opens, but on whatever view it was last on — the user pressed 🗑️ and got
   * "Files", which is the exact outcome that kept this tile greyed for a round. `write:scan`
   * makes that a gate rather than a matter of taste (a function that returns a result exists to
   * be answered), and the breadcrumb names what was lost. Files still opens either way: the user
   * asked for a window, and a window is what they can get — refusing to open it would turn a
   * partly-served request into an unserved one.
   */
  function openTrash() {
    if (!openFilesAt("trash")) {
      console.warn("🛟 [Dock] could not queue the trash view (store refused); opening Files as-is");
    }
    void wmOpenReported("files", "Dock");
  }
</script>

<DockTileButton
  label={t("desktop.trash")}
  testId="dock-trash"
  icon={IconTrash}
  onclick={openTrash}
/>
