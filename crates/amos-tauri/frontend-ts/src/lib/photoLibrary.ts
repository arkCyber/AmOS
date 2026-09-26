/**
 * Photo library view model: how AmOS's real media collections (from the
 * `media_*` bridge, i.e. DCIM/Camera etc. on a device) combine with the local
 * `amos.photos` layer (captures stored as base64 data URLs / gradient tiles).
 *
 * This is the pure Phase-D core that a screen renders. On host the native items carry
 * `mock://` handles with no real pixels, so each becomes a kind-glyph tile (📷/🎬/…)
 * whose `uri`/`sizeBytes` are kept for when there are pixels to show. All functions
 * are pure + offline-testable; nothing here touches the bridge.
 *
 * ## 真缩略图为什么还不在（REQ-A517）
 *
 * 这个文件里曾有一对 `nativeStreamUrl()` / `nativeTileKind()`，配套 `lib/media.ts` 的
 * `mediaStreamBase()`，一齐描述了一条"把原生项当流加载"的流水线。**它们的宿主半边不存在**：
 * `media_stream_base` 从来不是一条命令（`crates/amos-tauri` 里没有那个 `#[tauri::command]`，
 * 它也不在 `lib.rs` 的 `generate_handler![]` 里），所以 `mediaStreamBase()` 永远返回 `null`
 * ⇒ `nativeStreamUrl()` 永远返回 `null` ⇒ 那条流水线一步也走不通，而每次调用还在诊断台账里
 * 留下一条**假的** `command-failed`。
 *
 * 它们的来历写在 `docs/archive/2026-09/zh/MOBILE_FINAL_AUDIT_2026_SEP17.md`：2026-09-17 的
 * 一次**构建**失败（`PhotosApp` 导入了不存在的函数），处置是"把函数补出来"，于是构建变绿、
 * 审计记下"影响：照片应用可正确渲染原生媒体缩略图"。能力**从未存在** —— 这也是本轮把三个
 * 前端桩删掉、改为在 `scripts/tauri-command-scan.mjs` 里加一条检查（UI 的字面 `invoke`
 * 必须在宿主注册表中）的原因：只让编译器满意的"补全"必须被拦住。
 *
 * 需要真缩略图时，先做**宿主半边**：一个媒体流端点（`docs/android-storage-unify.md` §6 D 的
 * 设计）＋一条注册的 `media_stream_base` 命令回答基址，然后再把消费端加回来。在那之前，
 * 字形瓦片是诚实的画法（`photoGlyph`），不是占位符谎言。
 *
 * ## 那之后（REQ-A1147）：宿主半边**已经存在**
 *
 * 上面那段说"要用真缩略图得先做宿主半边"——那一半现在有了，但不是当年设想的
 * `media_stream_base` 基址，而是 `lib/media.ts` 的 `mediaStreamUrl(item)`：宿主按项回答一个
 * `amos-media://`（Android 上是 `http://amos-media.localhost/`）URL，协议处理器用有界 `206`
 * 窗口供字节。所以原生瓦片**可以**把真图取回来画，也可以用 `mediaLoad(item)` 取回整份字节。
 *
 * 两条都是**宿主说了算**：`null` 表示"这个项不供"（无授权 / 不在授权清单里），而 mock 后端
 * 只对**它自己存过的**字节作答——种子项（`mock://…`）有 URL 但没有内容。所以调用方对每一项都
 * 必须留着字形回落，并在取不到时如实说明；`photoGlyph` 仍是底，不是谎言。
 *
 * 这也是 {@link NativePhoto.media} 存在的理由：两个命令收的都是 `MediaItem`，把 `id`/`mime`
 * 丢掉，瓦片就只能永远是字形。
 */
import type { MediaItem, StandardDir } from "./media";
import type { Photo } from "./photos";

/** A native media item promoted into the Photos tile shape (glyph placeholder
 * until a real thumbnail loads; `uri`/`collection`/`sizeBytes` carried over). */
export interface NativePhoto extends Photo {
  kind: MediaItem["kind"];
  name: string;
  uri: string;
  collection: StandardDir;
  sizeBytes: number | null;
  /**
   * The item this tile came from, kept whole.
   *
   * The strip used to flatten a `MediaItem` into the fields above and drop the rest — which
   * made the *identity the host keys on* (`id`, and the `mime` an editor needs) unrecoverable
   * for a consumer that wants to open the photo. Both `media_stream_url` and `media_load`
   * take a `MediaItem`, so a tile without one is a tile that can only ever be a glyph.
   */
  media: MediaItem;
}

/**
 * Whether a photo in the viewer is a device item rather than a local capture.
 *
 * The viewer holds one `sel`, so "which store is this from?" has to be answerable from the
 * value itself — a separate flag would be a second source of truth that can disagree with it
 * (the local chrome would draw over a native photo, or the reverse).
 */
export function isNativePhoto(p: Photo | null | undefined): p is NativePhoto {
  return !!p && typeof (p as Partial<NativePhoto>).uri === "string";
}

/** Kind → tile glyph (placeholder face; mirror of demo gradient tiles). */
export function photoGlyph(kind: MediaItem["kind"]): string {
  switch (kind) {
    case "image":
      return "📷";
    case "video":
      return "🎬";
    case "audio":
      return "🎵";
    case "download":
      return "📦";
    case "file":
      return "📄";
  }
}

/** Promote a native `MediaItem` into a `NativePhoto` with a unique id and the
 * source `ts`. `fav` is absent (favourites live on the local layer). */
export function nativePhotoFromItem(item: MediaItem): NativePhoto {
  return {
    id: `native:${item.uri}`,
    kind: item.kind,
    collection: item.collection,
    name: item.name,
    uri: item.uri,
    sizeBytes: item.size_bytes,
    ts: item.ts,
    emoji: photoGlyph(item.kind),
    media: item,
  };
}
