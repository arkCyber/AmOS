<script lang="ts">
  // WallpaperPage.svelte — 「壁纸」sub page. Stacks the existing home wallpaper and
  // lock-screen wallpaper pickers (both keep their own persistent store + upload).
  import WallpaperCard from "../WallpaperCard.svelte";
  import LockWallpaperCard from "../LockWallpaperCard.svelte";

  // WallpaperCard / LockWallpaperCard already render their own titled group cards
  // (「壁纸」/「锁屏背景」) — we only lay them out here.
</script>

<div class="space-y-5">
  <WallpaperCard />
  <LockWallpaperCard />
</div>
