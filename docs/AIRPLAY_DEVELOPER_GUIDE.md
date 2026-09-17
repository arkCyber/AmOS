# AirPlay 开发者指南

## 快速开始

### 前端集成

```typescript
import * as airplay from '../lib/airplay';

// 1. 检查平台支持
const available = await airplay.isAirPlayAvailable();
if (!available) {
  console.log('AirPlay not supported on this platform');
  return;
}

// 2. 开始设备发现
await airplay.discoverDevices();

// 3. 获取设备列表
const devices = await airplay.getDevices();
console.log(`Found ${devices.length} devices`);

// 4. 连接到设备
const result = await airplay.connect(devices[0].id);
if (result.kind === 'ok') {
  console.log('Connected successfully');
}

// 5. 开始流媒体
await airplay.startStream('audio', 'https://example.com/audio.mp3');

// 6. 控制音量
await airplay.setVolume(0.8);

// 7. 停止流媒体
await airplay.stopStream();

// 8. 断开连接
await airplay.disconnect();

// 9. 停止设备发现
await airplay.stopDiscovery();
```

### Svelte 组件集成

```svelte
<script lang="ts">
  import { onMount } from 'svelte';
  import * as airplay from '../lib/airplay';
  
  let devices = $state<AirPlayDevice[]>([]);
  let status = $state<AirPlayStatus | null>(null);
  
  onMount(async () => {
    // 检查支持
    if (!(await airplay.isAirPlayAvailable())) return;
    
    // 开始发现
    await airplay.discoverDevices();
    
    // 定期更新设备列表
    const interval = setInterval(async () => {
      devices = await airplay.getDevices();
      status = await airplay.getStatus();
    }, 3000);
    
    return () => {
      clearInterval(interval);
      airplay.stopDiscovery();
    };
  });
  
  async function handleConnect(deviceId: string) {
    const result = await airplay.connect(deviceId);
    if (result.kind === 'ok') {
      // 更新 UI
      status = await airplay.getStatus();
    }
  }
</script>

{#each devices as device}
  <button onclick={() => handleConnect(device.id)}>
    {device.name}
  </button>
{/each}
```

## API 参考

### 类型定义

#### `AirPlayDevice`
```typescript
interface AirPlayDevice {
  id: string;                    // 设备唯一标识符
  name: string;                  // 设备名称
  kind: DeviceKind;              // 设备类型
  supports_video: boolean;       // 是否支持视频
  supports_audio: boolean;       // 是否支持音频
  supports_mirroring: boolean;   // 是否支持镜像
  signal_strength: number;       // 信号强度 (0-100)
  connected: boolean;            // 是否已连接
}
```

#### `DeviceKind`
```typescript
type DeviceKind = 'appletv' | 'tv' | 'audio' | 'generic';
```

#### `AirPlayStatus`
```typescript
interface AirPlayStatus {
  active: boolean;               // 是否激活
  device: AirPlayDevice | null;  // 当前连接的设备
  stream_kind: StreamKind | null;// 流类型
  playing: boolean;              // 是否正在播放
  volume: number;                // 音量 (0.0-1.0)
}
```

#### `StreamKind`
```typescript
type StreamKind = 'audio' | 'video' | 'mirroring';
```

#### `AirPlayResult`
```typescript
type AirPlayResult =
  | { kind: 'ok' }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'permission_denied'; reason: string }
  | { kind: 'device_not_found' }
  | { kind: 'failed'; reason: string };
```

### 函数列表

#### `isAirPlayAvailable(): Promise<boolean>`
检查当前平台是否支持 AirPlay。

**返回**: 
- `true`: 支持 AirPlay（macOS/iOS）
- `false`: 不支持或在非 Tauri 环境

**示例**:
```typescript
if (await airplay.isAirPlayAvailable()) {
  // 初始化 AirPlay 功能
}
```

---

#### `discoverDevices(): Promise<AirPlayResult>`
开始扫描局域网内的 AirPlay 设备。

