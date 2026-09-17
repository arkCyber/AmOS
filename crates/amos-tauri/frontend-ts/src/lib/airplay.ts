// airplay.ts — AirPlay device discovery, connection, and streaming state management.

import { invoke } from '@tauri-apps/api/tauri';

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
  try {
    return await invoke<boolean>('airplay_available');
  } catch (e) {
    console.error('Failed to check AirPlay availability:', e);
    return false;
  }
}

/**
 * Start device discovery
 */
export async function discoverDevices(): Promise<AirPlayResult> {
  try {
    return await invoke<AirPlayResult>('airplay_discover');
  } catch (e) {
    console.error('Failed to start AirPlay discovery:', e);
    return { kind: 'failed', reason: String(e) };
  }
}

/**
 * Stop device discovery
 */
export async function stopDiscovery(): Promise<void> {
  try {
    await invoke('airplay_stop_discovery');
  } catch (e) {
    console.error('Failed to stop AirPlay discovery:', e);
  }
}

/**
 * Get list of discovered devices
 */
export async function getDevices(): Promise<AirPlayDevice[]> {
  try {
    return await invoke<AirPlayDevice[]>('airplay_get_devices');
  } catch (e) {
    console.error('Failed to get AirPlay devices:', e);
    return [];
  }
}

/**
 * Get current AirPlay status
 */
export async function getStatus(): Promise<AirPlayStatus | null> {
  try {
    return await invoke<AirPlayStatus>('airplay_get_status');
  } catch (e) {
    console.error('Failed to get AirPlay status:', e);
    return null;
  }
}

/**
 * Connect to an AirPlay device
 */
export async function connect(deviceId: string): Promise<AirPlayResult> {
  try {
    return await invoke<AirPlayResult>('airplay_connect', { deviceId });
  } catch (e) {
    console.error('Failed to connect to AirPlay device:', e);
    return { kind: 'failed', reason: String(e) };
  }
}

/**
 * Disconnect from current AirPlay device
 */
export async function disconnect(): Promise<AirPlayResult> {
  try {
    return await invoke<AirPlayResult>('airplay_disconnect');
  } catch (e) {
    console.error('Failed to disconnect from AirPlay device:', e);
    return { kind: 'failed', reason: String(e) };
  }
}

/**
 * Start streaming to connected device
 */
export async function startStream(
  kind: StreamKind,
  url?: string
): Promise<AirPlayResult> {
  try {
    return await invoke<AirPlayResult>('airplay_start_stream', { kind, url });
  } catch (e) {
    console.error('Failed to start AirPlay stream:', e);
    return { kind: 'failed', reason: String(e) };
  }
}

/**
 * Stop current stream
 */
export async function stopStream(): Promise<AirPlayResult> {
  try {
    return await invoke<AirPlayResult>('airplay_stop_stream');
  } catch (e) {
    console.error('Failed to stop AirPlay stream:', e);
    return { kind: 'failed', reason: String(e) };
  }
}

/**
 * Set playback volume (0.0-1.0)
 */
export async function setVolume(volume: number): Promise<AirPlayResult> {
  try {
    return await invoke<AirPlayResult>('airplay_set_volume', { volume });
  } catch (e) {
    console.error('Failed to set AirPlay volume:', e);
    return { kind: 'failed', reason: String(e) };
  }
}
