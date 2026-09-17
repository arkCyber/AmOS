<script lang="ts">
  /**
   * DockTrashItem.svelte — the 🗑️ tile at the end of the dock (after the separator).
   *
   * **Audit finding (fixed here):** this tile used to be a live button whose handler was
   * `if (id === "trash") return;` — a control that looks pressable, is announced as
   * pressable, and does nothing when pressed (FMEA F-SH-001, the same shape as the
   * control centre in REQ-A261). There is no Trash to open: the Files screen has no
   * trash view and the desktop has no filesystem view, so an "empty the trash" action
   * would have nothing to act on.
   *
   * So it renders the way macOS renders an unavailable command — **visible and greyed**,
   * with a name that says why. It stays in the dock (a Mac always shows it, and its
   * position is the one thing that makes the dock's grouping legible), and when a trash
   * view exists this one file gains an intent.
   */
  import { t } from "../locale.svelte";
  import DockTileButton from "./DockTileButton.svelte";
  import IconTrash from "../../assets/icons/IconTrash.svelte";
</script>

<DockTileButton
  label={t("desktop.trashUnavailable")}
  testId="dock-trash"
  icon={IconTrash}
  onclick={() => {}}
  disabled={true}
/>