**返回**: 操作结果
- `{ kind: 'ok' }`: 成功启动
- `{ kind: 'unavailable', reason }`: 平台不支持
- `{ kind: 'failed', reason }`: 启动失败

**注意**: 
- 设备发现是异步的，调用后需等待 2-3 秒
- 应配合 `getDevices()` 定期轮询设备列表

**示例**:
```typescript
const result = await airplay.discoverDevices();
if (result.kind === 'ok') {
  // 等待 2 秒后获取设备
  await new Promise(r => setTimeout(r, 2000));
  const devices = await airplay.getDevices();
}
```

---

#### `stopDiscovery(): Promise<void>`
停止设备发现。

**注意**: 组件卸载时应调用此函数以释放资源。

**示例**:
```typescript
onDestroy(() => {
  airplay.stopDiscovery();
});
```

---

#### `getDevices(): Promise<AirPlayDevice[]>`
获取已发现的设备列表。

**返回**: 设备数组（可能为空）

**建议**: 每 3 秒轮询一次以获取最新设备列表。

**示例**:
```typescript
const devices = await airplay.getDevices();
const tvs = devices.filter(d => d.kind === 'appletv');
```

---

#### `getStatus(): Promise<AirPlayStatus | null>`
获取当前 AirPlay 状态。

**返回**: 
- `AirPlayStatus`: 当前状态
- `null`: 在非 Tauri 环境

**示例**:
```typescript
const status = await airplay.getStatus();
if (status?.active) {
  console.log(`Connected to ${status.device?.name}`);
}
```

---

#### `connect(deviceId: string): Promise<AirPlayResult>`
连接到指定设备。

**参数**:
- `deviceId`: 设备的 `id` 字段

**返回**: 操作结果
- `{ kind: 'ok' }`: 连接成功
- `{ kind: 'device_not_found' }`: 设备不存在
- `{ kind: 'failed', reason }`: 连接失败

**示例**:
```typescript
const result = await airplay.connect('device-id-123');
if (result.kind === 'ok') {
  // 更新 UI 显示已连接
}
```

---

#### `disconnect(): Promise<AirPlayResult>`
断开当前连接。

**返回**: 操作结果（总是成功，具有幂等性）

**示例**:
```typescript
await airplay.disconnect();
```

---

#### `startStream(kind: StreamKind, url?: string): Promise<AirPlayResult>`
开始流媒体传输。

**参数**:
- `kind`: 流类型 (`'audio'` | `'video'` | `'mirroring'`)
- `url`: 媒体 URL（可选，屏幕镜像不需要）

**返回**: 操作结果
- `{ kind: 'ok' }`: 开始成功
- `{ kind: 'failed', reason }`: 未连接设备或启动失败

**示例**:
```typescript
// 音频流
await airplay.startStream('audio', 'https://example.com/song.mp3');

// 视频流
await airplay.startStream('video', 'https://example.com/video.mp4');

// 屏幕镜像
await airplay.startStream('mirroring');
```

---

#### `stopStream(): Promise<AirPlayResult>`
停止当前流媒体。

**返回**: 操作结果（具有幂等性）

**示例**:
```typescript
await airplay.stopStream();
```

---

#### `setVolume(volume: number): Promise<AirPlayResult>`
设置播放音量。

**参数**:
- `volume`: 音量值 (0.0-1.0)
  - `0.0`: 静音
  - `1.0`: 最大音量

**注意**: 值会自动限制在 [0.0, 1.0] 范围内。

**示例**:
```typescript
await airplay.setVolume(0.8);  // 80% 音量
```

---

## 常见模式

### 1. 设备列表组件

