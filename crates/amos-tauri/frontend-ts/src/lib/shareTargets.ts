/**
 * shareTargets.ts — the **built-in** half of the system share sheet's target list.
 *
 * `lib/shareSheet.ts` owns *what may be shared* and *which shortcuts opted in*; a
 * shortcut, though, is something the user had to author first. An OS share sheet that
 * can only hand content to user-written shortcuts has no out-of-the-box destination at
 * all — sharing a note to Mail was impossible until someone built a shortcut for it.
 * This module is the other half: the apps that are always there.
 *
 * Delivery rides the existing deep-link channels (`svelte/appLinks.ts`) rather than a
 * parallel path, so a share lands exactly where a drag-and-drop or a Spotlight hand-off
 * lands — `openNoteDraft` / `openMailDraft` write the target app's props channel and
 * switch the shell. Nothing here reaches a host command: a share writes a *draft*, and
 * the user still presses send. That is why the table can live in `lib/` and stay
 * headless-testable apart from the two link functions it calls.
 */
import { appIcon, appTitleKey } from "./appMeta";
import type { MessageKey } from "../i18n/locales/zh";
import { openMailDraft, openNoteDraft } from "../svelte/appLinks";
import type { ShareKind, SharePayload } from "./shareSheet";

/**
 * One built-in destination. `deliver` answers whether the hand-off was dispatched:
 * `false` means the target refused the content outright (an empty draft), which the
 * sheet must **not** treat as success — closing *is* its success gesture.
 */
export interface ShareTarget {
  /** The target app's id (also the row's `data-testid` suffix). */
  id: string;
  /** i18n key for the row's label, taken from the app's own metadata. */
  titleKey: MessageKey;
  /** The app's tile icon, so the sheet and the home screen agree. */
  icon: string;
  /** The payload kinds this target can take. */
  accepts: ShareKind[];
  deliver: (payload: SharePayload) => boolean;
}

/**
 * Resolve one built-in by app id, or `null` when that app is not in `APP_META`.
 *
 * The lookup is total on purpose: a table entry whose app was removed yields **no row**
 * rather than a row labelled with a placeholder. (A hard-coded title key would have
 * silently kept a name for an app that no longer exists.)
 */
function builtin(
  appId: string,
  accepts: ShareKind[],
  deliver: (payload: SharePayload) => boolean,
): ShareTarget | null {
  const titleKey = appTitleKey(appId);
  if (titleKey === null) return null;
  return { id: appId, titleKey, icon: appIcon(appId), accepts, deliver };
}

const CANDIDATES: Array<ShareTarget | null> = [
  builtin("notes", ["text", "file"], (p) =>
    // Prefill only: `openNoteDraft` writes the compose box's draft, it does not author
    // a note. It answers the *same* refusal its sibling below does (an empty body), and
    // this entry carries that answer: `deliver` is a public contract the sheet keys its
    // "do not close" decision on, so assuming `normalizeSharePayload` up the chain
    // already refused an empty value would make this row report a hand-off that did not
    // happen (REQ-A1557 ∕ F-SH-791).
    openNoteDraft(p.value),
  ),
  builtin("mail", ["text", "file"], (p) =>
    // The share title becomes the subject; the content becomes the body.
    openMailDraft({ subject: p.title, body: p.value }),
  ),
];

/** The built-in targets, in the order the sheet shows them. */
export const BUILTIN_SHARE_TARGETS: readonly ShareTarget[] = CANDIDATES.filter(
  (t): t is ShareTarget => t !== null,
);

/** The built-in targets that accept a payload of `kind`. */
export function builtinTargetsFor(kind: ShareKind): ShareTarget[] {
  return BUILTIN_SHARE_TARGETS.filter((t) => t.accepts.includes(kind));
}
