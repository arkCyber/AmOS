import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as airplay from '../airplay';
import type { AirPlayDevice, AirPlayStatus, AirPlayResult } from '../airplay';

// Mock Tauri invoke
const mockInvoke = vi.fn();
vi.mock('@tauri-apps/api/tauri', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

describe('AirPlay Library', () => {
  beforeEach(() => {
    mockInvoke.mockReset();
  });

  describe('isAirPlayAvailable', () => {
    it('should return true when AirPlay is available', async () => {
      mockInvoke.mockResolvedValue(true);
      const result = await airplay.isAirPlayAvailable();
      expect(result).toBe(true);
      expect(mockInvoke).toHaveBeenCalledWith('airplay_available');
    });

    it('should return false when AirPlay is unavailable', async () => {
      mockInvoke.mockResolvedValue(false);
      const result = await airplay.isAirPlayAvailable();
      expect(result).toBe(false);
    });
  });

  describe('discoverDevices', () => {
    it('should start device discovery', async () => {
      const mockResult: AirPlayResult = { kind: 'ok' };
      mockInvoke.mockResolvedValue(mockResult);
      
      const result = await airplay.discoverDevices();
      expect(result).toEqual(mockResult);
      expect(mockInvoke).toHaveBeenCalledWith('airplay_discover');
    });

    it('should handle unavailable platform', async () => {
      const mockResult: AirPlayResult = { 
        kind: 'unavailable', 
        reason: 'Platform not supported' 
      };
      mockInvoke.mockResolvedValue(mockResult);
      
      const result = await airplay.discoverDevices();
      expect(result.kind).toBe('unavailable');
    });
  });

  describe('stopDiscovery', () => {
    it('should stop device discovery', async () => {
      const mockResult: AirPlayResult = { kind: 'ok' };
      mockInvoke.mockResolvedValue(mockResult);
      
      const result = await airplay.stopDiscovery();
      expect(result).toEqual(mockResult);
      expect(mockInvoke).toHaveBeenCalledWith('airplay_stop_discovery');
    });
  });

  describe('getDevices', () => {
    it('should return list of discovered devices', async () => {
      const mockDevices: AirPlayDevice[] = [
        {
          id: 'device-001',
          name: 'Living Room Apple TV',
          kind: 'appletv',
          supports_video: true,
          supports_audio: true,
          supports_mirroring: true,
          signal_strength: 90,
          connected: false,
        },
        {
          id: 'device-002',
          name: 'HomePod Mini',
          kind: 'audio',
          supports_video: false,
          supports_audio: true,
          supports_mirroring: false,
          signal_strength: 75,
          connected: false,
        },
      ];
      mockInvoke.mockResolvedValue(mockDevices);
      
      const result = await airplay.getDevices();
      expect(result).toEqual(mockDevices);
      expect(mockInvoke).toHaveBeenCalledWith('airplay_get_devices');
    });

    it('should return empty array when no devices found', async () => {
      mockInvoke.mockResolvedValue([]);
      const result = await airplay.getDevices();
      expect(result).toEqual([]);
    });
  });

  describe('getStatus', () => {
    it('should return current AirPlay status', async () => {
      const mockStatus: AirPlayStatus = {
        active: false,
        device: null,
        stream_kind: null,
        playing: false,
        volume: 0.7,
      };
      mockInvoke.mockResolvedValue(mockStatus);
      
      const result = await airplay.getStatus();
      expect(result).toEqual(mockStatus);
      expect(mockInvoke).toHaveBeenCalledWith('airplay_get_status');
    });

    it('should return active status with connected device', async () => {
      const mockDevice: AirPlayDevice = {
        id: 'device-001',
        name: 'Living Room Apple TV',
        kind: 'appletv',
        supports_video: true,
        supports_audio: true,
        supports_mirroring: true,
        signal_strength: 90,
        connected: true,
      };
      const mockStatus: AirPlayStatus = {
        active: true,
        device: mockDevice,
        stream_kind: 'video',
        playing: true,
        volume: 0.8,
      };
      mockInvoke.mockResolvedValue(mockStatus);
      
      const result = await airplay.getStatus();
      expect(result.active).toBe(true);
      expect(result.device).toEqual(mockDevice);
      expect(result.stream_kind).toBe('video');
    });
  });

  describe('connect', () => {
    it('should connect to a device', async () => {
      const mockResult: AirPlayResult = { kind: 'ok' };
      mockInvoke.mockResolvedValue(mockResult);
      
      const result = await airplay.connect('device-001');
      expect(result).toEqual(mockResult);
      expect(mockInvoke).toHaveBeenCalledWith('airplay_connect', { deviceId: 'device-001' });
    });

    it('should handle device not found', async () => {
      const mockResult: AirPlayResult = { kind: 'devicenotfound' };
      mockInvoke.mockResolvedValue(mockResult);
      
      const result = await airplay.connect('nonexistent-device');
      expect(result.kind).toBe('devicenotfound');
    });

    it('should handle connection failure', async () => {
      const mockResult: AirPlayResult = { 
        kind: 'failed', 
        reason: 'Connection timeout' 
      };
      mockInvoke.mockResolvedValue(mockResult);
      
      const result = await airplay.connect('device-001');
      expect(result.kind).toBe('failed');
    });
  });

  describe('disconnect', () => {
    it('should disconnect from current device', async () => {
      const mockResult: AirPlayResult = { kind: 'ok' };
      mockInvoke.mockResolvedValue(mockResult);
      
      const result = await airplay.disconnect();
      expect(result).toEqual(mockResult);
      expect(mockInvoke).toHaveBeenCalledWith('airplay_disconnect');
    });
  });

  describe('startStream', () => {
    it('should start audio stream', async () => {
      const mockResult: AirPlayResult = { kind: 'ok' };
      mockInvoke.mockResolvedValue(mockResult);
      
      const result = await airplay.startStream('audio');
      expect(result).toEqual(mockResult);
      expect(mockInvoke).toHaveBeenCalledWith('airplay_start_stream', { 
        kind: 'audio', 
        url: null 
      });
    });

    it('should start video stream with URL', async () => {
      const mockResult: AirPlayResult = { kind: 'ok' };
      mockInvoke.mockResolvedValue(mockResult);
      
      const result = await airplay.startStream('video', 'file:///path/to/video.mp4');
      expect(result).toEqual(mockResult);
      expect(mockInvoke).toHaveBeenCalledWith('airplay_start_stream', { 
        kind: 'video', 
        url: 'file:///path/to/video.mp4' 
      });
    });

    it('should start screen mirroring', async () => {
      const mockResult: AirPlayResult = { kind: 'ok' };
      mockInvoke.mockResolvedValue(mockResult);
      
      const result = await airplay.startStream('mirroring');
      expect(result).toEqual(mockResult);
      expect(mockInvoke).toHaveBeenCalledWith('airplay_start_stream', { 
        kind: 'mirroring', 
        url: null 
      });
    });
  });

  describe('stopStream', () => {
    it('should stop active stream', async () => {
      const mockResult: AirPlayResult = { kind: 'ok' };
      mockInvoke.mockResolvedValue(mockResult);
      
      const result = await airplay.stopStream();
      expect(result).toEqual(mockResult);
      expect(mockInvoke).toHaveBeenCalledWith('airplay_stop_stream');
    });
  });

  describe('setVolume', () => {
    it('should set volume to 0.5', async () => {
      const mockResult: AirPlayResult = { kind: 'ok' };
      mockInvoke.mockResolvedValue(mockResult);
      
      const result = await airplay.setVolume(0.5);
      expect(result).toEqual(mockResult);
      expect(mockInvoke).toHaveBeenCalledWith('airplay_set_volume', { volume: 0.5 });
    });

    it('should set volume to minimum (0.0)', async () => {
      const mockResult: AirPlayResult = { kind: 'ok' };
      mockInvoke.mockResolvedValue(mockResult);
      
      const result = await airplay.setVolume(0.0);
      expect(result).toEqual(mockResult);
      expect(mockInvoke).toHaveBeenCalledWith('airplay_set_volume', { volume: 0.0 });
    });

    it('should set volume to maximum (1.0)', async () => {
      const mockResult: AirPlayResult = { kind: 'ok' };
      mockInvoke.mockResolvedValue(mockResult);
      
      const result = await airplay.setVolume(1.0);
      expect(result).toEqual(mockResult);
      expect(mockInvoke).toHaveBeenCalledWith('airplay_set_volume', { volume: 1.0 });
    });

    it('should handle invalid volume values', async () => {
      const mockResult: AirPlayResult = { 
        kind: 'failed', 
        reason: 'Volume must be between 0.0 and 1.0' 
      };
      mockInvoke.mockResolvedValue(mockResult);
      
      const result = await airplay.setVolume(1.5);
      expect(result.kind).toBe('failed');
    });
  });

  describe('error handling', () => {
    it('should handle network errors', async () => {
      mockInvoke.mockRejectedValue(new Error('Network error'));
      
      await expect(airplay.getDevices()).rejects.toThrow('Network error');
    });

    it('should handle permission denied', async () => {
      const mockResult: AirPlayResult = { 
        kind: 'permissiondenied', 
        reason: 'Local network permission denied' 
      };
      mockInvoke.mockResolvedValue(mockResult);
      
      const result = await airplay.discoverDevices();
      expect(result.kind).toBe('permissiondenied');
    });
  });
});