```svelte
<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import * as airplay from '../lib/airplay';
  
  let available = $state(false);
  let devices = $state<AirPlayDevice[]>([]);
  let connecting = $state(false);
  let interval: number | null = null;
  
  onMount(async () => {
    available = await airplay.isAirPlayAvailable();
    if (!available) return;
    
    await airplay.discoverDevices();
    
    // 每 3 秒刷新一次
    interval = window.setInterval(async () => {
      devices = await airplay.getDevices();
    }, 3000);
  });
  
  onDestroy(() => {
    if (interval) clearInterval(interval);
    airplay.stopDiscovery();
  });
  
  async function handleConnect(deviceId: string) {
    connecting = true;
    const result = await airplay.connect(deviceId);
    connecting = false;
    
    if (result.kind !== 'ok') {
      alert(`Connection failed: ${result.kind}`);
    }
  }
</script>

{#if !available}
  <p>AirPlay is not available on this platform</p>
{:else if devices.length === 0}
  <p>Searching for devices...</p>
{:else}
  <ul>
    {#each devices as device}
      <li>
        <button 
          onclick={() => handleConnect(device.id)}
          disabled={connecting || device.connected}
        >
          {device.name}
          {#if device.connected}✓{/if}
        </button>
      </li>
    {/each}
  </ul>
{/if}
```

### 2. 媒体播放器集成

```svelte
<script lang="ts">
  import * as airplay from '../lib/airplay';
  
  let audioElement: HTMLAudioElement;
  let airplayStatus = $state<AirPlayStatus | null>(null);
  
  // 监听 AirPlay 状态
  $effect(() => {
    const checkStatus = async () => {
      airplayStatus = await airplay.getStatus();
    };
    const interval = setInterval(checkStatus, 1000);
    return () => clearInterval(interval);
  });
  
  async function playOnAirPlay() {
    const devices = await airplay.getDevices();
    if (devices.length === 0) {
      alert('No AirPlay devices found');
      return;
    }
    
    // 连接到第一个设备
    const result = await airplay.connect(devices[0].id);
    if (result.kind !== 'ok') return;
    
    // 开始流媒体
    const url = audioElement.src;
    await airplay.startStream('audio', url);
    
    // 同步音量
    await airplay.setVolume(audioElement.volume);
  }
  
  async function stopAirPlay() {
    await airplay.stopStream();
    await airplay.disconnect();
  }
</script>

<audio bind:this={audioElement} src="/audio.mp3" />

{#if airplayStatus?.active}
  <button onclick={stopAirPlay}>
    Stop AirPlay ({airplayStatus.device?.name})
  </button>
{:else}
  <button onclick={playOnAirPlay}>
    Play on AirPlay
  </button>
{/if}
```

### 3. 音量控制

```svelte
<script lang="ts">
  import * as airplay from '../lib/airplay';
  
  let volume = $state(0.7);
  let status = $state<AirPlayStatus | null>(null);
  
  $effect(() => {
    const loadStatus = async () => {
      status = await airplay.getStatus();
      if (status) volume = status.volume;
    };
    loadStatus();
    const interval = setInterval(loadStatus, 1000);
    return () => clearInterval(interval);
  });
  
  async function handleVolumeChange(e: Event) {
    const input = e.target as HTMLInputElement;
    volume = parseFloat(input.value);
    await airplay.setVolume(volume);
  }
</script>

{#if status?.active}
  <div>
    <label>Volume: {Math.round(volume * 100)}%</label>
    <input
      type="range"
      min="0"
      max="1"
      step="0.01"
      value={volume}
      oninput={handleVolumeChange}
    />
  </div>
{/if}
```

## 错误处理

### 处理所有可能的结果

```typescript
const result = await airplay.connect(deviceId);

switch (result.kind) {
  case 'ok':
    console.log('Connected successfully');
    break;
  
  case 'unavailable':
    console.error('AirPlay not available:', result.reason);
    break;
  
  case 'permission_denied':
    alert('Please enable local network access in Settings');
    console.error('Permission denied:', result.reason);
    break;
  
  case 'device_not_found':
    alert('Device not found. Please try again.');
    break;
  
  case 'failed':
    alert(`Connection failed: ${result.reason}`);
    break;
}
```

### 优雅降级

```typescript
// 检查环境
const isAirPlaySupported = await airplay.isAirPlayAvailable();

if (!isAirPlaySupported) {
  // 隐藏 AirPlay 按钮或显示不可用提示
  return;
}

// 继续正常流程
```

## 最佳实践

