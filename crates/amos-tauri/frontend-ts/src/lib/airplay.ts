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
  | { kind: 'failed'; reason: string };

/**
 * Check if AirPlay is available on this platform
 */
export async function isAirPlayAvailable(): Promise<boolean> {
  const result = await invoke<boolean>('airplay_available');
  return result ?? false;
}

/**
 * Start device discovery
 */
export async function discoverDevices(): Promise<AirPlayResult> {
  const result = await invoke<AirPlayResult>('airplay_discover');
  return result ?? { kind: 'failed', reason: 'Not in Tauri environment' };
}

/**
 * Stop device discovery
 */
export async function stopDiscovery(): Promise<void> {
  await invoke('airplay_stop_discovery');
}

/**
 * Get list of discovered devices
 */
export async function getDevices(): Promise<AirPlayDevice[]> {
  const result = await invoke<AirPlayDevice[]>('airplay_get_devices');
  return result ?? [];
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
export async function connect(deviceId: string): Promise<AirPlayResult> {
  const result = await invoke<AirPlayResult>('airplay_connect', { deviceId });
  return result ?? { kind: 'failed', reason: 'Not in Tauri environment' };
}

/**
 * Disconnect from current AirPlay device
 */
export async function disconnect(): Promise<AirPlayResult> {
  const result = await invoke<AirPlayResult>('airplay_disconnect');
  return result ?? { kind: 'failed', reason: 'Not in Tauri environment' };
}

/**
 * Start streaming to connected device
 */
export async function startStream(
  kind: StreamKind,
  url?: string
): Promise<AirPlayResult> {
  const result = await invoke<AirPlayResult>('airplay_start_stream', { kind, url });
  return result ?? { kind: 'failed', reason: 'Not in Tauri environment' };
}

/**
 * Stop current stream
 */
export async function stopStream(): Promise<AirPlayResult> {
  const result = await invoke<AirPlayResult>('airplay_stop_stream');
  return result ?? { kind: 'failed', reason: 'Not in Tauri environment' };
}

/**
 * Set playback volume (0.0-1.0)
 */
export async function setVolume(volume: number): Promise<AirPlayResult> {
  const result = await invoke<AirPlayResult>('airplay_set_volume', { volume });
  return result ?? { kind: 'failed', reason: 'Not in Tauri environment' };
}
