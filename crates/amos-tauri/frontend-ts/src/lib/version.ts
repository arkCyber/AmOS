/**
 * Frontend build metadata for the Settings「关于本机」page.
 *
 * `AMOS_OS_NAME`/`AMOS_UI_VERSION` describe this UI client (the phone shell);
 * they are constants because the shell ships as a static web UI — the daemon is
 * what holds device-model / system-build identity. True per-device telemetry
 * (battery etc.) comes from lib/system when bridged, never fabricated here.
 */
export const AMOS_OS_NAME = "AmOS";
/** Mirrors the frontend package.json version (kept in sync manually). */
export const AMOS_UI_VERSION = "0.1.0";
/** Friendly label shown under 名称 in About — this IS the AmOS phone shell. */
export const AMOS_DEVICE_LABEL = "AmOS Phone (UI shell)";
