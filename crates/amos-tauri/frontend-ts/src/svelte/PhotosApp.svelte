<script lang="ts">
  // PhotosApp.svelte — Svelte 5 (runes) implementation of the photo library.
  // Still-photo logic reuses pure lib/photos.ts; camera video tiles use
  // lib/cameraCapture (no React VideoThumb thumbnail here → 🎬 tile with
  // duration/res; playback overlay still streams the MediaStore blob).
  // Registered as the `photos` screen in `appRegistry.ts` (the older "not yet wired
  // into COMPONENTS" note was stale — the React-era map is long gone).
  import {
    PHOTOS_KEY,
    favsOf,
    groupDays,
    isRealPhoto,
    knownTs,
    neighborOf,
    newCapturePhoto,
    newPhoto,
    normalizePhotos,
    removePhoto,
    removePhotos,
    seedPhotos,
    setFavs,
    shareCaption,
    toggleFav,
  } from "../lib/photos";
  import type { Photo } from "../lib/photos";
  // The edit model (REQ-A1147): a plain value whose reducers are pure, so the screen holds it
  // in `$state` and the headless suite tests it without a DOM. `previewTransform`/`filterCss`
  // are what the on-screen preview is styled with **and** what `drawEdited` writes, so the
  // saved file cannot drift from what the user saw.
  import {
    ADJUST_MAX,
    ADJUST_MIN,
    FILTERS,
    FULL_CROP,
    defaultEdit,
    drawEdited,
    exportEditedDataUrl,
    filterCss,
    flipEdit,
    isNoop,
    moveCrop,
    previewTransform,
    resizeCrop,
    rotateEdit,
    rotatedSize,
    setAdjust,
    setCrop,
    // Aliased: this screen already has its own `setFilter` for the All/♥/🎬 library chips.
    setFilter as setFilterKind,
  } from "../lib/photoEdit";
  import type { CropHandle, FilterKind, PhotoEdit } from "../lib/photoEdit";
  import { localId } from "../lib/localId";
  import { CAPTURES_KEY, captureBlob, listCaptures, normalizeCaptures, removeVideoCapture, resLabelOf, toggleCaptureFav } from "../lib/cameraCapture";
  import type { VideoCapture } from "../lib/cameraCapture";
  import { copyTextToClipboard } from "../lib/clipboard";
  import { readStoreValue, writeStoreValue, writeStoreValueChecked } from "../lib/amosStore";
  import StoreErrorBar from "./StoreErrorBar.svelte";
  import { createStoreValue } from "./store";
  import LazyImage from "./components/LazyImage.svelte";
  import { iconSvg } from "../lib/sysIcons";
  import { fmtTime } from "../lib/notes";
  import { hasMediaBridge, mediaList, mediaGrantRead, mediaLoad, mediaStreamUrl, newestFirst } from "../lib/media";
  import type { MediaItem } from "../lib/media";
  // 原生照片是**分页**读的（REQ-A502）：宿主 `media_list(collection)` 返回**整段集合**
  // （实测：没有 cursor / page size / total），所以"分页"是我们自己的切片 —— 规则与理由写在
  // `lib/mediaPaging.ts` 头部。一次只画一页，用户按「加载更多」再取下一页：一台有几万张照片的
  // 设备不会再一次性渲染几万个格子。
  import {
    canLoadMore,
    emptyPaging,
    fetchInto,
    pageOf,
    remainingTotal,
    type PagingState,
  } from "../lib/mediaPaging";
  import { isNativePhoto, nativePhotoFromItem } from "../lib/photoLibrary";
  import type { NativePhoto } from "../lib/photoLibrary";
  // The write half of the media domain (REQ-A352): the camera's own album is a private
  // store, so exporting to the user-visible camera roll is a real, explicit side effect.
  import {
    blobBytes,
    bytesToDataUrl,
    CAMERA_EXPORT_DIR,
    dataUrlMime,
    dataUrlToBytes,
    exportNameFor,
    exportToSharedCollection,
  } from "../lib/mediaExport";
  // The viewer's zoom/pan model (REQ-A1147): pure arithmetic, so the gesture set is decided
  // headlessly and this screen only maps pointer events onto it.
  import {
    MAX_ZOOM,
    MIN_ZOOM,
    clampPan,
    defaultView,
    fitScale,
    isZoomed,
    panBy,
    toggleZoom,
    zoomAt,
  } from "../lib/photoView";
  import type { Size, View, ViewBox } from "../lib/photoView";
  import type { ExportOutcome } from "../lib/mediaExport";
  import { t } from "./locale.svelte";
  import { photosChannel } from "./appLinks";
  import { currentFormFactor } from "../lib/formAuthority.svelte";
  import { photosCols } from "../lib/formLayout";

  // Demo seed — **only when the key is absent**: an emptied library stays empty.
  const seed = ((): Photo[] => {
    const raw = readStoreValue<unknown>(PHOTOS_KEY, undefined);
    if (raw !== undefined) return normalizePhotos(raw);
    const s = seedPhotos(8, Date.now());
    writeStoreValue(PHOTOS_KEY, s);
    return s;
  })();

  // （REQ-A1354 ∕ F-SH-618）`amos.photos` 不止这一个写入者：本页自己的动词（`add` ∕ 删除 ∕
  // 批量收藏 ∕ 编辑器的「存储」…）走 `persist()`，而相机快门（`CameraApp.doCapture`）把同一张
  // 照片写进**同一个相册**，再由它底部那张刚拍缩略图调 `openPhoto(last.id)`（`appLinks.openPhoto`）
  // —— 它写下 `photos` 深链频道**并且**打开本应用，即它点名要**这一页**展示刚存下的东西。
  //
  // 平板上两者同台：Photos 是台面、相机在 **Slide Over** 面板里（或作为分屏的第二格）。此时
  // `open("photos")` 提交的仍是同一个 `{kind:"app", id:"photos"}`（分屏下更被 `isSplittablePair`
  // 直接拒绝），没有东西会重挂 —— 于是「只读一次」的代价是：快门说了「已保存到相册」，而拥有这些
  // 照片的相册成了最后一个知道的人：列表停在打开那一刻，下面深链自己的
  // `list.find((p) => p.id === v.photoId)` 在这份陈旧数组里找不到那个刚生成的 id，一本正经地判定
  // 这张照片不存在。用与 `amos.settings` 那九个活读者同一条 `createStoreValue` 原语订阅，让列表
  // **就是**存储本身。
  //
  // 回退值取 `seed` 本身，而不是 `[]`：订阅在挂载时会**同步**投递一次当前值，而 seed 在没有键时
  // 写下这批演示照片 —— 若那次写被拒（存储满），键始终是空的，用 `[]` 作回退会让这次投递把刚种下
  // 的相册清空；用 `seed` 作回退，屏幕上仍是那批演示照片（与写被拒前一致）。
  const photosStore = createStoreValue<unknown>(PHOTOS_KEY, seed);
  let list = $state<Photo[]>(seed);
  $effect(() => {
    const un = photosStore.subscribe((v) => (list = normalizePhotos(v)));
    return un;
  });
  let sel = $state<Photo | null>(null);
  let wallMsg = $state("");
  // An export is in flight: the button is disabled so a second tap cannot start a second
  // write (and cannot produce two outcome lines for one action).
  let expBusy = $state(false);
  let slide = $state(false);
  let favOnly = $state(false);
  let vidsOnly = $state(false);
  // （REQ-A1466 ∕ F-SH-735）`amos.captures` 是相册的**录像**那一半，写入者同样不止本页：
  // 相机（`CameraApp.persistVideoCapture` ∕ `removeVideoCapture`）在平板上与本页同台（相
  // 机在 Slide Over 面板里），一次录制或删除写完这枚键，本页不会重挂 —— 于是「只读一次」
  // 的代价是 `🎬 (N)` 与视频格子一直描述着打开那一刻的库：刚存的录像不出现，刚删的录像仍
  // 留着一个点了会报「录像不存在」的格子。这与上一段 `amos.photos` 是同一件事的两个键、
  // 同一屏的两张脸，那条修复（REQ-A1354）只扫了照片那一半，漏了同文件里的这个兄弟键。
  // 用同一条 `createStoreValue` 原语订阅：回退值取当前读数，挂载时同步投递的这次与初始值一致。
  const capturesStore = createStoreValue<unknown>(CAPTURES_KEY, listCaptures());
  let vids = $state<VideoCapture[]>(listCaptures());
  $effect(() => {
    const un = capturesStore.subscribe((v) => (vids = normalizeCaptures(v)));
    return un;
  });
  // The store refused a write (full/unavailable): say so and keep showing the truth.
  let storeErr = $state("");
  let playId = $state<string | null>(null);
  let playUrl = $state("");
  /** Why a recording is not playing: its bytes are gone, or this build cannot play them. */
  let playErr = $state("");
  // ---- Photo editing (REQ-A1147) ----
  // `edit` is the whole edit; the preview and the saved canvas are both rendered from it,
  // so the file cannot drift from what the user saw. Nothing is written until 存储.
  let editing = $state(false);
  let edit = $state<PhotoEdit>(defaultEdit());
  let editMsg = $state("");
  let editBusy = $state(false);
  /** Natural size of the photo being edited: the crop rect is normalised, so the preview
   *  needs it to lay the rotated frame out inside the square stage. */
  let dims = $state<{ w: number; h: number } | null>(null);
  // ---- Viewer zoom / pan (REQ-A1147) ----
  // The viewer used to be a fixed 160×160 box with no way to look closer. It is now a stage
  // that fills the screen, and this is its viewport: `view` is the pure model from
  // `lib/photoView`, `viewImg`/`viewStage` are the two measurements its math needs (the
  // photo's decoded size, learned from the `<img>`'s own onload, and the stage's box).
  let view = $state<View>(defaultView());
  let viewImg = $state<Size | null>(null);
  let viewStage = $state<Size>({ w: 0, h: 0 });
  let viewStageEl = $state<HTMLElement | null>(null);
  /** The editor's source: a local photo's data URL, or a device photo's bytes once imported.
   *  Held apart from `sel` so the editor has one input whether or not the photo is local. */
  let editSrc = $state("");
  /** A device photo's host-served URL (empty until resolved, or when the host serves none). */
  let nativeUrl = $state("");
  let viewMsg = $state("");
  /** The stage's `<img>` failed: fall back to the glyph rather than an invisible broken box. */
  let viewFailed = $state(false);
  let selecting = $state(false);
  let selected = $state<ReadonlySet<string>>(new Set());
  // Native (real external-storage) stills from the media_* bridge, shown as a
  // read-only strip above the local grid (only when a bridge is present).
  let native = $state<NativePhoto[]>([]);
  const nativeShown = $derived(!favOnly && !vidsOnly && !selecting && native.length > 0);

  // The gallery grid scales with the device class (REQ-A292): iOS keeps 3 columns
  // on the phone; iPadOS Photos uses 5 columns in My Photos; the desktop class
  // widens further to `DESKTOP_MAX_COLS` so a Mac window does not look like an
  // iPad stretched out. We do NOT poll: the shell owns `form` and updates this
  // store on every `layout-changed` push (the host emits only on a real change).
  // `null` from `currentFormFactor()` is the "no host yet" state — we keep the
  // most conservative answer (the phone's 3) so a preview build stays usable.
  const form = $derived(currentFormFactor());
  const cols = $derived(photosCols(form ?? "phone"));

  // The two standard collections the gallery reads stills from.
  const NATIVE_COLLECTIONS = ["camera", "screenshots"] as const;
  // Load real stills from the bridge. Offline (no bridge) → the strip stays hidden.
  // A **real** backend error (the Rust `Unauthorized` that `media_list` surfaces as
  // a rejection) is NOT "no photos": it becomes an honest grant prompt. The pre-fix
  // code swallowed it in `allSettled`, so a permission denial looked exactly like
  // an empty gallery. Native tiles are read-only.
  let nativeLoaded = false;
  let nativeBlocked = $state(false);
  let nativeBusy = $state(false);

  /** 一页多少张（够填满一屏多；切片是我们自己的事，见 `lib/mediaPaging.ts` 头部）。 */
  const NATIVE_PAGE = 60;
  let nativePaging = $state<PagingState>(emptyPaging(NATIVE_COLLECTIONS));
  /** 宿主不报总数 ⇒ 这个数是 `pageOf` 自己数的（"还有多少张"）。 */
  const nativeRemaining = $derived(remainingTotal(nativePaging, NATIVE_COLLECTIONS));
  const nativeHasMore = $derived(canLoadMore(nativePaging, NATIVE_COLLECTIONS));
  /** 已取回的**总**张数（不只是当前页），给 "只显示最新 N 项（共 M 项）"。 */
  const nativeTotal = $derived(nativePaging.items.length + nativeRemaining);

  /** 去重（宿主可能重发同一个 uri）+ 我们这个顺序（ts desc）+ 映射成 tile。 */
  const nativeTilesOf = (items: readonly MediaItem[]): NativePhoto[] => {
    const seen = new Set<string>();
    const tiles: NativePhoto[] = [];
    for (const it of items) {
      if (seen.has(it.uri)) continue;
      seen.add(it.uri);
      tiles.push(nativePhotoFromItem(it));
    }
    tiles.sort((a, b) => b.ts - a.ts);
    return tiles;
  };

  /**
   * 取下一页（首次调用就是第一页）。
   *
   * 每一轮问的是**还没退休**的集合（空页才让一个集合退休 —— 那是"后面没有了"唯一的信号）。
   * 一次 collection 的**拒绝**（Rust 的 `Unauthorized`）绝不能渲染成"你没有照片"：它变成
   * 诚实的授权提示（`nativeBlocked`）；`fetchInto` 逐集合报告失败，我们只保留这条区分。
   */
  const loadNativePage = async () => {
    if (!hasMediaBridge() || nativeBusy) return;
    nativeBusy = true;
    let denied = false;
    const round = await fetchInto(nativePaging, NATIVE_COLLECTIONS, async (dir, after) => {
      try {
        const all = await mediaList(dir);
        if (all === null) return null; // 没有宿主（离线）—— 不是"这个集合是空的"
        // **必须先排序**：`pageOf` 切的是**我们的**总序 `(ts desc, id asc)`，而宿主只保证
        // `ts` 降序（实测：`hosts.rs`/`provider.rs` 都是 `sort_by_key(Reverse(i.ts))`，同 ts
        // 之间的顺序是目录扫描顺序，且它既不接受 cursor 也不报 total）。少了这一步，断点
        // 扫描（`afterCursor`）就会在"同 ts 的一组照片"上错位：整组要么被第二页重发一遍、
        // 要么被跳过 —— 而那看起来和一个正常的分页器一模一样，直到用户去数照片。
        return pageOf([...all].sort(newestFirst), after, NATIVE_PAGE);
      } catch (err) {
        denied = true;
        throw err;
      }
    });
    nativePaging = round.state;
    native = nativeTilesOf(round.state.items);
    nativeBlocked = denied;
    nativeBusy = false;
  };

  /** Grant read access to the collections we list, then reload. */
  const grantNative = async () => {
    if (!hasMediaBridge() || nativeBusy) return;
    nativeBusy = true;
    await Promise.allSettled(NATIVE_COLLECTIONS.map((c) => mediaGrantRead(c)));
    nativeBusy = false;
    await loadNativePage(); // the prompt clears only if the grant actually took
  };

  $effect(() => {
    if (nativeLoaded) return;
    nativeLoaded = true;
    if (!hasMediaBridge()) return;
    void loadNativePage();
  });

  const persist = (l: Photo[]): boolean => {
    if (!writeStoreValueChecked(PHOTOS_KEY, l)) {
      storeErr = t("common.storeWriteFailed");
      return false;
    }
    storeErr = "";
    list = l;
    return true;
  };
  /** Favourite a video — only a landed write may move the heart (and `vids`). */
  const favVideo = (id: string) => {
    const r = toggleCaptureFav(id);
    if (!r.ok) {
      storeErr = t("common.storeWriteFailed");
      return;
    }
    storeErr = "";
    vids = r.list;
  };
  const shown = $derived(favOnly ? favsOf(list) : list);
  const add = () => persist([newPhoto(Date.now()), ...list]);

  const toggleSelect = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    selected = next;
  };
  const toggleSelectMode = () => {
    if (vidsOnly) return; // video tiles aren't multi-selectable (their own fav)
    selected = new Set();
    selecting = !selecting;
  };
  // iOS-like Library filter: All / Favourites / Videos (smart "albums").
  const setFilter = (v: "all" | "fav" | "videos") => {
    favOnly = v === "fav";
    vidsOnly = v === "videos";
    if (selecting) {
      selected = new Set();
      selecting = false;
    }
  };
  const viewIs = (v: "all" | "fav" | "videos"): boolean =>
    v === "fav" ? favOnly : v === "videos" ? vidsOnly : !favOnly && !vidsOnly;
  const deleteSelected = () => {
    if (selected.size === 0) return;
    // The view state moves only once the write landed — the same rule the single-photo
    // `deleteSel` follows one line for line ("a refused write must not paint"), and the one
    // `toggleFavSel` was given in REQ-A1242. Both *bulk* actions were left out of that sweep:
    // they cleared the selection and left select mode whatever `persist` answered, so a
    // refused delete silently threw away a selection the user may have assembled by hand
    // (the error is shown, but re-picking twelve photos to retry is the cost).
    if (!persist(removePhotos(list, selected))) return;
    selected = new Set();
    selecting = false;
  };
  // iOS multi-select "Favourite": mark every selected photo favourited, exit.
  const batchFav = (on: boolean) => {
    if (selected.size === 0) return;
    // Same gate, same reason as `deleteSelected` above (`favVideo` and `toggleFavSel` are the
    // single-item twins of this write).
    if (!persist(setFavs(list, selected, on))) return;
    selected = new Set();
    selecting = false;
  };
  // Select All / Deselect All over the currently-shown photos (respects the
  // active ♥ filter), mirroring iOS's in-selection "Select All".
  const allShownSelected = $derived(
    selecting && shown.length > 0 && selected.size === shown.length,
  );
  const toggleSelectAll = () => {
    if (!selecting || shown.length === 0) return;
    selected = allShownSelected ? new Set() : new Set(shown.map((p) => p.id));
  };

  // Interleave stills + camera videos newest-first.
  const gallery = $derived(
    (() => {
      const out: ({ kind: "photo"; p: Photo } | { kind: "video"; v: VideoCapture })[] = [];
      // "Videos" shows only camera videos; every other view shows (filtered) stills.
      if (!vidsOnly) {
        for (const p of shown) out.push({ kind: "photo", p });
      }
      // Favourites keeps stills only; All and Videos mix in the camera library.
      const showVideos = vids.length > 0 && !selecting && !favOnly;
      if (showVideos) for (const v of vids) out.push({ kind: "video", v });
      out.sort(
        (a, b) =>
          (b.kind === "photo" ? b.p.ts : b.v.ts) - (a.kind === "photo" ? a.p.ts : a.v.ts),
      );
      return out;
    })(),
  );

  // iOS "Days" grouping: the grid is split into local-day sections with relative
  // headers (今天/昨天/日期). Pure via lib/photos groupDays; `t` keeps the labels
  // reactive to a mid-session locale switch.
  const dateLabel = (ts: number): string => {
    const d = new Date(ts);
    return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
  };
  /** A photo's timestamp for display — withheld when it is the documented unknown
   * sentinel, so neither the viewer nor a share caption prints 「1970」 for a row whose
   * date the host could not read (`knownTs`, REQ-A1852). */
  const tsText = (ts: number): string => (knownTs(ts) ? fmtTime(ts) : t("photo.unknownDate"));
  const sections = $derived.by(() => {
    const now = Date.now();
    return groupDays(
      gallery.map((it) => ({ ts: it.kind === "photo" ? it.p.ts : it.v.ts, it })),
      now,
      {
        today: t("photo.today"),
        yesterday: t("photo.yesterday"),
        date: dateLabel,
        unknown: t("photo.unknownDate"),
      },
    ).map((s) => ({ key: s.key, label: s.label, items: s.items.map((x) => x.it) }));
  });

  /**
   * Why the grid is empty — asked of the set the grid actually **draws** (`gallery`), not of the
   * local still list.
   *
   * Keying it on `list` was wrong in two directions: a library with no stills but a camera video
   * announced 暂无照片 and hid the video that exists, and a Videos view whose last clip had just
   * been deleted drew nothing at all, with no line saying why. The reason is named from the
   * active filter, so "empty" never stands in for "filtered down to nothing".
   */
  const emptyMsg = $derived(
    vidsOnly ? t("photo.videosEmpty") : favOnly ? t("photo.favEmpty") : t("photo.empty"),
  );

  const grad = (p: Photo): string | undefined =>
    p.a && p.b ? `linear-gradient(135deg, ${p.a}, ${p.b})` : undefined;
  const fmtLen = (ms: number) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  };

  // ---- Deep link: the camera's "last photo" thumbnail → this item -----------------
  // The camera's thumbnail sets the `photos` channel and opens this app; we then open the
  // viewer on that item. The link is *consumed* (channel cleared) so returning to Photos
  // never re-fires it, and an id we no longer hold is honestly ignored — the grid stays
  // what is shown, and no tile is invented (REQ-A358).
  let linkNonce = 0;
  $effect(() => {
    return photosChannel().subscribe((v) => {
      if (!v || v.photoId.trim() === "" || v.nonce === linkNonce) return;
      linkNonce = v.nonce;
      const target = list.find((p) => p.id === v.photoId);
      if (target) openLocal(target);
      photosChannel().set({ photoId: "", nonce: linkNonce });
    });
  });

  // Arrow-key navigation inside the viewer.
  $effect(() => {
    if (!sel) return;
    const cur = sel;
    const onKey = (e: KeyboardEvent) => {
      // Escape dismisses the top surface — the editor when it is open, else the viewer. Both
      // are full-screen overlays, so a keyboard user must be able to leave without a mouse.
      if (e.key === "Escape") {
        if (editing) closeEdit();
        else closeSel();
        return;
      }
      // The editor covers the viewer: an arrow key there must move the crop, not swap the
      // photo out from under the panel (which would also discard the edit in progress).
      if (editing) return;
      if (e.key === "ArrowLeft") {
        const p = neighborOf(shown, cur.id, -1);
        if (p) openLocal(p);
      } else if (e.key === "ArrowRight") {
        const n = neighborOf(shown, cur.id, 1);
        if (n) openLocal(n);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Slideshow while active.
  $effect(() => {
    if (!slide || !sel) return;
    const id = setInterval(() => {
      const nx = neighborOf(shown, sel?.id ?? "", 1);
      if (nx) openLocal(nx);
    }, 2500);
    return () => clearInterval(id);
  });

  const toggleSlide = () => (slide = !slide);
  /**
   * Show a different photo.
   *
   * `wallMsg` is a **per-photo** verdict ("已导出到相册", "已设为壁纸"), so carrying it across a
   * subject change would pin the last photo's result onto the next one. Every path that points
   * `sel` at a *different* photo goes through here; `saveEdit` deliberately does not, because
   * its message is about the photo it just created and must survive the switch.
   */
  const openLocal = (p: Photo) => {
    if (p.id === sel?.id) return;
    wallMsg = "";
    sel = p;
  };
  const closeSel = () => {
    slide = false;
    // The verdict belongs to the photo that is being dismissed — the same slot is read by the
    // video overlay, so leaving it set would show a photo's result over an unrelated video.
    wallMsg = "";
    sel = null;
  };
  /**
   * Favourite the open photo — and believe it **only when the store says so**.
   *
   * This was the one write in this file whose verdict was not consulted: `persist` was called
   * for its side effect on `list`, and `sel` was then pointed at the *intended* row regardless.
   * A refused write (full/unavailable storage) therefore flipped the heart in the viewer while
   * `list` — and the store — kept the old value, so the claim was drawn from an intent nobody
   * accepted. It is worse here than a stale row would be: the viewer is a full-screen overlay
   * and `StoreErrorBar` renders outside it, so the one notice that would have contradicted the
   * heart is behind the surface showing it. Every sibling gates (`deleteSel` `return`s on a
   * refused `persist`; `saveEdit`/`setWallpaper`/`favVideo`/`deleteVideo` likewise); this one
   * had no gate at all (REQ-A1242 / F-SH-521).
   */
  const toggleFavSel = () => {
    if (!sel) return;
    const id = sel.id;
    const toggled = toggleFav(list, id);
    if (!persist(toggled)) return; // the refusal is already reported; do not paint it
    sel = toggled.find((x) => x.id === id) ?? sel;
  };
  /**
   * Write `text` to the system clipboard, reporting whether it actually landed.
   *
   * The pre-fix code swallowed the rejection and set `photo.shared` ("已复制分享文本")
   * unconditionally, so a blocked clipboard — the normal case in a WebView without a secure
   * context — was reported to the user as a successful share (REQ-A352). A claim has to
   * follow the effect. The question now lives in one place (`lib/clipboard`) rather than being
   * re-implemented per screen: the same rule is asked by the interpreter and the AI screen.
   */
  const copyText = (text: string): Promise<boolean> => copyTextToClipboard(text);
  const shareSel = async () => {
    if (!sel) return;
    wallMsg = t((await copyText(shareCaption(sel, tsText(sel.ts)))) ? "photo.shared" : "photo.shareFailed");
  };

  /** The four export outcomes are four different things to say (REQ-A352). */
  const outcomeMsg = (o: ExportOutcome): string =>
    o === "saved"
      ? t("camera.exported")
      : o === "offline"
        ? t("camera.exportOffline")
        : o === "refused"
          ? t("camera.exportRefused")
          : t("camera.exportFailed");

  /**
   * Copy this still into the user-visible camera roll (`DCIM/Camera`) — the only way the system
   * gallery or any other app can see it (`lib/photos.ts` is a private store).
   *
   * Explicit, never automatic, and nothing is sent that we cannot name: a demo/gradient tile has
   * no pixels, so it says "no bytes to write" locally **without touching the host** — writing an
   * empty file into the user's gallery would claim a photo that is not there. The extension comes
   * from the data URL's own media type, so a PNG is not saved as `.jpg`.
   */
  const exportSel = async () => {
    if (!sel || expBusy) return;
    const p = sel;
    if (!p.data) {
      wallMsg = t("camera.exportFailed");
      return;
    }
    const bytes = dataUrlToBytes(p.data);
    if (!bytes || bytes.length === 0) {
      wallMsg = t("camera.exportFailed");
      return;
    }
    expBusy = true;
    wallMsg = t("camera.exporting");
    try {
      // The `dir` argument is passed explicitly: the service's default is the camera roll too,
      // but naming it here keeps a future default change from redirecting photos elsewhere.
      wallMsg = outcomeMsg(
        await exportToSharedCollection(
          "image",
          exportNameFor(p.ts, dataUrlMime(p.data)),
          bytes,
          CAMERA_EXPORT_DIR,
        ),
      );
    } finally {
      expBusy = false;
    }
  };

  /** The same contract for a camera video: read the recorded Blob, then write it out. */
  const exportVideo = async (id: string) => {
    if (expBusy) return;
    const cap = vids.find((x) => x.id === id);
    if (!cap) return;
    const blob = await captureBlob(id);
    const bytes = blob ? await blobBytes(blob) : null;
    if (!bytes || bytes.length === 0) {
      wallMsg = t("camera.exportFailed");
      return;
    }
    expBusy = true;
    wallMsg = t("camera.exporting");
    try {
      wallMsg = outcomeMsg(
        await exportToSharedCollection(
          "video",
          exportNameFor(cap.ts, cap.mime),
          bytes,
          CAMERA_EXPORT_DIR,
        ),
      );
    } finally {
      expBusy = false;
    }
  };
  /**
   * Set the current photo as the wallpaper.
   *
   * The write is **checked**, like every other write in this file: `writeStoreValue` is `void`,
   * so announcing 已设为壁纸 while the store refused (full/unavailable) would leave the user
   * believing their home screen changed when it did not. `sel.data` is required rather than
   * defaulted — a photo with no pixels must not blank the wallpaper.
   */
  const setWallpaper = () => {
    if (!sel?.data) return;
    const cur = readStoreValue<Record<string, unknown>>("amos.settings", {});
    if (!writeStoreValueChecked("amos.settings", { ...cur, wallpaper: sel.data })) {
      storeErr = t("common.storeWriteFailed");
      return;
    }
    storeErr = "";
    wallMsg = t("photo.setWallpaperDone");
  };
  const deleteSel = () => {
    if (!sel) return;
    if (!persist(removePhoto(list, sel.id))) return;
    // Dismiss through `closeSel`, not by clearing `sel` here: this is a way of *leaving* the
    // viewer, and leaving is what stops the slideshow. Clearing `sel` directly left `slide`
    // true, so the next photo opened would start auto-advancing with nobody asking (REQ-A1172).
    closeSel();
  };

  /* ---- Photo editor (REQ-A1147) -----------------------------------------------
   * The stage is a **square** of 100 units and the rotated frame is laid out inside it in
   * percentages, so the crop overlay needs no resize observer and no measured pixels: the
   * same numbers drive the preview, the drag math and (through `cropPx`) the saved render.
   * --------------------------------------------------------------------------- */
  const STAGE_UNITS = 100;
  const rotDims = $derived(rotatedSize(dims?.w ?? 1, dims?.h ?? 1, edit.rot));
  const previewScale = $derived(Math.min(STAGE_UNITS / rotDims.w, STAGE_UNITS / rotDims.h));
  const frameBox = $derived({ w: rotDims.w * previewScale, h: rotDims.h * previewScale });
  const framePos = $derived({
    left: (STAGE_UNITS - frameBox.w) / 2,
    top: (STAGE_UNITS - frameBox.h) / 2,
  });
  /** The source image inside the rotated frame: the same derivation `drawEdited` uses. */
  const imgBox = $derived({
    w: ((dims?.w ?? 1) / rotDims.w) * 100,
    h: ((dims?.h ?? 1) / rotDims.h) * 100,
  });
  const HANDLES: readonly CropHandle[] = ["nw", "ne", "sw", "se"];
  /** Labels built during render (not at component init) so a mid-session locale switch
   *  reaches the toolbar. */
  const adjusts = $derived([
    { key: "brightness" as const, label: t("photo.editBrightness") },
    { key: "contrast" as const, label: t("photo.editContrast") },
    { key: "saturation" as const, label: t("photo.editSaturation") },
  ]);
  const filterLabel = (f: FilterKind): string =>
    f === "mono"
      ? t("photo.editFilterMono")
      : f === "sepia"
        ? t("photo.editFilterSepia")
        : f === "vivid"
          ? t("photo.editFilterVivid")
          : t("photo.editFilterNone");
  const setAdjustKey = (key: "brightness" | "contrast" | "saturation", v: number) => {
    edit = setAdjust(edit, { [key]: v });
  };
  const handleAt = (h: CropHandle): { x: number; y: number } => ({
    x: framePos.left + (h === "ne" || h === "se" ? edit.crop.x + edit.crop.w : edit.crop.x) * frameBox.w,
    y: framePos.top + (h === "sw" || h === "se" ? edit.crop.y + edit.crop.h : edit.crop.y) * frameBox.h,
  });

  // The drag is deliberately **imperative** (listeners added on pointerdown, removed on
  // pointerup): the crop must track the pointer one-to-one at the device's own event rate,
  // and a reactive `$effect` around a live drag would re-register mid-gesture.
  let drag: { mode: "move" | CropHandle; x: number; y: number; w: number; h: number } | null = null;
  const startDrag = (ev: PointerEvent, mode: "move" | CropHandle) => {
    const frame = (ev.currentTarget as HTMLElement)
      .closest("[data-stage]")
      ?.querySelector("[data-frame]");
    const box = frame?.getBoundingClientRect();
    if (!box || box.width === 0 || box.height === 0) return;
    ev.preventDefault();
    endDrag(); // a second pointerdown must not leave the first drag's listener behind
    drag = { mode, x: ev.clientX, y: ev.clientY, w: box.width, h: box.height };
    window.addEventListener("pointermove", onDragMove);
    window.addEventListener("pointerup", endDrag);
    // A pointer the browser takes away (a touch the WebView claims for a system gesture, the
    // pointer leaving the window) fires **cancel**, never `up`. Without this the listener stayed
    // attached and `drag` stayed set, so the crop kept following the pointer with no button
    // held. The viewer's gesture block handles `pointercancel` for exactly this reason
    // (REQ-A1172).
    window.addEventListener("pointercancel", endDrag);
  };
  const onDragMove = (ev: PointerEvent) => {
    if (!drag) return;
    const dx = (ev.clientX - drag.x) / drag.w;
    const dy = (ev.clientY - drag.y) / drag.h;
    drag = { ...drag, x: ev.clientX, y: ev.clientY };
    edit =
      drag.mode === "move"
        ? { ...edit, crop: moveCrop(edit.crop, dx, dy) }
        : { ...edit, crop: resizeCrop(edit.crop, drag.mode, dx, dy) };
  };
  const endDrag = () => {
    drag = null;
    window.removeEventListener("pointermove", onDragMove);
    window.removeEventListener("pointerup", endDrag);
    window.removeEventListener("pointercancel", endDrag);
  };

  const openEdit = () => {
    if (!sel?.data) return;
    editSrc = sel.data;
    edit = defaultEdit();
    dims = null; // re-measured by the preview's own onload
    editMsg = "";
    editing = true;
  };
  const closeEdit = () => {
    // Leaving mid-drag (Escape, a stray tap on 关闭) would otherwise strand the window
    // `pointermove` listener that `startDrag` installed.
    endDrag();
    editing = false;
    editMsg = "";
  };
  const resetEdit = () => {
    edit = defaultEdit();
    editMsg = "";
  };
  const onPreviewLoad = (ev: Event) => {
    const im = ev.currentTarget as HTMLImageElement;
    if (im.naturalWidth > 0 && im.naturalHeight > 0) {
      dims = { w: im.naturalWidth, h: im.naturalHeight };
    }
  };

  /**
   * Decode a data URL for the canvas render, or `null` when it will not decode.
   *
   * The timeout is not decoration: a WebView that never fires `onload`/`onerror` for a data
   * URL would otherwise leave the save promise pending forever with the button stuck on
   * "busy". Resolving `null` turns that into the honest "this device cannot edit photos".
   */
  const loadImage = (src: string): Promise<HTMLImageElement | null> =>
    new Promise((resolve) => {
      let done = false;
      const finish = (v: HTMLImageElement | null) => {
        if (done) return;
        done = true;
        if (timer !== undefined) clearTimeout(timer);
        resolve(v);
      };
      let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => finish(null), 8000);
      try {
        const im = new Image();
        im.onload = () => finish(im);
        im.onerror = () => finish(null);
        im.src = src;
      } catch {
        finish(null);
      }
    });

  /**
   * Render the current edit into a **new** photo.
   *
   * Non-destructive by construction (REQ-A1147): the result is appended as a new record and
   * the original is never touched, so a render that goes wrong cannot cost the user their
   * photo. Nothing is claimed until the store confirms the write.
   */
  const saveEdit = async () => {
    if (!sel || editBusy) return;
    const src = editSrc;
    if (!src) return;
    if (isNoop(edit)) {
      editMsg = t("photo.editNoop");
      return;
    }
    editBusy = true;
    editMsg = "";
    try {
      const img = await loadImage(src);
      if (!img) {
        editMsg = t("photo.editUnsupported");
        return;
      }
      const canvas = document.createElement("canvas");
      if (!drawEdited(canvas, img, edit)) {
        editMsg = t("photo.editUnsupported");
        return;
      }
      const data = exportEditedDataUrl(canvas, dataUrlMime(src));
      if (!data) {
        editMsg = t("photo.editFailed");
        return;
      }
      const np = newCapturePhoto(localId("p"), Date.now(), data);
      if (!persist([np, ...list])) return; // persist already reported the refusal
      sel = np;
      editing = false;
      wallMsg = t("photo.editSaved");
    } finally {
      editBusy = false;
    }
  };

  /* ---- Viewer viewport + device photos (REQ-A1147) --------------------------------
   * One `sel` serves both stores — a local capture carries `data`, a device item carries a
   * host-served URL — so "which store is this?" is answered from the value (`isNativePhoto`),
   * never from a second flag that could disagree with it and draw the wrong chrome.
   * ------------------------------------------------------------------------------ */
  /** `sel` narrowed to a device item, or `null`. A derived value (not a boolean) so the
   *  template's `{#if}` narrows `sel.name`/`sel.media` for the type checker too. */
  const nativeSel = $derived(isNativePhoto(sel) ? sel : null);
  const viewSrc = $derived(sel?.data ?? (nativeSel ? nativeUrl : ""));
  const viewBox = $derived<ViewBox>({ img: viewImg ?? { w: 0, h: 0 }, stage: viewStage });

  // Re-read the stage's box on every resize, and re-clamp with it: a rotation or a reflow that
  // shrinks the stage must not leave the photo panned to a place that no longer exists.
  $effect(() => {
    const el = viewStageEl;
    if (!el) return;
    const read = () => {
      const r = el.getBoundingClientRect();
      if (!(r.width > 0) || !(r.height > 0)) return; // an unmeasured box is not a stage of 0
      viewStage = { w: r.width, h: r.height };
      view = clampPan(view, viewBox);
    };
    read();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", read); // 降级：没有观察者也能跟上尺寸变化
      return () => window.removeEventListener("resize", read);
    }
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  });

  // A different photo is a different viewport: zoom/pan belong to the photo being looked at, so
  // carrying them over would show the next photo pre-zoomed into a corner of the last one.
  $effect(() => {
    const id = sel?.id ?? "";
    void id; // dependency: the viewport below is reset per photo
    view = defaultView();
    viewImg = null;
    viewFailed = false;
    viewMsg = "";
  });

  /** The photo's layout box plus the view transform.
   *
   *  Only the **size** needs the measurement: the zoom rides on `transform`, so the layout box
   *  never changes with zoom and the browser never re-lays-out mid-pinch. The transform is
   *  emitted unconditionally, so a photo that has not decoded yet is still placed by the model
   *  (and the view is observable without waiting for a decode). */
  const viewStyle = $derived(
    (viewImg
      ? `width:${fitScale(viewBox.img, viewBox.stage) * viewImg.w}px;` +
        `height:${fitScale(viewBox.img, viewBox.stage) * viewImg.h}px;`
      : "width:0;height:0;") +
      `transform:translate(-50%,-50%) translate(${view.x}px,${view.y}px) scale(${view.zoom});`,
  );

  const onViewImgLoad = (ev: Event) => {
    const im = ev.currentTarget as HTMLImageElement;
    if (im.naturalWidth > 0 && im.naturalHeight > 0) {
      viewImg = { w: im.naturalWidth, h: im.naturalHeight };
    }
  };
  const onViewImgError = () => {
    viewFailed = true;
    // A device item the host will not serve is the only case the user can act on; a local
    // data URL that will not decode falls back to the glyph with no claim about why.
    if (nativeSel) viewMsg = t("photo.nativeUnavailable");
  };

  // Gestures are imperative for the same reason the crop drag is: the photo must track the
  // fingers at the device's own event rate, and a reactive wrapper would re-register mid-gesture.
  const pointers = new Map<number, { x: number; y: number }>();
  let pinch: { dist: number; cx: number; cy: number } | null = null;
  let dragFrom: { x: number; y: number } | null = null;

  /** A client point in stage coordinates (the zoom model measures from the stage's centre). */
  const stagePoint = (ev: { clientX: number; clientY: number }): { x: number; y: number } => {
    const r = viewStageEl?.getBoundingClientRect();
    return { x: ev.clientX - (r?.left ?? 0), y: ev.clientY - (r?.top ?? 0) };
  };
  const twoPointers = (): [{ x: number; y: number }, { x: number; y: number }] | null => {
    const [a, b] = [...pointers.values()];
    return a && b ? [a, b] : null;
  };
  const onViewPointerDown = (ev: PointerEvent) => {
    pointers.set(ev.pointerId, stagePoint(ev));
    const pair = twoPointers();
    if (pair) {
      pinch = { ...pinchOf(pair), dist: pinchDist(pair) };
      dragFrom = null;
    } else {
      dragFrom = stagePoint(ev);
    }
    window.addEventListener("pointermove", onViewPointerMove);
    window.addEventListener("pointerup", onViewPointerUp);
    window.addEventListener("pointercancel", onViewPointerUp);
  };
  const pinchDist = (p: [{ x: number; y: number }, { x: number; y: number }]): number =>
    Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
  const pinchOf = (p: [{ x: number; y: number }, { x: number; y: number }]): { cx: number; cy: number } => ({
    cx: (p[0].x + p[1].x) / 2,
    cy: (p[0].y + p[1].y) / 2,
  });
  const onViewPointerMove = (ev: PointerEvent) => {
    if (!pointers.has(ev.pointerId)) return;
    pointers.set(ev.pointerId, stagePoint(ev));
    const pair = twoPointers();
    if (pair && pinch) {
      const dist = pinchDist(pair);
      const { cx, cy } = pinchOf(pair);
      // A zero span means the two pointers are stacked; the ratio is meaningless (and would be
      // a division by zero), so only the pan component moves.
      if (pinch.dist > 0) view = zoomAt(view, dist / pinch.dist, cx, cy, viewBox);
      view = panBy(view, cx - pinch.cx, cy - pinch.cy, viewBox);
      pinch = { dist, cx, cy };
      return;
    }
    if (dragFrom) {
      view = panBy(view, ev.clientX - dragFrom.x, ev.clientY - dragFrom.y, viewBox);
      dragFrom = stagePoint(ev);
    }
  };
  const onViewPointerUp = (ev: PointerEvent) => {
    pointers.delete(ev.pointerId);
    if (pointers.size < 2) pinch = null;
    // Lifting one finger of a pinch hands the gesture to the pan with no jump: the survivor
    // becomes the new drag origin.
    dragFrom = [...pointers.values()][0] ?? null;
    if (pointers.size === 0) {
      window.removeEventListener("pointermove", onViewPointerMove);
      window.removeEventListener("pointerup", onViewPointerUp);
      window.removeEventListener("pointercancel", onViewPointerUp);
    }
  };
  const onViewWheel = (ev: WheelEvent) => {
    ev.preventDefault();
    const p = stagePoint(ev);
    view = zoomAt(view, ev.deltaY < 0 ? 1.15 : 1 / 1.15, p.x, p.y, viewBox);
  };
  const onViewDblClick = (ev: MouseEvent) => {
    const p = stagePoint(ev);
    view = toggleZoom(view, p.x, p.y, viewBox);
  };
  /** The buttons zoom about the stage's centre — a pointer-free path, so zooming is reachable
   *  without a gesture (keyboard, switch, a device whose pinch the WebView eats). */
  const zoomBy = (factor: number) => {
    view = zoomAt(view, factor, viewStage.w / 2, viewStage.h / 2, viewBox);
  };
  const zoomFit = () => (view = defaultView());

  /**
   * Open a device photo: show it, and ask the host for a URL it can be streamed from.
   *
   * `media_stream_url` answers `null` as a *decision* (no read grant, or an item the host does
   * not list), so that case says so rather than rendering an element whose `src` is empty.
   */
  const openNative = async (n: NativePhoto) => {
    sel = n; // a NativePhoto IS a Photo — `nativeSel` decides which chrome is drawn
    nativeUrl = "";
    viewMsg = "";
    wallMsg = ""; // a different subject: the previous photo's verdict must not follow it here
    const url = await mediaStreamUrl(n.media).catch(() => null);
    if (typeof url === "string" && url !== "") nativeUrl = url;
    else viewMsg = t("photo.nativeUnavailable");
  };

  /**
   * Import a device photo into the editor: read its bytes, wrap them as a data URL, and open
   * the ordinary editor on that.
   *
   * Editing a device photo cannot be non-destructive *and* in-place (we have no write consent
   * for the collection), so it follows the same rule as every other edit here: the result is a
   * **new local photo** and the device's file is never touched. Three bytes-level outcomes are
   * told apart — no bytes, an unencodable payload, a real read error — and none of them is
   * reported as an import.
   */
  const openNativeEdit = async () => {
    if (!nativeSel || editBusy) return;
    const target = nativeSel;
    editBusy = true;
    viewMsg = "";
    try {
      const bytes = await mediaLoad(target.media);
      const data = bytes && bytes.length > 0 ? bytesToDataUrl(bytes, target.media.mime) : null;
      if (!data) {
        viewMsg = t("photo.nativeNoBytes");
        return;
      }
      editSrc = data;
      edit = defaultEdit();
      dims = null;
      editMsg = "";
      editing = true;
    } catch {
      // A bridge refusal (the mock backend holds no content for a seeded item) is "could not
      // read it", never an empty photo.
      viewMsg = t("photo.nativeNoBytes");
    } finally {
      editBusy = false;
    }
  };

  const openVideo = async (id: string) => {
    wallMsg = ""; // this overlay reads the same slot as the viewer — never a photo's result
    playErr = "";
    playId = id;
    const blob = await captureBlob(id);
    if (!blob) {
      // The index lists it but the binary store holds no bytes (an earlier session, a cleared
      // store). An endless "…" reads as "still loading" for something that will never load, so
      // the absence is named instead (REQ-A1172).
      playErr = t("media.recordingMissing");
      return;
    }
    try {
      if (typeof URL !== "undefined" && URL.createObjectURL) {
        playUrl = URL.createObjectURL(blob);
        return;
      }
    } catch {
      /* fall through: object URLs unavailable in this build */
    }
    playErr = t("media.recordingUnplayable");
  };
  const closeVideo = () => {
    if (playUrl) URL.revokeObjectURL(playUrl);
    playUrl = "";
    playId = null;
    playErr = "";
    wallMsg = "";
  };
  const deleteVideo = async (id: string) => {
    // Only claim the delete when the library index really dropped the row.
    if (!(await removeVideoCapture(id))) {
      storeErr = t("common.storeWriteFailed");
      return;
    }
    storeErr = "";
    vids = listCaptures();
    closeVideo();
  };
  const shareVideo = async (id: string) => {
    const cap = vids.find((x) => x.id === id);
    if (!cap) return;
    const copied = await copyText(
      `🎬 ${fmtLen(cap.durationMs)} · ${new Date(cap.ts).toLocaleString()}`,
    );
    wallMsg = t(copied ? "photo.shared" : "photo.shareFailed");
  };

  const chip = (on: boolean, size: "xs" | "md" | "lg" = "xs") =>
    `rounded-full ${size === "lg" ? "px-4 py-1.5 text-sm" : size === "md" ? "px-3 py-1 text-sm" : "px-3 py-1 text-xs"} ${on ? "bg-accent text-white" : "bg-neutral-300 text-neutral-700 dark:bg-neutral-700 dark:text-neutral-200"}`;
  const btn = (kind: "accent" | "neutral" | "danger", size: "xs" | "md" | "lg" = "md") =>
    `${size === "lg" ? "px-4 py-1.5 text-sm" : "px-3 py-1 text-sm"} rounded-full transition active:scale-95 ${
      kind === "accent"
        ? "bg-accent text-white"
        : kind === "danger"
          ? "bg-danger text-white"
          : "bg-neutral-300 text-neutral-900 dark:bg-neutral-700 dark:text-neutral-100"
    }`;
</script>

<StoreErrorBar message={storeErr} />
{#if sel}
  {@const prevP = neighborOf(shown, sel?.id ?? "", -1)}
  {@const nextP = neighborOf(shown, sel?.id ?? "", 1)}
  <!-- The viewer browses `shown` (the active filter), so **every** piece of its
       chrome is derived from `shown`, never from the raw `list`: the counter's
       numerator *and* denominator, and the "can we advance?" guard. Reading
       `list.length` here reported "1 / 40" while browsing a 1-item ♥ filter. -->
  {@const idx = shown.findIndex((p) => p.id === sel?.id) + 1}
  {@const total = shown.length}
  <!-- A full-screen stage, not a 160×160 box: looking closer is what a photo viewer is for,
       and the stage's own box is what the zoom model measures against. -->
  <div class="fixed inset-0 z-20 flex flex-col bg-neutral-950/95">
    <div
      bind:this={viewStageEl}
      data-viewer-stage
      role="region"
      aria-label={t("a11y.photoViewer")}
      class={"relative min-h-0 flex-1 touch-none select-none overflow-hidden " + (isZoomed(view) ? "cursor-grab" : "cursor-zoom-in")}
      onpointerdown={onViewPointerDown}
      ondblclick={onViewDblClick}
      onwheel={onViewWheel}
    >
      {#if viewSrc && !viewFailed}
        <!-- The layout box is the contain-fit size and the zoom rides on `transform`, so the
             element never re-lays-out mid-pinch. `draggable="false"` is load-bearing: an `<img>`
             is draggable by default, so on a pointer device mousedown+move started a **native
             image drag**, which takes the pointer away and stops `pointermove` reaching the
             stage — the pan gesture simply never ran (REQ-A1172). -->
        <img src={viewSrc} alt="" draggable="false" onload={onViewImgLoad} onerror={onViewImgError}
          class="absolute left-1/2 top-1/2 max-w-none" style={viewStyle} />
      {:else}
        <!-- The glyph is the honest floor: a demo tile has no pixels, and a photo the host
             serves no bytes for is one we must not draw as if it were there. -->
        <div class="grid h-full w-full place-items-center text-7xl" style:background={grad(sel) ?? "#14161d"}>
          <span aria-hidden="true">{sel.emoji ?? ""}</span>
        </div>
      {/if}
    </div>

    <div class="flex flex-col items-center gap-2 p-3">
      {#if nativeSel}
        <p class="max-w-full truncate text-xs text-white/70">{nativeSel.name}</p>
      {:else}
        <p class="text-xs text-white/60">{tsText(sel.ts)}</p>
        <div class="flex items-center gap-4">
          <button onclick={() => { if (prevP) openLocal(prevP); }} disabled={!prevP} aria-label={t("photo.prev")}
            class="h-9 w-9 rounded-full bg-white/15 text-lg text-white ring-1 ring-white/25 disabled:opacity-30">‹</button>
          <span class="min-w-[3rem] text-center text-xs tabular-nums text-white/60">{idx} / {total}</span>
          <button onclick={() => { if (nextP) openLocal(nextP); }} disabled={!nextP} aria-label={t("photo.next")}
            class="h-9 w-9 rounded-full bg-white/15 text-lg text-white ring-1 ring-white/25 disabled:opacity-30">›</button>
        </div>
      {/if}

      <!-- Pointer-free zoom: a gesture-only zoom is unreachable by keyboard, switch, or a
           device whose pinch the WebView swallows. The ends are disabled, so the control
           reports that it cannot go further rather than going nowhere. -->
      <div class="flex items-center gap-2">
        <button onclick={() => zoomBy(1 / 1.5)} disabled={view.zoom <= MIN_ZOOM} aria-label={t("photo.zoomOut")}
          class="h-9 w-9 rounded-full bg-white/15 text-lg text-white ring-1 ring-white/25 disabled:opacity-30">－</button>
        <button onclick={() => zoomBy(1.5)} disabled={view.zoom >= MAX_ZOOM} aria-label={t("photo.zoomIn")}
          class="h-9 w-9 rounded-full bg-white/15 text-lg text-white ring-1 ring-white/25 disabled:opacity-30">＋</button>
        <button onclick={zoomFit} disabled={!isZoomed(view)}
          class="rounded-full bg-white/15 px-3 py-1.5 text-sm text-white ring-1 ring-white/25 disabled:opacity-30">{t("photo.zoomFit")}</button>
      </div>

      <div class="flex flex-wrap items-center justify-center gap-2">
        {#if nativeSel}
          <!-- A device photo has no local record to favourite, export or delete, so the only
               honest actions are "bring it into the editor" and "close". `设为壁纸` and the
               ♥ toggle would target `amos.photos`, which does not hold this photo. -->
          <button onclick={() => void openNativeEdit()} disabled={editBusy} class={btn("neutral", "lg")}>{t("photo.edit")}</button>
          <button onclick={closeSel} class={btn("neutral", "lg")}>{t("photo.close")}</button>
        {:else}
          <!-- The ♥/♡ glyph is the only state signal and the static `aria-label` shadows it, so
               the toggle must report its own state — the ♥ *filter* chip above does the same
               (`aria-pressed={viewIs("fav")}`) (REQ-A962). -->
          <button onclick={toggleFavSel} aria-label={t("photo.fav")} aria-pressed={!!sel.fav} title={t("photo.fav")} class={chip(!!sel.fav, "lg")}>
            {sel.fav ? "♥" : "♡"}
          </button>
          {#if total > 1}
            <button onclick={toggleSlide} class={chip(slide, "lg")}>{slide ? t("photo.slideStop") : t("photo.slidePlay")}</button>
          {/if}
          <button onclick={() => void exportSel()} disabled={expBusy} class={btn("neutral", "lg")}>{t("camera.exportToSystem")}</button>
          <button onclick={() => void shareSel()} class={btn("neutral", "lg")}>{t("photo.share")}</button>
          <button onclick={closeSel} class={btn("neutral", "lg")}>{t("photo.close")}</button>
          {#if isRealPhoto(sel)}
            <button onclick={openEdit} class={btn("neutral", "lg")}>{t("photo.edit")}</button>
            <button onclick={setWallpaper} class={btn("neutral", "lg")}>{t("photo.setWallpaper")}</button>
          {/if}
          <button onclick={deleteSel} class={btn("danger", "lg")}>{t("photo.delete")}</button>
        {/if}
      </div>
      {#if viewMsg}
        <p role="status" data-testid="viewer-msg" class="text-center text-xs text-white/80">{viewMsg}</p>
      {/if}
      {#if wallMsg}
        <p role="status" class="text-xs text-white/70">{wallMsg}</p>
      {/if}
    </div>
  </div>

  <!-- Photo editor (REQ-A1147). Everything the user can see here is derived from `edit`, and
       `saveEdit` renders that same value — the two cannot disagree. -->
  {#if editing}
    <div class="fixed inset-0 z-30 flex flex-col gap-3 overflow-y-auto bg-neutral-950/95 p-3">
      <!-- No `overflow-hidden` here on purpose: the four crop corners sit half-outside the
           frame, and clipping the stage would cut them off exactly when the crop touches an
           edge. The frame below clips the image itself. -->
      <div data-stage class="relative mx-auto aspect-square w-full max-w-[22rem] rounded-2xl bg-black/60">
        <div
          data-frame
          class="absolute overflow-hidden"
          style={`left:${framePos.left}%; top:${framePos.top}%; width:${frameBox.w}%; height:${frameBox.h}%;`}
        >
          <img
            src={editSrc}
            alt=""
            onload={onPreviewLoad}
            class="absolute left-1/2 top-1/2 max-w-none"
            style={`width:${imgBox.w}%; height:${imgBox.h}%; transform: translate(-50%,-50%) ${previewTransform(edit)}; filter: ${filterCss(edit)};`}
          />
          <div
            class="pointer-events-none absolute border border-white/90"
            style={`left:${edit.crop.x * 100}%; top:${edit.crop.y * 100}%; width:${edit.crop.w * 100}%; height:${edit.crop.h * 100}%;`}
          ></div>
        </div>
        <button
          class="absolute inset-0 cursor-move bg-transparent"
          aria-label={t("a11y.cropMove")}
          onpointerdown={(ev) => startDrag(ev, "move")}
        ></button>
        {#each HANDLES as h (h)}
          {@const at = handleAt(h)}
          <button
            class="absolute h-6 w-6 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/90 bg-white/25"
            style={`left:${at.x}%; top:${at.y}%;`}
            aria-label={t("a11y.cropHandle")}
            onpointerdown={(ev) => startDrag(ev, h)}
          ></button>
        {/each}
      </div>

      <div class="flex flex-wrap items-center justify-center gap-2">
        <button onclick={() => (edit = rotateEdit(edit, -1))} class={btn("neutral")}>{t("photo.editRotL")}</button>
        <button onclick={() => (edit = rotateEdit(edit, 1))} class={btn("neutral")}>{t("photo.editRotR")}</button>
        <button onclick={() => (edit = flipEdit(edit, "h"))} class={btn("neutral")}>{t("photo.editFlipH")}</button>
        <button onclick={() => (edit = flipEdit(edit, "v"))} class={btn("neutral")}>{t("photo.editFlipV")}</button>
        <button onclick={() => (edit = setCrop(edit, { ...FULL_CROP }))} class={btn("neutral")}>{t("photo.editCropReset")}</button>
      </div>

      <div class="flex flex-wrap items-center justify-center gap-2">
        <span class="text-xs text-white/70">{t("photo.editFilter")}</span>
        {#each FILTERS as f (f)}
          <button onclick={() => (edit = setFilterKind(edit, f))} aria-pressed={edit.filter === f} class={chip(edit.filter === f, "md")}>
            {filterLabel(f)}
          </button>
        {/each}
      </div>

      <div class="mx-auto grid w-full max-w-[26rem] gap-2">
        {#each adjusts as a (a.key)}
          <label class="flex items-center gap-2 text-xs text-white/70">
            <span class="w-14 shrink-0">{a.label}</span>
            <input
              type="range"
              min={ADJUST_MIN}
              max={ADJUST_MAX}
              step="0.05"
              value={edit.adjust[a.key]}
              aria-label={a.label}
              oninput={(ev) => setAdjustKey(a.key, Number(ev.currentTarget.value))}
              class="min-w-0 flex-1"
            />
          </label>
        {/each}
      </div>

      <div class="flex flex-wrap items-center justify-center gap-2">
        <button onclick={resetEdit} class={btn("neutral")}>{t("photo.editReset")}</button>
        <button onclick={closeEdit} class={btn("neutral")}>{t("photo.close")}</button>
        <button onclick={() => void saveEdit()} disabled={editBusy} class={btn("accent")}>{t("photo.editSave")}</button>
      </div>
      {#if editMsg}
        <p role="status" class="text-center text-xs text-white/80">{editMsg}</p>
      {/if}
    </div>
  {/if}
{:else}


  <div class="p-2">
    <div class="mb-2 flex flex-wrap items-center gap-2 px-1">
      <button onclick={add} class={btn("accent", "lg")}>{t("photo.add")}</button>
      <!-- Multi-select is a stills-only mode (`toggleSelectMode` refuses under the Videos
           filter, since a video tile carries its own ♥ and lives outside `list`). The button is
           hidden there for the same reason: a control that renders but cannot act is worse than
           no control. -->
      {#if list.length > 0 && !vidsOnly}
        <button onclick={toggleSelectMode} class={chip(selecting, "lg")}>{selecting ? t("photo.cancel") : t("photo.select")}</button>
      {/if}
      <div class="ml-auto flex gap-1">
        <button onclick={() => setFilter("all")} aria-pressed={viewIs("all")} class={chip(viewIs("all"), "md")}>{t("photo.all")} ({list.length})</button>
        {#if favsOf(list).length > 0}
          <button onclick={() => setFilter("fav")} aria-pressed={viewIs("fav")} class={chip(viewIs("fav"), "md")}>♥ ({favsOf(list).length})</button>
        {/if}
        {#if vids.length > 0}
          <button onclick={() => setFilter("videos")} aria-pressed={viewIs("videos")} class={chip(viewIs("videos"), "md")}>🎬 ({vids.length})</button>
        {/if}
      </div>
      {#if selecting && list.length > 0}
        <button onclick={toggleSelectAll} class={chip(allShownSelected, "md")}>{allShownSelected ? t("photo.selectNone") : t("photo.selectAll")}</button>
      {/if}
      {#if selecting && selected.size > 0}
        <button onclick={() => batchFav(true)} class={btn("accent", "lg")}>{t("photo.favSelected", { n: selected.size })}</button>
        <button onclick={deleteSelected} class={btn("danger", "lg")}>{t("photo.deleteSelected", { n: selected.size })}</button>
      {/if}
    </div>

    {#if nativeBlocked}
      <div
        role="status"
        data-testid="native-blocked"
        class="mb-2 flex flex-wrap items-center gap-2 rounded-xl bg-amber-500/15 px-3 py-2 text-xs text-amber-100 ring-1 ring-amber-400/30"
      >
        <span aria-hidden="true">🔒</span>
        <span class="min-w-0 flex-1">{t("photo.nativeBlocked")}</span>
        <button
          onclick={() => void grantNative()}
          disabled={nativeBusy}
          aria-label={t("photo.nativeGrant")}
          class="rounded-full bg-amber-400/90 px-2.5 py-1 font-medium text-neutral-900 active:scale-95 disabled:opacity-50"
        >{t("photo.nativeGrant")}</button>
      </div>
    {/if}

    <!-- The strip is drawn independently of the local library: a device's photos exist whether or
         not this app holds any of its own, so it must not be hidden behind the "no photos" branch. -->
    {#if nativeShown}
      <div class="mb-2" role="region" aria-label={t("a11y.nativePhotos")}>
        <div class="flex gap-1 overflow-x-auto px-1">
          {#each native as n (n.id)}
            <!-- A device item opens like any other photo. It is a `<button>` rather than the
                 `<div>` it used to be so it is reachable and operable at all — the strip was
                 navigable but its items were not, which also made them uneditable (REQ-A1147).
                 The glyph is what a tile shows until it is opened; the host resolves the
                 item's own URL only for the one photo the user actually looks at. -->
            <button
              onclick={() => void openNative(n)}
              aria-label={n.name}
              title={n.name}
              class="relative grid aspect-square w-16 shrink-0 place-items-center overflow-hidden rounded-lg bg-black/20 text-2xl ring-1 ring-white/10 active:scale-95"
            >
              <span aria-hidden="true">{n.emoji ?? "🗂"}</span>
            </button>
          {/each}
        </div>
        <!-- 宿主不报总数 ⇒ "共 M 项" 里的 M 是我们自己数的（已取回 + 还剩）。按钮只在
             **确实还有**（`remaining > 0`）时出现 —— 只用"集合还没退休"当判据会给出一个
             「加载更多（还有 0 项）」的按钮（见 `lib/mediaPaging.canLoadMore` 的注释）。 -->
        <div class="mt-1 flex items-center justify-between gap-2 px-1 text-xs text-white/60">
          <span data-testid="native-count">
            {t("media.showingNewest", { shown: native.length, total: nativeTotal })}
          </span>
          {#if nativeHasMore}
            <button
              onclick={() => void loadNativePage()}
              disabled={nativeBusy}
              data-testid="native-load-more"
              aria-label={t("media.loadMore", { n: nativeRemaining })}
              class="shrink-0 rounded-full bg-white/10 px-2.5 py-1 font-medium text-white/90 active:scale-95 disabled:opacity-50"
            >{t("media.loadMore", { n: nativeRemaining })}</button>
          {/if}
        </div>
      </div>
    {/if}
    {#if gallery.length === 0}
      <!-- Nothing to draw. If the device's own photos are on screen, say nothing: the strip is
           the content, and a "no photos" line over it would contradict it. -->
      {#if !nativeShown}
        <p class="py-10 text-center text-sm opacity-60">{emptyMsg}</p>
      {/if}
    {:else}
      {#each sections as sec (sec.key)}
        <p role="heading" aria-level="2"
          class="mb-1 mt-2 flex items-baseline gap-2 px-1 text-[13px] font-semibold text-white/90">
          <span>{sec.label}</span>
          {#if sec.items.length > 1}
            <span class="text-xs font-normal text-white/50">{sec.items.length}</span>
          {/if}
        </p>
        <div class="grid gap-1" style={`grid-template-columns: repeat(${cols}, minmax(0, 1fr));`}>
          {#each sec.items as it (it.kind === "photo" ? it.p.id : it.v.id)}
          {#if it.kind === "video"}
            {@const v = it.v}
            <div class="relative aspect-square overflow-hidden bg-black text-4xl">
              <button aria-label={t("a11y.video")} onclick={() => void openVideo(v.id)}
                class="absolute inset-0 grid h-full w-full place-items-center">
                <span class="opacity-90">🎬</span>
                <span class="absolute bottom-1 right-1 rounded bg-black/60 px-1 text-xs tabular-nums text-white">{fmtLen(v.durationMs)}</span>
                {#if resLabelOf(v)}
                  <span class="absolute bottom-1 left-1 rounded bg-black/60 px-1 text-xs font-medium text-white">{resLabelOf(v)}</span>
                {/if}
              </button>
              <!-- Same toggle as the photo ♥ below in this file (line ~537), which the REQ-A962 fix
                   gave `aria-pressed` — this sibling kept only the ♥/♡ glyph plus a static
                   `aria-label` that OVERRIDES it, so a favourite video announced itself identically
                   in both states (REQ-A1001 / F-SH-322). -->
              <button aria-label={t("a11y.favouriteVideo")} aria-pressed={!!v.fav} onclick={() => favVideo(v.id)}
                class="absolute right-1 top-1 z-10 grid h-6 w-6 place-items-center rounded-full bg-black/45 text-xs text-white">{v.fav ? "♥" : "♡"}</button>
            </div>
          {:else}
            {@const p = it.p}
            {@const isSel = selecting && selected.has(p.id)}
            <!-- In select mode this tile IS a multi-select toggle, and its selected state lived only
                 in the ring class and the ✓ badge — the accessible name (`emoji ?? id`) is the same
                 in both states, so AT could not report which photos were picked. `aria-pressed` is
                 omitted outside select mode, where the same tile opens the photo instead of toggling
                 anything (REQ-A1001 / F-SH-322). -->
            <button
              onclick={() => (selecting ? toggleSelect(p.id) : openLocal(p))}
              aria-label={p.emoji ?? p.id}
              aria-pressed={selecting ? isSel : undefined}
              class={"relative grid aspect-square place-items-center overflow-hidden text-3xl " + (isSel ? "ring-2 ring-accent ring-inset" : "")}
              style:background={grad(p) ?? "#1c1c1e"}
            >
              <!-- The glyph is what the tile shows until the photo itself is decoded; the lazy
                   image covers it once it is (REQ-A587: a page of 60 tiles used to start all 60
                   decodes at once, and a tile whose image failed stayed a blank box). -->
              <span aria-hidden="true">{p.emoji ?? ""}</span>
              {#if p.data}
                <LazyImage
                  src={p.data}
                  alt=""
                  class="absolute inset-0 h-full w-full object-cover"
                />
              {/if}
              {#if p.fav && !selecting}
                <span class="absolute left-1 top-1 text-xs drop-shadow">♥</span>
              {/if}
              {#if selecting}
                <span class={"absolute right-1 top-1 grid h-5 w-5 place-items-center rounded-full text-xs font-bold " +
                  (isSel ? "bg-accent text-white" : "bg-black/40 text-white/90")}>{isSel ? "✓" : ""}</span>
              {/if}
            </button>
          {/if}
          {/each}
        </div>
      {/each}
    {/if}

    {#if playId}
      {@const cap = vids.find((x) => x.id === playId)}
      <div class="fixed inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-black/85 px-4">
        <div class="w-full max-w-lg">
          {#if playUrl}
            <video src={playUrl} controls autoplay playsinline class="max-h-[70vh] w-full rounded-xl"><track kind="captions" /></video>
          {:else}
            <!-- No bytes yet (a read still in flight) shows the placeholder; a read that came
                 back empty shows why. -->
            <div
              role={playErr ? "status" : undefined}
              data-testid="video-msg"
              class={"grid h-40 w-full place-items-center px-4 text-center " + (playErr ? "text-white/80" : "text-white/50")}
            >{playErr || "…"}</div>
          {/if}
          {#if cap}
            <div class="mt-2 text-center text-xs text-white/80">{fmtLen(cap.durationMs)}{resLabelOf(cap) ? ` · ${resLabelOf(cap)}` : ""}</div>
          {/if}
          <div class="mt-3 flex flex-col items-center gap-2">
            {#if wallMsg}
              <p role="status" class="text-xs text-white/80">{wallMsg}</p>
            {/if}
            <div class="flex items-center justify-between gap-3 self-stretch">
              <button onclick={closeVideo} aria-label={t("a11y.closeVideo")} data-icon="x" class="grid h-11 w-11 place-items-center rounded-full bg-white/15 text-white ring-1 ring-white/25">{@html iconSvg("x", "h-4 w-4")}</button>
              <button onclick={() => playId && void exportVideo(playId)} disabled={expBusy} class="rounded-full bg-white/15 px-4 py-1.5 text-sm text-white ring-1 ring-white/25 disabled:opacity-50">{t("camera.exportToSystem")}</button>
              <button onclick={() => playId && void shareVideo(playId)} class="rounded-full bg-white/15 px-4 py-1.5 text-sm text-white ring-1 ring-white/25">{t("photo.share")}</button>
              <button onclick={() => playId && void deleteVideo(playId)} class="rounded-full bg-danger/90 px-4 py-1.5 text-sm text-white">{t("photo.delete")}</button>
            </div>
          </div>
        </div>
      </div>
    {/if}
  </div>
{/if}

