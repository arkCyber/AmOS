// airplay.ts — AirPlay device discovery, connection, and streaming state management.

import { invoke } from './backend';

/**
 * AirPlay device type classification
 */
export type DeviceKind = 'appletv' | 'tv' | 'audio' | 'generic';

/**
 * AirPlay receiver device
 */
export interface AirPlayDevice {
  /** Unique identifier (MAC address or service ID) */
  id: string;
  /** Human-readable device name */
  name: string;
  /** Device type */
  kind: DeviceKind;
  /** Whether device supports video streaming */
  supports_video: boolean;
  /** Whether device supports audio streaming */
  supports_audio: boolean;
  /** Whether device supports screen mirroring */
  supports_mirroring: boolean;
  /** Signal strength (0-100, 0 = unknown) */
  signal_strength: number;
  /** Whether device is currently connected */
  connected: boolean;
}

/**
 * Type of AirPlay stream
 */
export type StreamKind = 'audio' | 'video' | 'mirroring';

/**
 * Current AirPlay streaming status
 */
export interface AirPlayStatus {
  /** Whether AirPlay is currently active */
  active: boolean;
  /** Connected device (if any) */
  device: AirPlayDevice | null;
  /** Type of active stream */
  stream_kind: StreamKind | null;
  /** Playback state */
  playing: boolean;
  /** Volume level (0.0-1.0) */
  volume: number;
}

/**
 * AirPlay command result
 */
export type AirPlayResult =
  | { kind: 'ok' }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'permission_denied'; reason: string }
  | { kind: 'device_not_found' }
  | { kind: 'failed'; reason: string }
  // The surface exists but the host has no implementation for it (REQ-A467). Distinct from
  // `unavailable`, which means "this platform has no AirPlay at all" — the two need different
  // sentences in front of the user. Pinned on the Rust side by
  // `airplay_tests.rs::test_airplay_result_wire_form`, because the wire strings are this contract.
  | { kind: 'not_implemented'; reason: string };

/**
 * Check if AirPlay is available on this platform, or `null` when the host did not answer.
 *
 * `null` is unambiguous: `airplay_available` answers a **boolean**, and `invoke` resolves
 * `null` only when the command was refused or there is no host at all. The old `?? false`
 * made a refused read into 「此平台不支持 AirPlay」 — a claim about the *platform* derived
 * from a question nobody answered — and, because `AirPlayPanel` early-returns on `false`,
 * it also killed the panel for the whole session with no retry (REQ-A1336 / F-SH-602).
 */
export async function isAirPlayAvailable(): Promise<boolean | null> {
  return await invoke<boolean>('airplay_available');
}

/**
 * Start device discovery, or `null` when the host did not answer.
 *
 * The old fallback synthesised `{ kind: 'failed', reason: 'Not in Tauri environment' }` —
 * a **cause** the wrapper cannot know (the host may be right there and have refused).
 */
export async function discoverDevices(): Promise<AirPlayResult | null> {
  return await invoke<AirPlayResult>('airplay_discover');
}

/**
 * Stop device discovery.
 *
 * Signed `void`: the verdict is deliberately dropped by the only caller (`AirPlayPanel`'s
 * `onDestroy`, where there is no surface left to report on and nothing to retry with).
 * It is in `scripts/void-cmd-allowlist.json`.
 */
export async function stopDiscovery(): Promise<void> {
  await invoke('airplay_stop_discovery');
}

/**
 * Get the list of discovered devices, or `null` when the host did not answer.
 *
 * `[]` is the host saying 「设备列表是空的」 (`airplay.noDevices`); `null` is this reader
 * saying 「我问不到」. The old `?? []` rendered the second as the first (REQ-A1336).
 */
export async function getDevices(): Promise<AirPlayDevice[] | null> {
  return await invoke<AirPlayDevice[]>('airplay_get_devices');
}

/**
 * Get current AirPlay status
 */
export async function getStatus(): Promise<AirPlayStatus | null> {
  return await invoke<AirPlayStatus>('airplay_get_status');
}

/**
 * Connect to an AirPlay device
 */
export async function connect(deviceId: string): Promise<AirPlayResult | null> {
  return await invoke<AirPlayResult>('airplay_connect', { deviceId });
}

/**
 * Disconnect from current AirPlay device
 */
export async function disconnect(): Promise<AirPlayResult | null> {
  return await invoke<AirPlayResult>('airplay_disconnect');
}

/**
 * Start streaming to connected device
 */
export async function startStream(
  kind: StreamKind,
  url?: string
): Promise<AirPlayResult | null> {
  return await invoke<AirPlayResult>('airplay_start_stream', { kind, url });
}

/**
 * Stop current stream
 */
export async function stopStream(): Promise<AirPlayResult | null> {
  return await invoke<AirPlayResult>('airplay_stop_stream');
}

/**
 * Set playback volume (0.0-1.0)
 */
export async function setVolume(volume: number): Promise<AirPlayResult | null> {
  return await invoke<AirPlayResult>('airplay_set_volume', { volume });
}
