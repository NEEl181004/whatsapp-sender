import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  prepareWAMessageMedia,
  generateWAMessageFromContent,
  Browsers
} from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import { contactsDb } from './contactsDb.js';

const SESSIONS_BASE_DIR = path.resolve(process.cwd(), 'auth_info_baileys', 'sessions');

export class WhatsAppSession extends EventEmitter {
  constructor(sessionId) {
    super();
    this.sessionId = sessionId;
    this.authFolder = path.join(SESSIONS_BASE_DIR, sessionId);
    this.sock = null;
    this.status = 'disconnected'; // 'disconnected' | 'connecting' | 'qr_ready' | 'connected'
    this.qrCodeDataUrl = null;
    this.userInfo = null;
    this.accountPhone = null;
    this.isExplicitLogout = false;
    this.reconnectTimer = null;
    this._isClearingAuth = false;
  }

  hasSavedCredentials() {
    const credsPath = path.join(this.authFolder, 'creds.json');
    if (!fs.existsSync(credsPath)) return false;
    try {
      const data = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
      return Boolean(data && data.me);
    } catch {
      return false;
    }
  }

  async init() {
    try {
      this.status = 'connecting';
      this.emit('status', { status: this.status, sessionId: this.sessionId });

      if (!fs.existsSync(this.authFolder)) {
        fs.mkdirSync(this.authFolder, { recursive: true });
      }

      // Check for malformed creds.json
      const credsPath = path.join(this.authFolder, 'creds.json');
      if (fs.existsSync(credsPath)) {
        try {
          JSON.parse(fs.readFileSync(credsPath, 'utf8'));
        } catch (parseErr) {
          console.warn(`[Baileys Auth ${this.sessionId}] Malformed creds.json, purging...`);
          await this.clearAuthFolder();
          fs.mkdirSync(this.authFolder, { recursive: true });
        }
      }

      const { state, saveCreds } = await useMultiFileAuthState(this.authFolder);
      const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: [2, 3000, 1015901307] }));

      const makeSocket = makeWASocket.default || makeWASocket;

      this.sock = makeSocket({
        version,
        logger: pino({ level: 'silent' }),
        auth: state,
        printQRInTerminal: false,
        browser: Browsers.ubuntu('Chrome'),
        syncFullHistory: false,
        shouldSyncHistoryMessage: () => false,
        generateHighQualityLinkPreview: false,
        markOnlineOnConnect: false
      });

      this.sock.ev.on('creds.update', saveCreds);

      this.sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          try {
            this.status = 'qr_ready';
            this.qrCodeDataUrl = await QRCode.toDataURL(qr, { margin: 2, scale: 7 });
            this.emit('qr', { qrDataUrl: this.qrCodeDataUrl, sessionId: this.sessionId });
            this.emit('status', { status: this.status, qrDataUrl: this.qrCodeDataUrl, sessionId: this.sessionId });
          } catch (qrErr) {
            console.error(`[Baileys ${this.sessionId}] QR Generation Error:`, qrErr);
          }
        }

        if (connection === 'close') {
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          const shouldReconnect = statusCode !== 401 && statusCode !== 403 && !this.isExplicitLogout;

          console.log(`[WhatsApp ${this.sessionId}] connection closed (${statusCode}). Reconnecting: ${shouldReconnect}`);

          if (statusCode === 401 || statusCode === 403 || this.isExplicitLogout) {
            this.status = 'disconnected';
            this.userInfo = null;
            this.accountPhone = null;
            this.qrCodeDataUrl = null;
            this.emit('status', { status: this.status, sessionId: this.sessionId });
            await this.clearAuthFolder();
          } else if (shouldReconnect) {
            this.status = 'connecting';
            this.emit('status', { status: this.status, sessionId: this.sessionId });
            if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
            this.reconnectTimer = setTimeout(() => this.init(), 2000);
          }
        } else if (connection === 'open') {
          this.status = 'connected';
          this.qrCodeDataUrl = null;
          this.isExplicitLogout = false;

          const rawUser = this.sock.user;
          const cleanPhone = rawUser?.id ? rawUser.id.split(':')[0].split('@')[0] : '';
          this.accountPhone = cleanPhone;

          this.userInfo = {
            id: rawUser?.id || '',
            phone: cleanPhone,
            name: rawUser?.name || rawUser?.verifiedName || `WhatsApp User (+${cleanPhone})`
          };

          console.log(`[WhatsApp ${this.sessionId}] Connected successfully as +${cleanPhone} (${this.userInfo.name})`);

          // Link any contacts imported prior to login to this connected phone number
          contactsDb.linkAccount(this.sessionId, cleanPhone);

          this.emit('connected', { user: this.userInfo, sessionId: this.sessionId });
          this.emit('status', { status: 'connected', user: this.userInfo, accountPhone: this.accountPhone, sessionId: this.sessionId });
        }
      });

    } catch (err) {
      console.error(`[Baileys ${this.sessionId}] Init Error:`, err);
      this.status = 'disconnected';
      this.emit('status', { status: this.status, error: err.message, sessionId: this.sessionId });
    }
  }

  async requestPairingCode(phoneNumber) {
    if (!phoneNumber) {
      throw new Error('Phone number is required');
    }

    let cleanDigits = String(phoneNumber).replace(/\D/g, '');
    cleanDigits = cleanDigits.replace(/^0+/, '');

    // Auto-detect 10-digit Indian phone numbers missing '91'
    if (cleanDigits.length === 10 && /^[6-9]/.test(cleanDigits)) {
      cleanDigits = '91' + cleanDigits;
    }

    if (cleanDigits.length < 8) {
      throw new Error('Invalid phone number format. Please include country code (e.g. 919725537047)');
    }

    if (this.status === 'connected') {
      throw new Error('Already connected to WhatsApp. Please disconnect first.');
    }

    if (!this.sock || this.status === 'disconnected') {
      // Ensure clean auth state and initialize socket
      await this.clearAuthFolder();
      await this.init();
      // Allow 2.5s for WebSocket handshake with WhatsApp servers before requesting pairing code
      await new Promise((r) => setTimeout(r, 2500));
    } else {
      // Small pause if socket is already open
      await new Promise((r) => setTimeout(r, 500));
    }

    try {
      const code = await this.sock.requestPairingCode(cleanDigits);
      const formattedCode = code ? code.match(/.{1,4}/g)?.join('-') || code : code;
      this.emit('pairing_code', { code: formattedCode, phone: cleanDigits, sessionId: this.sessionId });
      return { success: true, code: formattedCode, phone: cleanDigits };
    } catch (err) {
      console.error(`[Baileys ${this.sessionId}] Pairing Code Error:`, err);
      throw new Error(`Failed to generate pairing code: ${err.message}`);
    }
  }

  async clearAuthFolder() {
    if (this._isClearingAuth) return;
    this._isClearingAuth = true;
    try {
      if (this.sock) {
        try {
          this.sock.ev.removeAllListeners();
          this.sock.end(new Error('Logout or Reset'));
        } catch (_) {}
        this.sock = null;
      }
      if (fs.existsSync(this.authFolder)) {
        fs.rmSync(this.authFolder, { recursive: true, force: true });
        console.log(`[Baileys Auth ${this.sessionId}] Cleaned session directory.`);
      }
    } catch (e) {
      console.warn(`[Baileys Auth ${this.sessionId}] Folder clean notice:`, e.message);
    } finally {
      this._isClearingAuth = false;
    }
  }

  async logout() {
    this.isExplicitLogout = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);

    try {
      if (this.sock) {
        await this.sock.logout().catch(() => {});
      }
    } finally {
      await this.clearAuthFolder();
      this.status = 'disconnected';
      this.userInfo = null;
      this.accountPhone = null;
      this.qrCodeDataUrl = null;
      this.emit('status', { status: 'disconnected', sessionId: this.sessionId });
    }
  }

  getStatus() {
    return {
      sessionId: this.sessionId,
      status: this.status,
      qrDataUrl: this.qrCodeDataUrl,
      user: this.userInfo,
      accountPhone: this.accountPhone
    };
  }

  async checkNumber(phoneNumber) {
    if (!this.sock || this.status !== 'connected') {
      throw new Error('WhatsApp is not connected on this session');
    }
    const cleanDigits = String(phoneNumber).replace(/\D/g, '');
    try {
      const results = await this.sock.onWhatsApp(`${cleanDigits}@s.whatsapp.net`);
      if (results && results.length > 0 && results[0].exists) {
        return { exists: true, jid: results[0].jid };
      }
      return { exists: false, jid: null };
    } catch (err) {
      console.warn(`checkNumber error for ${cleanDigits}:`, err.message);
      return null;
    }
  }

  async sendTextMessage(jid, text) {
    if (!this.sock || this.status !== 'connected') {
      throw new Error('WhatsApp is not connected');
    }
    const result = await this.sock.sendMessage(jid, { text });
    setTimeout(() => this.cleanupAuthFiles(jid.split('@')[0]), 1500);
    return result;
  }

  async sendVideoMessage(jid, videoPath, caption = '', mimetype = 'video/mp4', originalName = '') {
    if (!this.sock || this.status !== 'connected') {
      throw new Error('WhatsApp is not connected');
    }
    if (!fs.existsSync(videoPath)) {
      throw new Error(`Video file not found at ${videoPath}`);
    }

    const fileName = originalName || path.basename(videoPath);
    try {
      const result = await this.sock.sendMessage(jid, {
        video: { url: videoPath },
        caption: caption || '',
        mimetype: mimetype || 'video/mp4',
        fileName
      });
      setTimeout(() => this.cleanupAuthFiles(jid.split('@')[0]), 1500);
      return result;
    } catch (videoErr) {
      const result = await this.sock.sendMessage(jid, {
        document: { url: videoPath },
        mimetype: mimetype || 'video/mp4',
        fileName,
        caption: caption || ''
      });
      setTimeout(() => this.cleanupAuthFiles(jid.split('@')[0]), 1500);
      return result;
    }
  }

  async sendImageMessage(jid, imagePath, caption = '', mimetype = 'image/jpeg', originalName = '') {
    if (!this.sock || this.status !== 'connected') {
      throw new Error('WhatsApp is not connected');
    }
    if (!fs.existsSync(imagePath)) {
      throw new Error(`Image file not found at ${imagePath}`);
    }

    const result = await this.sock.sendMessage(jid, {
      image: { url: imagePath },
      caption: caption || '',
      mimetype: mimetype || 'image/jpeg'
    });
    setTimeout(() => this.cleanupAuthFiles(jid.split('@')[0]), 1500);
    return result;
  }

  async prepareMediaBundle(mediaFiles = []) {
    if (!this.sock || this.status !== 'connected') {
      throw new Error('WhatsApp is not connected');
    }

    const preparedList = [];
    for (const media of mediaFiles) {
      const isImg = media.type === 'image' || (media.mimetype && media.mimetype.startsWith('image/'));
      try {
        if (isImg) {
          const prepared = await prepareWAMessageMedia(
            { image: { url: media.path } },
            { upload: this.sock.waUploadToServer }
          );
          preparedList.push({
            type: 'image',
            message: prepared.imageMessage,
            originalName: media.originalName,
            mimetype: media.mimetype || 'image/jpeg',
            path: media.path
          });
        } else {
          try {
            const prepared = await prepareWAMessageMedia(
              { video: { url: media.path } },
              { upload: this.sock.waUploadToServer }
            );
            preparedList.push({
              type: 'video',
              message: prepared.videoMessage,
              originalName: media.originalName,
              mimetype: media.mimetype || 'video/mp4',
              path: media.path
            });
          } catch (vidErr) {
            const prepared = await prepareWAMessageMedia(
              {
                document: { url: media.path },
                mimetype: media.mimetype || 'video/mp4',
                fileName: media.originalName
              },
              { upload: this.sock.waUploadToServer }
            );
            preparedList.push({
              type: 'document',
              message: prepared.documentMessage,
              originalName: media.originalName,
              mimetype: media.mimetype || 'video/mp4',
              path: media.path
            });
          }
        }
      } catch (uploadErr) {
        preparedList.push({
          type: isImg ? 'image' : 'video',
          message: null,
          originalName: media.originalName,
          mimetype: media.mimetype,
          path: media.path
        });
      }
    }
    return preparedList;
  }

  async sendPreloadedMediaBundle(jid, preparedMediaList = [], caption = '') {
    if (!this.sock || this.status !== 'connected') {
      throw new Error('WhatsApp is not connected');
    }

    const results = [];
    for (let idx = 0; idx < preparedMediaList.length; idx++) {
      const media = preparedMediaList[idx];
      const isFirst = idx === 0;
      const itemCaption = isFirst ? caption : '';

      if (media.message) {
        try {
          let messageContent;
          if (media.type === 'image') {
            messageContent = { imageMessage: { ...media.message, caption: itemCaption || '' } };
          } else if (media.type === 'video') {
            messageContent = { videoMessage: { ...media.message, caption: itemCaption || '' } };
          } else {
            messageContent = {
              documentMessage: {
                ...media.message,
                caption: itemCaption || '',
                fileName: media.originalName,
                mimetype: media.mimetype || 'video/mp4'
              }
            };
          }

          const generatedMsg = generateWAMessageFromContent(
            jid,
            messageContent,
            { userJid: this.sock.user?.id }
          );

          await this.sock.relayMessage(jid, generatedMsg.message, {
            messageId: generatedMsg.key.id
          });
          results.push(generatedMsg);
        } catch (relayErr) {
          if (media.type === 'image') {
            const res = await this.sendImageMessage(jid, media.path, itemCaption, media.mimetype, media.originalName);
            results.push(res);
          } else {
            const res = await this.sendVideoMessage(jid, media.path, itemCaption, media.mimetype || 'video/mp4', media.originalName);
            results.push(res);
          }
        }
      } else {
        if (media.type === 'image') {
          const res = await this.sendImageMessage(jid, media.path, itemCaption, media.mimetype, media.originalName);
          results.push(res);
        } else {
          const res = await this.sendVideoMessage(jid, media.path, itemCaption, media.mimetype || 'video/mp4', media.originalName);
          results.push(res);
        }
      }

      if (idx < preparedMediaList.length - 1) {
        await new Promise((r) => setTimeout(r, 600));
      }
    }

    setTimeout(() => this.cleanupAuthFiles(jid.split('@')[0]), 1500);
    return results;
  }

  async sendMediaBundle(jid, mediaFiles = [], caption = '') {
    if (!this.sock || this.status !== 'connected') {
      throw new Error('WhatsApp is not connected');
    }

    const results = [];
    for (let idx = 0; idx < mediaFiles.length; idx++) {
      const media = mediaFiles[idx];
      const isFirst = idx === 0;
      const itemCaption = isFirst ? caption : '';

      if (media.type === 'image' || (media.mimetype && media.mimetype.startsWith('image/'))) {
        const res = await this.sendImageMessage(jid, media.path, itemCaption, media.mimetype, media.originalName);
        results.push(res);
      } else {
        const res = await this.sendVideoMessage(jid, media.path, itemCaption, media.mimetype || 'video/mp4', media.originalName);
        results.push(res);
      }

      if (idx < mediaFiles.length - 1) {
        await new Promise((r) => setTimeout(r, 600));
      }
    }

    setTimeout(() => this.cleanupAuthFiles(jid.split('@')[0]), 1500);
    return results;
  }

  async cleanupAuthFiles(recipientDigits = '') {
    if (!fs.existsSync(this.authFolder)) return;
    try {
      const files = await fs.promises.readdir(this.authFolder);
      const now = Date.now();
      const MAX_PREKEY_AGE = 15 * 60 * 1000; // 15 mins
      const MAX_SESSION_AGE = 30 * 60 * 1000; // 30 mins

      for (const file of files) {
        // Critical: Never delete creds.json or app-state-sync-key
        if (file === 'creds.json' || file.startsWith('app-state-sync-key')) continue;

        let shouldDelete = false;
        if (recipientDigits && file.includes(recipientDigits)) {
          shouldDelete = true;
        } else if (file.startsWith('session-') || file.startsWith('sender-key-') || file.startsWith('tctoken-')) {
          try {
            const stats = await fs.promises.stat(path.join(this.authFolder, file));
            if (now - stats.mtimeMs > MAX_SESSION_AGE) {
              shouldDelete = true;
            }
          } catch (_) {}
        } else if (file.startsWith('pre-key-')) {
          try {
            const stats = await fs.promises.stat(path.join(this.authFolder, file));
            if (now - stats.mtimeMs > MAX_PREKEY_AGE) {
              shouldDelete = true;
            }
          } catch (_) {}
        }

        if (shouldDelete) {
          await fs.promises.unlink(path.join(this.authFolder, file)).catch(() => {});
        }
      }
    } catch (_) {}
  }
}

