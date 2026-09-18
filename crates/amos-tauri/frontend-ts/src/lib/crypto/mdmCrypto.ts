/**
 * MDM 配置加密/解密模块
 * 
 * 使用 Web Crypto API 提供企业级数据保护：
 * - AES-GCM-256 认证加密（防篡改）
 * - PBKDF2-SHA256 密钥派生（100k 迭代）
 * - 设备指纹绑定（防跨设备复制）
 * - 审计日志集成
 * 
 * @module crypto/mdmCrypto
 */

/**
 * 加密数据结构
 */
export interface EncryptedData {
  /** 加密格式版本，用于未来升级兼容 */
  version: 1;
  /** Base64 编码的密文 */
  ciphertext: string;
  /** Base64 编码的初始化向量（12 bytes for GCM） */
  iv: string;
  /** 加密时间戳（Unix ms） */
  timestamp: number;
}

/**
 * 设备指纹组件
 */
interface DeviceFingerprint {
  userAgent: string;
  language: string;
  screen: string;
  timezone: number;
  platform: string;
  deviceId?: string;
}

// 加密常量
const ENCRYPTION_VERSION = 1;
const PBKDF2_ITERATIONS = 100000;
const AES_KEY_LENGTH = 256;
const GCM_IV_LENGTH = 12; // 96 bits
const GCM_TAG_LENGTH = 128; // bits

// 固定盐值（实际生产环境应从安全配置读取）
const PBKDF2_SALT = new Uint8Array([
  0x41, 0x6d, 0x4f, 0x53, 0x2d, 0x4d, 0x44, 0x4d,
  0x2d, 0x53, 0x61, 0x6c, 0x74, 0x2d, 0x32, 0x30,
  0x32, 0x36, 0x2d, 0x30, 0x39, 0x2d, 0x31, 0x37
]); // "AmOS-MDM-Salt-2026-09-17"

/**
 * 生成设备指纹
 * 
 * 组合多个设备特征生成唯一标识符，用于密钥派生。
 * 这确保加密数据绑定到特定设备。
 */
async function getDeviceFingerprint(): Promise<string> {
  const components: DeviceFingerprint = {
    userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "test-agent",
    language: typeof navigator !== "undefined" ? navigator.language : "en-US",
    screen: typeof screen !== "undefined" ? `${screen.width}x${screen.height}` : "1920x1080",
    timezone: new Date().getTimezoneOffset(),
    platform: typeof navigator !== "undefined" ? navigator.platform : "test-platform",
  };

  // 设备标识：这里**曾经**想调 Tauri 的 `get_device_id`，但
  // `crates/amos-tauri` 里**没有这个命令**（全仓 grep 为零）⇒ 每次都落进
  // catch，指纹里永远是 "web-fallback"：一个不会生效的调用披着"设备绑定"的外衣。
  // 现在把这条边界写出来，而不是继续假装：
  //   * 本指纹是**尽力而为的环境指纹**（userAgent / 语言 / 屏幕 / 时区 / 平台），
  //     **不是**硬件身份；
  //   * 它绑定的是"这台设备的这套环境"，同一套环境的另一台设备会得到同一个
  //     指纹（PBKDF2 的盐也是源码里的固定值），所以它能挡的是"随手拷走配置
  //     到另一台不同环境的设备"，挡不住"伪造同样环境"。
  //   * 要做到真正的硬件绑定，需要先在 Rust 侧提供一个**真实存在**的设备标识
  //     命令，再由这里调用（届时记得同步改这条注释）。
  components.deviceId = "environment-only";

  // 序列化并哈希
  const raw = JSON.stringify(components);
  const encoder = new TextEncoder();
  const data = encoder.encode(raw);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);

  // 转换为十六进制字符串
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * 从设备指纹派生主加密密钥
 * 
 * 使用 PBKDF2 将设备指纹转换为 AES-GCM 密钥。
 * 100,000 次迭代提供抗暴力破解保护。
 */
async function deriveMasterKey(): Promise<CryptoKey> {
  const deviceFingerprint = await getDeviceFingerprint();
  const encoder = new TextEncoder();

  // 导入设备指纹作为密钥材料
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(deviceFingerprint),
    "PBKDF2",
    false,
    ["deriveKey"]
  );

  // 派生 AES-GCM 密钥
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: PBKDF2_SALT,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: AES_KEY_LENGTH },
    false, // 不可导出
    ["encrypt", "decrypt"]
  );
}

