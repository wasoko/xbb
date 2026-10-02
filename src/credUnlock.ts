// credUnlock.ts — webapp-side credential unlock for Win10 login via the Rust
// unlock server (retr/src/unlock.rs, port of pcbu-desktop core logic).
// Replicates the mobile-app side of PC Bio Unlock:
//   1. scan QR to link with the pc desktop app (pairing persisted in localStorage)
//   2. sendUnlock() — webapp-initiated unlock
//   3. listenUnlockPush() — SSE push from the PC lock screen + Notification prompt
//
// Crypto mirrors CryptUtils (see unlock.rs): AES-256-GCM, PBKDF2-HMAC-SHA256
// (65535 iters), layout iv(16) || salt(16) || gcm_ct || tag(16), 8-byte
// big-endian timestamp prefix. Web Crypto is unavailable in non-secure contexts
// (plain http://<lan-ip>), so callers fall back to plain passwordKey in the body.

import 'barcode-detector-polyfill/dist/BarcodeDetector.js';

const LS_KEY = 'credUnlock.pairedDevices'
const PAIRING_PROTOCOL_VERSION = '4.0.0'
const IV_SIZE = 16
const SALT_SIZE = 16
const PBKDF2_ITERATIONS = 65535
const CRYPT_TIMEOUT_MS = 120_000 // mirrors CRYPT_PACKET_TIMEOUT

// ---- types ----------------------------------------------------------------

export interface QrPayload {
  serverId?: string
  port?: number
  method?: string
  encKey: string
  baseUrl?: string
}

export interface PairedCredDevice {
  serverUrl: string
  deviceId: string
  deviceName: string
  deviceOS: string
  pairingMethod: string
  userName: string
  passwordKey: string
  encryptionKey: string
}

export interface UnlockEvent {
  unlockToken: string
  user: string
  program: string
  createdMs: number
}

export interface UnlockResultEvent {
  unlockToken: string
  state: string
}

export interface UnlockResult {
  state: string
  ok: boolean
  exitCode: number // 0 = success, 1 = auth fail/cancel, -1 = other (like pcbu_auth)
  message: string
  unlockToken?: string
  deviceId?: string
}

export interface UnlockPushHandlers {
  onRequest?: (ev: UnlockEvent) => void
  onResult?: (ev: UnlockResultEvent) => void
  onError?: (err: Event) => void
}

// ---- pairing persistence (localStorage) ------------------------------------

function uuidv4(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c =>
    (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)
  );
}

export function loadPairedDevices(): PairedCredDevice[] {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) ?? '[]') as PairedCredDevice[]
  } catch {
    return []
  }
}

export function savePairedDevices(devs: PairedCredDevice[]): void {
  localStorage.setItem(LS_KEY, JSON.stringify(devs))
}

export function upsertPairedDevice(dev: PairedCredDevice): void {
  savePairedDevices([...loadPairedDevices().filter((d) => d.deviceId !== dev.deviceId), dev])
}

export function removePairedDevice(deviceId: string): void {
  savePairedDevices(loadPairedDevices().filter((d) => d.deviceId !== deviceId))
}

// ---- crypto (mirrors unlock.rs CryptUtils) ---------------------------------

const hexToBytes = (hexStr: string): Uint8Array => {
  const out = new Uint8Array(hexStr.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hexStr.slice(i * 2, i * 2 + 2), 16)
  return out
}

const bytesToHex = (b: Uint8Array): string =>
  Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('')

export function webcrypto(): SubtleCrypto | null {
  return typeof crypto !== 'undefined' ? crypto.subtle : null
}

async function deriveAesGcmKey(password: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const subtle = webcrypto()
  if (!subtle) throw new Error('WebCrypto unavailable (non-secure context)')
  const baseKey = await subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey'])
  return subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITERATIONS },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