### 1. 资源清理
始终在组件卸载时停止设备发现：

```typescript
onDestroy(() => {
  airplay.stopDiscovery();
});
```

### 2. 轮询频率
设备列表和状态建议轮询频率：
- **设备列表**: 3 秒
- **连接状态**: 1 秒
- **播放状态**: 根据需求（通常不需要轮询）

### 3. 用户体验
- 显示"正在搜索..."状态
- 连接时显示加载指示器
- 显示信号强度（`device.signal_strength`）
- 提供重试机制

### 4. 错误提示
```typescript
function formatError(result: AirPlayResult): string {
  switch (result.kind) {
    case 'unavailable':
      return 'AirPlay is not supported on this device';
    case 'permission_denied':
      return 'Please enable local network access';
    case 'device_not_found':
      return 'Device not found';
    case 'failed':
      return `Operation failed: ${result.reason}`;
    default:
      return 'Success';
  }
}
```

### 5. 性能优化
```typescript
// 使用 AbortController 取消长轮询
const controller = new AbortController();

async function pollDevices() {
  while (!controller.signal.aborted) {
    devices = await airplay.getDevices();
    await new Promise(r => setTimeout(r, 3000));
  }
}

onDestroy(() => {
  controller.abort();
});
```

## 调试

### 启用调试日志

Rust 端:
```bash
RUST_LOG=amos_tauri::airplay=debug cargo run
```

浏览器控制台:
```typescript
// 在调用 API 前后打印日志
console.log('[AirPlay] Discovering devices...');
const result = await airplay.discoverDevices();
console.log('[AirPlay] Result:', result);

const devices = await airplay.getDevices();
console.log('[AirPlay] Devices:', devices);
```

### 常见问题

#### Q: `getDevices()` 返回空数组
**A**: 
1. 确保已调用 `discoverDevices()`
2. 等待 2-3 秒后再调用 `getDevices()`
3. 检查 Info.plist 权限配置
4. 检查防火墙设置

#### Q: `connect()` 返回 `device_not_found`
**A**:
1. 设备可能已离线
2. 重新调用 `discoverDevices()` 刷新列表
3. 检查网络连接

#### Q: iOS 上无法发现设备
**A**:
1. 确保 Info.plist 包含 `NSLocalNetworkUsageDescription`
2. 确保 Info.plist 包含 `NSBonjourServices`
3. 用户必须授权本地网络访问（首次会弹窗）

#### Q: `startStream()` 失败
**A**:
1. 确保已连接到设备（`status.active === true`）
2. 检查媒体 URL 是否可访问
3. 检查设备是否支持该流类型

## 平台差异

| 功能 | macOS | iOS | 其他 |
|-----|-------|-----|------|
| 设备发现 | ✅ | ✅ | ❌ |
| 音频流 | ✅ | ✅ | ❌ |
| 视频流 | ✅ | ✅ | ❌ |
| 屏幕镜像 | ⚠️ 计划中 | ⚠️ 计划中 | ❌ |
| 音量控制 | ✅ | ✅ | ❌ |

## 相关资源

### 内部文档
- `AIRPLAY_IMPLEMENTATION_REPORT.md` - 完整实现报告
- `AIRPLAY_PLATFORM_INTEGRATION.md` - 平台集成详情
- `AIRPLAY_完成总结.md` - 中文总结

### 代码位置
- 前端 API: `crates/amos-tauri/frontend-ts/src/lib/airplay.ts`
- Rust 后端: `crates/amos-tauri/src/airplay.rs`
- UI 组件: `crates/amos-tauri/frontend-ts/src/svelte/AirPlayPanel.svelte`
- 测试: `crates/amos-tauri/src/airplay_tests.rs`

### Apple 官方文档
- [AVFoundation Programming Guide](https://developer.apple.com/documentation/avfoundation)
- [AVRouteDetector](https://developer.apple.com/documentation/avfoundation/avroutedetector)
- [AVAudioSession](https://developer.apple.com/documentation/avfaudio/avaudiosession)

---

最后更新: 2026-09-17  
版本: 1.0