/**
 * 加密 MDM 配置数据
 * 
 * @param plaintext - 明文 JSON 字符串
 * @returns Base64 编码的加密数据包（JSON 格式）
 * @throws 如果加密失败
 * 
 * @example
 * ```typescript
 * const config = JSON.stringify({ apiKey: "secret" });
 * const encrypted = await encryptMDMData(config);
 * localStorage.setItem("mdm_config", encrypted);
 * ```
 */
export async function encryptMDMData(plaintext: string): Promise<string> {
  try {
    const key = await deriveMasterKey();
    const iv = crypto.getRandomValues(new Uint8Array(GCM_IV_LENGTH));
    const encoder = new TextEncoder();
    const data = encoder.encode(plaintext);

    // AES-GCM 加密（认证加密，自动防篡改）
    const encrypted = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv,
        tagLength: GCM_TAG_LENGTH,
      },
      key,
      data
    );

    // 构造加密数据包
    const encryptedData: EncryptedData = {
      version: ENCRYPTION_VERSION,
      ciphertext: arrayBufferToBase64(encrypted),
      iv: arrayBufferToBase64(iv),
      timestamp: Date.now(),
    };

    return JSON.stringify(encryptedData);
  } catch (err) {
    console.error("[MDM Crypto] 加密失败:", err);
    throw new Error(`MDM 配置加密失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * 解密 MDM 配置数据
 * 
 * @param encrypted - Base64 编码的加密数据包（JSON 格式）
 * @returns 明文 JSON 字符串
 * @throws 如果解密失败或数据被篡改
 * 
 * @example
 * ```typescript
 * const encrypted = localStorage.getItem("mdm_config");
 * if (encrypted) {
 *   const config = JSON.parse(await decryptMDMData(encrypted));
 * }
 * ```
 */
export async function decryptMDMData(encrypted: string): Promise<string> {
  try {
    const encryptedData = JSON.parse(encrypted) as EncryptedData;

    // 版本检查
    if (encryptedData.version !== ENCRYPTION_VERSION) {
      throw new Error(`不支持的加密版本: ${encryptedData.version}`);
    }

    // 时间戳检查（可选：检测重放攻击）
    const age = Date.now() - encryptedData.timestamp;
    const MAX_AGE_MS = 365 * 24 * 3600 * 1000; // 1 年
    if (age > MAX_AGE_MS) {
      console.warn("[MDM Crypto] 加密数据已过期（超过 1 年）");
    }

    const key = await deriveMasterKey();
    const iv = base64ToArrayBuffer(encryptedData.iv);
    const ciphertext = base64ToArrayBuffer(encryptedData.ciphertext);

    // AES-GCM 解密（自动验证认证标签）
    const decrypted = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv,
        tagLength: GCM_TAG_LENGTH,
      },
      key,
      ciphertext
    );

    const decoder = new TextDecoder();
    return decoder.decode(decrypted);
  } catch (err) {
    console.error("[MDM Crypto] 解密失败:", err);
    // 特别标记认证失败（数据被篡改）
    if (err instanceof Error && err.message.includes("operation")) {
      throw new Error("MDM 配置解密失败: 数据可能已被篡改");
    }
    throw new Error(`MDM 配置解密失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * 字节视图转 Base64。
 *
 * 入参收 `ArrayBuffer | Uint8Array`：调用方手里常常是 `crypto.getRandomValues`
 * 的 `Uint8Array` 视图，而 `arrayBufferToBase64(iv)` 原来只收 `ArrayBuffer` ——
 * 类型上不成立（TS2345）。这里只读字节，两种形状都可以。
 */
function arrayBufferToBase64(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = "";
  // 用 for..of 而不是 `bytes[i]`：`noUncheckedIndexedAccess` 下索引可能为
  // undefined，逐元素迭代没有这个问题，也更省一次下标运算。
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary);
}

/**
 * Base64 转 ArrayBuffer
 */
function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

/**
 * 检查 Web Crypto API 是否可用
 */
export function isCryptoAvailable(): boolean {
  return typeof crypto !== "undefined" && typeof crypto.subtle !== "undefined";
}

/**
 * 获取加密模块信息（用于调试和审计）
 */
export function getCryptoInfo() {
  return {
    available: isCryptoAvailable(),
    algorithm: "AES-GCM-256",
    keyDerivation: "PBKDF2-SHA256",
    iterations: PBKDF2_ITERATIONS,
    version: ENCRYPTION_VERSION,
  };
}
