<script lang="ts">
  /**
   * DockTrashItem.svelte — the 🗑️ tile at the end of the dock (after the separator).
   *
   * **Audit finding (fixed here):** this tile used to be a live button whose handler was
   * `if (id === "trash") return;` — a control that looks pressable, is announced as
   * pressable, and does nothing when pressed (FMEA F-SH-001, the same shape as the
   * control centre in REQ-A261).
   *
   * The trash **now exists** (REQ-A455: `amos.files.trash` + the Files screen's trash view,
   * with 「放回原处」/「永久删除」/「清空废纸篓」), so the old reason for greying it — "there is
   * no trash view, so 'empty the trash' would have nothing to act on" — is no longer true
   * and was corrected rather than left standing.
   *
   * It is still greyed, for a reason that is **not** about the feature: the host's window
   * route is `wm_open(label)` and carries a label and nothing else, so a Dock tile cannot
   * open *the trash pane* of another window's screen (the same limitation documented on the
   * Dock's 「显示设置」 row, which opens Settings but cannot land on the Dock pane). A tile
   * that opens Files' ordinary view when the user asked for the trash would be worse than a
   * tile that says where the trash is — so it renders the way macOS renders an unavailable
   * command: **visible and greyed**, with a name that says where to look.
   */
  import { t } from "../locale.svelte";
  import DockTileButton from "./DockTileButton.svelte";
  import IconTrash from "../../assets/icons/IconTrash.svelte";
</script>

<DockTileButton
  label={t("desktop.trashInFiles")}
  testId="dock-trash"
  icon={IconTrash}
  onclick={() => {}}
  disabled={true}
/>