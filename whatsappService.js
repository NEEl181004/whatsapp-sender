import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  prepareWAMessageMedia,
  generateWAMessageFromContent,
  Browsers,
  DisconnectReason,
  makeCacheableSignalKeyStore
} from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import { contactsDb } from './contactsDb.js';
import { blacklistDb } from './blacklistDb.js';

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
      this.emit('status', { status: this.status, hasSavedCredentials: this.hasSavedCredentials(), sessionId: this.sessionId });

      // Cleanly terminate previous socket instance before opening a new one to prevent 440 conflict / replaced
      if (this.sock) {
        try {
          this.sock.ev.removeAllListeners();
          this.sock.end(undefined);
        } catch (_) {}
        this.sock = null;
      }

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

      const logger = pino({ level: 'silent' });
      const { state, saveCreds } = await useMultiFileAuthState(this.authFolder);
      const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: [2, 3000, 1043857760] }));

      const makeSocket = makeWASocket.default || makeWASocket;

      this.sock = makeSocket({
        version,
        logger,
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, logger)
        },
        printQRInTerminal: false,
        browser: Browsers.ubuntu('Chrome'),
        syncFullHistory: false,
        shouldSyncHistoryMessage: () => false,
        generateHighQualityLinkPreview: false,
        markOnlineOnConnect: true,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 25000,
        retryRequestDelayMs: 250,
        maxMsgRetryCount: 5,
        getMessage: async () => ({ conversation: '' })
      });

      this.sock.ev.on('creds.update', saveCreds);

      // === Automatic STOP / Opt-Out & Anti-Spam Complaint Protection ===
      this.sock.ev.on('messages.upsert', async ({ messages }) => {
        if (!messages || !Array.isArray(messages)) return;
        for (const msg of messages) {
          if (msg.key?.fromMe || !msg.message || msg.key?.remoteJid === 'status@broadcast') continue;

          // Extract text from conversation, extended text, or media captions
          const text = (
            msg.message.conversation ||
            msg.message.extendedTextMessage?.text ||
            msg.message.imageMessage?.caption ||
            msg.message.videoMessage?.caption ||
            ''
          ).trim();

          if (!text) continue;

          const senderJid = msg.key.remoteJid;
          const cleanDigits = senderJid ? senderJid.split('@')[0].replace(/\D/g, '') : '';
          if (!cleanDigits) continue;

          const lower = text.toLowerCase().trim();
          const isStopRequest = /^(stop|unsubscribe|remove|cancel|0|end|quit|stop message|don't message|dont message|band karo|hatao)$/i.test(lower) ||
                                lower.includes('stop sending') ||
                                lower.includes('unsubscribe me') ||
                                lower.includes('remove me') ||
                                lower.includes('do not message');

          if (isStopRequest) {
            console.log(`[WhatsApp ${this.sessionId}] Opt-out request received from +${cleanDigits}: "${text}"`);
            blacklistDb.add(cleanDigits, `Replied "${text}"`, msg.pushName || '');
            contactsDb.updateStatus(cleanDigits, 'Unsubscribed', 'Replied STOP', this.accountPhone || this.sessionId);

            // Send polite automated confirmation so user doesn't hit WhatsApp's Report as Spam button
            try {
              await this.sock.sendMessage(senderJid, {
                text: `✔ You have been unsubscribed and will not receive further promotional messages. Thank you.`
              });
            } catch (_) {}

            this.emit('contact:unsubscribed', { digits: cleanDigits, text, pushName: msg.pushName });
          }
        }
      });

      this.sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          try {
            this.status = 'qr_ready';
            this.qrCodeDataUrl = await QRCode.toDataURL(qr, { margin: 2, scale: 7 });
            this.emit('qr', { qrDataUrl: this.qrCodeDataUrl, sessionId: this.sessionId });
            this.emit('status', { status: this.status, qrDataUrl: this.qrCodeDataUrl, hasSavedCredentials: false, sessionId: this.sessionId });
          } catch (qrErr) {
            console.error(`[Baileys ${this.sessionId}] QR Generation Error:`, qrErr);
          }
        }

        if (connection === 'close') {
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          const isRestartRequired = statusCode === DisconnectReason.restartRequired || statusCode === 515;
          const isLoggedOut = statusCode === DisconnectReason.loggedOut;
          const shouldReconnect = !this.isExplicitLogout && !isLoggedOut;

          console.log(`[WhatsApp ${this.sessionId}] Connection closed (${statusCode}). Should reconnect: ${shouldReconnect}`);

          if (this.isExplicitLogout) {
            this.status = 'disconnected';
            this.userInfo = null;
            this.accountPhone = null;
            this.qrCodeDataUrl = null;
            this.emit('status', { status: this.status, hasSavedCredentials: false, sessionId: this.sessionId });
            await this.clearAuthFolder();
          } else if (isLoggedOut) {
            this.status = 'disconnected';
            this.userInfo = null;
            this.accountPhone = null;
            this.qrCodeDataUrl = null;
            // Keep auth files on disk; user can reconnect or explicitly log out
            this.emit('status', { status: this.status, hasSavedCredentials: this.hasSavedCredentials(), sessionId: this.sessionId });
          } else if (shouldReconnect) {
            this.status = 'connecting';
            this.emit('status', { status: this.status, hasSavedCredentials: this.hasSavedCredentials(), sessionId: this.sessionId });
            if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
            // Reconnect immediately on 515 (restartRequired) so mobile linking progress bar does not timeout
            const reconnectDelay = isRestartRequired ? 300 : 2000;
            this.reconnectTimer = setTimeout(() => this.init(), reconnectDelay);
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
      hasSavedCredentials: this.hasSavedCredentials(),
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

  /**
   * Human Mimic Typing Simulator
   * Emulates real human typing patterns based on message length:
   * - Sets online presence ('available')
   * - Initial reading / thinking hesitation (400ms - 800ms)
   * - Typing speed at 25ms - 40ms per character
   * - For longer messages, introduces natural micro-stutters (pauses to think)
   * - Concludes with a brief pause before send button tap
   */
  async simulateHumanTyping(jid, messageOrLength = 60) {
    if (!this.sock || this.status !== 'connected' || !jid) return;
    const len = typeof messageOrLength === 'number' ? messageOrLength : String(messageOrLength || '').length;
    const safeLen = Math.max(15, Math.min(len || 50, 400));

    // Realistic human typing duration: 25-40ms per character + thinking hesitation
    const charDelay = Math.floor(Math.random() * 15 + 25);
    const baseHesitation = Math.floor(Math.random() * 400 + 400);
    const totalTypingMs = Math.max(1800, Math.min(baseHesitation + (safeLen * charDelay), 6000));

    try {
      // 1. User appears online
      await this.sock.sendPresenceUpdate('available').catch(() => {});
      if (baseHesitation > 450) {
        await new Promise((r) => setTimeout(r, baseHesitation));
      }

      if (totalTypingMs > 3000) {
        // Longer message: simulate human stutter (types, pauses briefly to think, resumes typing)
        const firstChunk = Math.floor(totalTypingMs * 0.55);
        const pauseTime = Math.floor(Math.random() * 350 + 350); // 350-700ms pause
        const secondChunk = totalTypingMs - firstChunk;

        await this.sock.sendPresenceUpdate('composing', jid).catch(() => {});
        await new Promise((r) => setTimeout(r, firstChunk));

        await this.sock.sendPresenceUpdate('paused', jid).catch(() => {});
        await new Promise((r) => setTimeout(r, pauseTime));

        await this.sock.sendPresenceUpdate('composing', jid).catch(() => {});
        await new Promise((r) => setTimeout(r, secondChunk));
      } else {
        // Shorter message: continuous typing
        await this.sock.sendPresenceUpdate('composing', jid).catch(() => {});
        await new Promise((r) => setTimeout(r, totalTypingMs));
      }

      // Finish typing before pressing send
      await this.sock.sendPresenceUpdate('paused', jid).catch(() => {});
    } catch (_) {}
  }

  // Backwards compatibility alias
  async simulateTyping(jid, durationMs = 2000) {
    return await this.simulateHumanTyping(jid, Math.floor(durationMs / 30));
  }

  async sendTextMessage(jid, text) {
    if (!this.sock || this.status !== 'connected') {
      throw new Error('WhatsApp is not connected');
    }
    return await this.sock.sendMessage(jid, { text });
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
      return await this.sock.sendMessage(jid, {
        video: { url: videoPath },
        caption: caption || '',
        mimetype: mimetype || 'video/mp4',
        fileName
      });
    } catch (videoErr) {
      return await this.sock.sendMessage(jid, {
        document: { url: videoPath },
        mimetype: mimetype || 'video/mp4',
        fileName,
        caption: caption || ''
      });
    }
  }

  async sendImageMessage(jid, imagePath, caption = '', mimetype = 'image/jpeg', originalName = '') {
    if (!this.sock || this.status !== 'connected') {
      throw new Error('WhatsApp is not connected');
    }
    if (!fs.existsSync(imagePath)) {
      throw new Error(`Image file not found at ${imagePath}`);
    }

    return await this.sock.sendMessage(jid, {
      image: { url: imagePath },
      caption: caption || '',
      mimetype: mimetype || 'image/jpeg'
    });
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

    return results;
  }

  async cleanupAuthFiles() {
    // Non-destructive: preserving active Signal session and pre-key files
    // to maintain the ratchet cipher state. Deleting these causes disconnects after 15-20 messages.
    return;
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
    session.on('contact:unsubscribed', (data) => this.emit('session:contact_unsubscribed', { ...data, sessionId: cleanId }));

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