/** Encrypts like CryptUtils::EncryptAESPacket: timestamp prefix + iv||salt||ct||tag, hex-encoded. */
export async function encryptAesPacketHex(data: Uint8Array, password: string): Promise<string> {
  const subtle = webcrypto()
  if (!subtle) throw new Error('WebCrypto unavailable (non-secure context)')
  const iv = crypto.getRandomValues(new Uint8Array(IV_SIZE))
  const salt = crypto.getRandomValues(new Uint8Array(SALT_SIZE))
  const key = await deriveAesGcmKey(password, salt)
  const tsBytes = new Uint8Array(8)
  new DataView(tsBytes.buffer).setBigInt64(0, BigInt(Date.now()), false) // big-endian, mirrors htonll
  const plain = new Uint8Array(8 + data.length)
  plain.set(tsBytes, 0)
  plain.set(data, 8)
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, plain))
  const out = new Uint8Array(IV_SIZE + SALT_SIZE + ct.length)
  out.set(iv, 0)
  out.set(salt, IV_SIZE)
  out.set(ct, IV_SIZE + SALT_SIZE)
  return bytesToHex(out)
}

/** Builds {encData} when WebCrypto works, else falls back to plain {passwordKey}. */
async function encryptedOrPlain(payload: Record<string, string>, device: PairedCredDevice): Promise<Record<string, unknown>> {
  if (webcrypto()) {
    const enc = await encryptAesPacketHex(new TextEncoder().encode(JSON.stringify(payload)), device.encryptionKey)
    return { encData: enc }
  }
  return { passwordKey: payload.passwordKey ?? '' }
}

// ---- 1. scan QR to link with the pc desktop app -----------------------------

// BarcodeDetector is experimental; declare a minimal shape (Chrome/Android support it).
declare global {
  interface Window {
    BarcodeDetector?: new (opts?: { formats?: string[] }) => {
      detect: (src: CanvasImageSource) => Promise<Array<{ format: string; rawValue: string }>>
    }
  }
}

/** Opens the camera and scans a QR until a JSON payload matching QrPayload is decoded. */
export async function scanQrData(): Promise<QrPayload> {
  const BarcodeDetector = window.BarcodeDetector
  if (!BarcodeDetector) throw new Error('BarcodeDetector not supported in this browser')
  const detector = new BarcodeDetector({ formats: ['qr_code'] })
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
  const video = document.createElement('video')
  video.srcObject = stream
  await video.play()
  try {
    for (;;) {
      const codes = await detector.detect(video)
      for (const code of codes) {
        try {
          const payload = JSON.parse(code.rawValue) as QrPayload
          if (payload?.encKey) return payload
        } catch {
          // not our QR — keep scanning
        }
      }
      await new Promise((r) => setTimeout(r, 250))
    }
  } finally {
    stream.getTracks().forEach((t) => t.stop())
  }
}

/** Completes pairing against the Rust server and persists the device in localStorage. */
export async function pairWithQr(qr: QrPayload, opts?: { serverUrl?: string }): Promise<PairedCredDevice> {
  const serverUrl = (opts?.serverUrl ?? qr.baseUrl ?? '').replace(/\/+$/, '')
  if (!serverUrl) throw new Error('QR payload has no server URL')
  const body = {
    protoVersion: PAIRING_PROTOCOL_VERSION,
    deviceUUID: uuidv4(),
    deviceName: navigator.userAgent.slice(0, 64),
    ipAddress: '',
    tcpPort: 0,
    udpPort: 0,
    udpManualPort: 0,
    cloudToken: '',
    encKey: qr.encKey,
  }
  const res = await fetch(`${serverUrl}/api/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const resp = (await res.json()) as { errMsg?: string; data?: Record<string, unknown> }
  if (!res.ok || resp.errMsg || !resp.data) throw new Error(resp.errMsg || `pair failed: HTTP ${res.status}`)
  const device: PairedCredDevice = {
    serverUrl,
    deviceId: String(resp.data.deviceId),
    deviceName: String(resp.data.deviceName ?? ''),
    deviceOS: String(resp.data.deviceOS ?? ''),
    pairingMethod: String(resp.data.pairingMethod ?? 'WEB'),
    userName: String(resp.data.userName ?? ''),
    passwordKey: String(resp.data.passwordKey ?? ''),
    encryptionKey: qr.encKey,
  }
  upsertPairedDevice(device)
  return device
}

/** Convenience: scan QR then pair, in one call. */
export async function scanQrToPair(): Promise<PairedCredDevice> {
  return pairWithQr(await scanQrData())
}

// ---- 2. sendUnlock — webapp-initiated unlock --------------------------------

export async function sendUnlock(device: PairedCredDevice): Promise<UnlockResult> {
  const enc = await encryptedOrPlain({ passwordKey: device.passwordKey }, device)
  const res = await fetch(`${device.serverUrl}/api/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId: device.deviceId, ...enc }),
  })
  return (await res.json()) as UnlockResult
}