/**
 * Session Manager to handle Multiple Instances & Per-Device Logins
 */
class SessionManager extends EventEmitter {
  constructor() {
    super();
    this.sessions = new Map();
    if (!fs.existsSync(SESSIONS_BASE_DIR)) {
      fs.mkdirSync(SESSIONS_BASE_DIR, { recursive: true });
    }
    this.cleanRootAuthFolder();
    // Recurring root cleanup every 30 minutes
    setInterval(() => this.cleanRootAuthFolder(), 30 * 60 * 1000);
  }

  cleanRootAuthFolder() {
    const rootDir = path.resolve(process.cwd(), 'auth_info_baileys');
    if (!fs.existsSync(rootDir)) return;
    try {
      const entries = fs.readdirSync(rootDir);
      for (const entry of entries) {
        const fullPath = path.join(rootDir, entry);
        if (entry !== 'sessions' && fs.statSync(fullPath).isFile() && entry.endsWith('.json')) {
          try { fs.unlinkSync(fullPath); } catch (_) {}
        }
      }
    } catch (_) {}
  }

  migrateLegacySession() {
    const legacyFolder = path.resolve(process.cwd(), 'auth_info_baileys');
    const legacyCreds = path.join(legacyFolder, 'creds.json');
    const defaultSessionFolder = path.join(SESSIONS_BASE_DIR, 'default');

    if (fs.existsSync(legacyCreds) && !fs.existsSync(defaultSessionFolder)) {
      try {
        fs.mkdirSync(defaultSessionFolder, { recursive: true });
        const files = fs.readdirSync(legacyFolder);
        for (const file of files) {
          const src = path.join(legacyFolder, file);
          if (fs.statSync(src).isFile()) {
            fs.copyFileSync(src, path.join(defaultSessionFolder, file));
          }
        }
        console.log('[SessionManager] Migrated legacy session into session "default".');
      } catch (err) {
        console.warn('[SessionManager] Migration notice:', err.message);
      }
    }
  }

  getSession(deviceId = 'default', autoInit = true) {
    const cleanId = String(deviceId || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');

    if (this.sessions.has(cleanId)) {
      return this.sessions.get(cleanId);
    }

    const session = new WhatsAppSession(cleanId);
    this.sessions.set(cleanId, session);

    // Forward events
    session.on('status', (data) => this.emit('session:status', data));
    session.on('qr', (data) => this.emit('session:qr', data));
    session.on('pairing_code', (data) => this.emit('session:pairing_code', data));
    session.on('connected', (data) => this.emit('session:connected', data));

    // Only auto-init if this device already had saved credentials
    if (autoInit && session.hasSavedCredentials()) {
      console.log(`[SessionManager] Restoring saved session for device "${cleanId}"...`);
      session.init();
    } else {
      console.log(`[SessionManager] New device "${cleanId}" registered. Waiting for user login.`);
    }

    return session;
  }

  async logoutSession(deviceId) {
    const session = this.sessions.get(deviceId);
    if (session) {
      await session.logout();
      this.sessions.delete(deviceId);
    }
  }
}

export const sessionManager = new SessionManager();
// Backwards compatibility default instance
export const whatsappService = sessionManager.getSession('default', true);
