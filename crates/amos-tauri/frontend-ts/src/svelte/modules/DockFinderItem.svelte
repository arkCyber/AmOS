<script lang="ts">
  /**
   * DockFinderItem.svelte — the 💻 tile in the dock (macOS's Finder position: first
   * system item after the apps).
   *
   * Its action is `wm_open("files")`, which the host defines as **create + focus** — so
   * the container no longer has to decide "open or focus" by polling the window list
   * before the click (it used to: the same fact the host already owns was duplicated in
   * the frontend). What the container still needs from the window list is only the
   * *running dot*, and the registry row supplies the window label for it
   * (`windowLabel: "files"`), not the widget id.
   */
  import { invoke } from "../../lib/backend";
  import { t } from "../locale.svelte";
  import DockTileButton from "./DockTileButton.svelte";
  import IconFinder from "../../assets/icons/IconFinder.svelte";

  /** `wm_open` = create + focus; a failure is recorded in the diagnostics ledger by
   * `lib/backend` and needs no handler here. */
  function openFinder() {
    void invoke("wm_open", { label: "files" });
  }
</script>

<DockTileButton
  label={t("desktop.finder")}
  testId="dock-finder"
  icon={IconFinder}
  onclick={openFinder}
/>