/** Responds to a pushed unlock request (approve) or cancels it via DELETE. */
export async function respondUnlock(device: PairedCredDevice, unlockToken: string, opts?: { approve?: boolean }): Promise<UnlockResult> {
  if (opts?.approve === false) {
    const res = await fetch(`${device.serverUrl}/api/unlock/request/${unlockToken}`, { method: 'DELETE' })
    return (await res.json()) as UnlockResult
  }
  const enc = await encryptedOrPlain({ unlockToken, passwordKey: device.passwordKey }, device)
  const res = await fetch(`${device.serverUrl}/api/unlock/respond`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ unlockToken, deviceId: device.deviceId, ...enc }),
  })
  return (await res.json()) as UnlockResult
}

// ---- 3. listen push — prompt device notification to unlock -------------------

const eventSources = new Map<string, EventSource>()

/** Subscribes to SSE unlock push for a device. Returns a close function. */
export function listenUnlockPush(device: PairedCredDevice, handlers: UnlockPushHandlers = {}): () => void {
  closeUnlockPush(device.serverUrl)
  const es = new EventSource(`${device.serverUrl}/api/events`)
  eventSources.set(device.serverUrl, es)
  es.addEventListener('unlock_request', (e) => {
    try {
      handlers.onRequest?.(JSON.parse((e as MessageEvent).data) as UnlockEvent)
    } catch {
      // ignore malformed events
    }
  })
  es.addEventListener('unlock_result', (e) => {
    try {
      handlers.onResult?.(JSON.parse((e as MessageEvent).data) as UnlockResultEvent)
    } catch {
      // ignore malformed events
    }
  })
  es.onerror = (err) => handlers.onError?.(err)
  return () => closeUnlockPush(device.serverUrl)
}

export function closeUnlockPush(serverUrl: string): void {
  eventSources.get(serverUrl)?.close()
  eventSources.delete(serverUrl)
}

/** Asks for Notification permission (secure contexts only; returns false otherwise). */
export async function requestNotifyPermission(): Promise<boolean> {
  if (typeof Notification === 'undefined') return false
  if (Notification.permission === 'granted') return true
  return (await Notification.requestPermission()) === 'granted'
}

/**
 * Shows a device notification (or confirm() fallback) for a pushed unlock
 * request and responds according to the user's choice.
 */
export async function promptUnlockNotification(ev: UnlockEvent, device: PairedCredDevice): Promise<UnlockResult> {
  if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    const n = new Notification('PC unlock requested', {
      body: `${ev.user} wants to unlock ${device.deviceName}`,
      requireInteraction: true,
    })
    const approved = await new Promise<boolean>((resolve) => {
      const done = (v: boolean) => {
        n.close()
        resolve(v)
      }
      n.onclick = () => done(true)
      n.onclose = () => resolve(false)
      setTimeout(() => done(false), CRYPT_TIMEOUT_MS)
    })
    return respondUnlock(device, ev.unlockToken, { approve: approved })
  }
  const approved = confirm(`Unlock ${device.deviceName} for ${ev.user}?`)
  return respondUnlock(device, ev.unlockToken, { approve: approved })
}

/** One-call setup: notify permission + SSE push + notification prompt for one device. */
export async function watchUnlockPrompt(device: PairedCredDevice): Promise<() => void> {
  await requestNotifyPermission()
  return listenUnlockPush(device, {
    onRequest: (ev) => void promptUnlockNotification(ev, device),
  })
}

// re-export for unit tests
export const _cryptoInternals = { hexToBytes, bytesToHex }
