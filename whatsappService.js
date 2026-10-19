import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
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

const AUTH_FOLDER = path.resolve(process.cwd(), 'auth_info_baileys');

class WhatsAppService extends EventEmitter {
  constructor() {
    super();
    this.sock = null;
    this.status = 'disconnected'; // 'disconnected' | 'connecting' | 'qr_ready' | 'connected'
    this.qrCodeDataUrl = null;
    this.userInfo = null;
    this.isExplicitLogout = false;
    this.reconnectTimer = null;
    this._isClearingAuth = false;
  }

  async init() {
    try {
      this.status = 'connecting';
      this.emit('status', { status: this.status });

      if (!fs.existsSync(AUTH_FOLDER)) {
        fs.mkdirSync(AUTH_FOLDER, { recursive: true });
      }

      // Check for malformed creds.json
      const credsPath = path.join(AUTH_FOLDER, 'creds.json');
      if (fs.existsSync(credsPath)) {
        try {
          JSON.parse(fs.readFileSync(credsPath, 'utf8'));
        } catch (parseErr) {
          console.warn('[Baileys Auth] Malformed creds.json, purging...', parseErr.message);
          await this.clearAuthFolder();
          if (!fs.existsSync(AUTH_FOLDER)) {
            fs.mkdirSync(AUTH_FOLDER, { recursive: true });
          }
        }
      }

      const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
      const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: [2, 3000, 1015901307] }));

      const makeSocket = makeWASocket.default || makeWASocket;

      this.sock = makeSocket({
        version,
        logger: pino({ level: 'silent' }),
        auth: state,
        printQRInTerminal: false,
        browser: Browsers.windows('Desktop'),
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
            this.emit('qr', { qrDataUrl: this.qrCodeDataUrl });
            this.emit('status', { status: this.status });
          } catch (err) {
            console.error('Failed to generate QR DataURL:', err);
          }
        }

        if (connection === 'close') {
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          const isLoggedOut = statusCode === DisconnectReason.loggedOut;
          const isRestartRequired = statusCode === DisconnectReason.restartRequired;
          const shouldReconnect = !isLoggedOut && !this.isExplicitLogout;

          this.status = 'disconnected';
          this.qrCodeDataUrl = null;
          this.userInfo = null;
          this.emit('status', { status: this.status, reason: statusCode });

          if (shouldReconnect) {
            const reconnectDelay = isRestartRequired ? 300 : 2000;
            console.log(`WhatsApp connection closed (${statusCode || 'unknown'}). Reconnecting in ${reconnectDelay}ms...`);
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = setTimeout(() => {
              this.init();
            }, reconnectDelay);
          } else {
            console.log('WhatsApp logged out or reset. Cleaning session...');
            contactsDb.switchAccount(null);
            clearTimeout(this.reconnectTimer);
            await this.clearAuthFolder();

            // If logged out externally (e.g. from WhatsApp mobile app), restart automatically to generate a fresh QR
            if (!this.isExplicitLogout) {
              console.log('Restarting WhatsApp service in 2 seconds to generate a fresh QR code...');
              this.reconnectTimer = setTimeout(() => {
                this.init();
              }, 2000);
            }
          }
        } else if (connection === 'open') {
          this.status = 'connected';
          this.qrCodeDataUrl = null;
          this.isExplicitLogout = false;

          const rawId = this.sock.user?.id || '';
          const phone = rawId.split(':')[0] || rawId.split('@')[0];
          const name = this.sock.user?.name || 'WhatsApp Account';

          this.userInfo = {
            id: rawId,
            phone,
            name
          };

          console.log(`WhatsApp connected successfully as +${phone} (${name})`);
          contactsDb.switchAccount(phone);
          this.emit('connected', this.userInfo);
          this.emit('status', { status: this.status, user: this.userInfo });
        }
      });
    } catch (err) {
      console.error('Error during WhatsApp initialization:', err);
      this.status = 'disconnected';
      this.emit('status', { status: this.status, error: err.message });
    }
  }

  async clearAuthFolder() {
    if (this._isClearingAuth) return;
    this._isClearingAuth = true;

    try {
      if (!fs.existsSync(AUTH_FOLDER)) {
        return;
      }

      // Small delay on Windows to let active file descriptors release
      await new Promise((resolve) => setTimeout(resolve, 800));

      let attempts = 0;
      const maxAttempts = 5;

      while (attempts < maxAttempts) {
        try {
          if (!fs.existsSync(AUTH_FOLDER)) break;

          // Attempt to remove files inside the folder first
          const entries = await fs.promises.readdir(AUTH_FOLDER);
          for (const entry of entries) {
            const entryPath = path.join(AUTH_FOLDER, entry);
            try {
              const stat = await fs.promises.stat(entryPath);
              if (stat.isDirectory()) {
                await fs.promises.rm(entryPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
              } else {
                await fs.promises.unlink(entryPath);
              }
            } catch (_) {
              // Individual file might be temporarily locked by Windows OS
            }
          }

          // Try removing the auth folder itself
          await fs.promises.rm(AUTH_FOLDER, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
          break; // successfully cleaned!
        } catch (err) {
          attempts++;
          if (attempts >= maxAttempts) {
            console.warn(`[Baileys Auth] Session cleared (folder contents removed). Directory lock will release on restart.`);
          } else {
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
        }
      }
    } catch (err) {
      console.warn('Warning clearing auth folder:', err.message);
    } finally {
      this._isClearingAuth = false;
    }
  }

  /**
   * Cleans unnecessary JSON files from auth_info_baileys.
   * Keeps only essential session credentials (creds.json, primary sync keys).
   * Deletes one-off recipient session files, temporary sync patches, and expired pre-keys.
   */
  async cleanupAuthFiles(contactDigits = null) {
    try {
      if (!fs.existsSync(AUTH_FOLDER)) return;

      const files = await fs.promises.readdir(AUTH_FOLDER);

      // Check firstUnuploadedPreKeyId to know which pre-keys have been consumed
      let minPreKeyId = 0;
      try {
        const credsPath = path.join(AUTH_FOLDER, 'creds.json');
        if (fs.existsSync(credsPath)) {
          const creds = JSON.parse(await fs.promises.readFile(credsPath, 'utf8'));
          minPreKeyId = creds.firstUnuploadedPreKeyId || 0;
        }
      } catch (_) {}

      for (const file of files) {
        // ALWAYS PRESERVE:
        if (file === 'creds.json') continue;
        if (file.startsWith('app-state-sync-key-')) continue;
        if (file.startsWith('signed-pre-key-')) continue;

        let shouldDelete = false;

        // 1. Delete app state sync history/patch versions
        if (file.startsWith('app-state-sync-version-')) {
          shouldDelete = true;
        }

        // 2. Delete consumed pre-keys older than current index
        if (file.startsWith('pre-key-')) {
          const match = file.match(/^pre-key-(\d+)\.json$/);
          if (match) {
            const keyId = parseInt(match[1], 10);
            if (minPreKeyId > 0 && keyId < minPreKeyId - 3) {
              shouldDelete = true;
            }
          }
        }

        // 3. Delete recipient-specific session/device/identity/lid files after sending
        if (contactDigits) {
          const digitsClean = String(contactDigits).replace(/\D/g, '');
          if (digitsClean && (
            file.includes(digitsClean) ||
            (file.startsWith('session-') && file.includes(digitsClean)) ||
            (file.startsWith('device-list-') && file.includes(digitsClean))
          )) {
            shouldDelete = true;
          }
        }

        // 4. Delete orphaned lid-mapping or sender-key-memory files
        if (file.startsWith('sender-key-memory-') || file.startsWith('lid-mapping-')) {
          shouldDelete = true;
        }

        if (shouldDelete) {
          try {
            await fs.promises.unlink(path.join(AUTH_FOLDER, file));
          } catch (_) {
            // momentarily locked by OS
          }
        }
      }
    } catch (err) {
      // non-fatal cleanup warning
    }
  }

  async logout() {
    this.isExplicitLogout = true;
    clearTimeout(this.reconnectTimer);
    try {
      if (this.sock) {
        try {
          await this.sock.logout();
        } catch (_) {}
        try {
          this.sock.end(undefined);
        } catch (_) {}
      }
    } catch (err) {
      console.warn('Logout warning:', err.message);
    }

    contactsDb.switchAccount(null);
    this.sock = null;
    this.status = 'disconnected';
    this.qrCodeDataUrl = null;
    this.userInfo = null;
    this.emit('status', { status: 'disconnected' });

    await this.clearAuthFolder();

    // Restart to generate a fresh QR
    this.isExplicitLogout = false;
    await this.init();
  }

  getStatus() {
    return {
      status: this.status,
      qrDataUrl: this.qrCodeDataUrl,
      user: this.userInfo,
      accountPhone: contactsDb.getActiveAccount()
    };
  }

  /**
   * Request 8-digit pairing code to connect WhatsApp with a phone number (without camera/QR)
   */
  async requestPairingCode(phoneNumber) {
    if (!this.sock) {
      throw new Error('WhatsApp service is still starting up. Please wait 2 seconds and try again.');
    }
    const cleanDigits = String(phoneNumber).replace(/\D/g, '');
    if (!cleanDigits || cleanDigits.length < 8) {
      throw new Error('Please enter a valid phone number with country code (e.g. 919876543210)');
    }

    try {
      console.log(`[Baileys Auth] Requesting pairing code for +${cleanDigits}...`);
      const rawCode = await this.sock.requestPairingCode(cleanDigits);
      // Format code as ABCD-1234
      const formattedCode = rawCode?.match(/.{1,4}/g)?.join('-') || rawCode;
      console.log(`[Baileys Auth] Generated pairing code: ${formattedCode}`);
      this.emit('pairing_code', { code: formattedCode, phone: cleanDigits });
      return { success: true, code: formattedCode, phone: cleanDigits };
    } catch (err) {
      console.error('[Baileys Auth] Failed to generate pairing code:', err);
      throw new Error('Failed to generate pairing code: ' + err.message);
    }
  }

  /**
   * Verify whether a number is on WhatsApp
   */
  async checkNumber(phoneDigits) {
    if (!this.sock || this.status !== 'connected') {
      throw new Error('WhatsApp is not connected');
    }
    const jid = `${phoneDigits}@s.whatsapp.net`;
    try {
      const results = await this.sock.onWhatsApp(jid);
      if (results && results.length > 0 && results[0].exists) {
        return { exists: true, jid: results[0].jid };
      }
      return { exists: false, jid };
    } catch (err) {
      // Fallback: assume exists if check throws network error
      return { exists: true, jid };
    }
  }

  /**
   * Send text message
   */
  async sendTextMessage(jid, text) {
    if (!this.sock || this.status !== 'connected') {
      throw new Error('WhatsApp is not connected');
    }
    const result = await this.sock.sendMessage(jid, { text });
    setTimeout(() => this.cleanupAuthFiles(jid.split('@')[0]), 1500);
    return result;
  }

  /**
   * Send video message with caption.
   * Supports HD videos and large files up to 2GB with streaming and document fallback.
   */
  async sendVideoMessage(jid, videoPath, caption = '', mimetype = 'video/mp4', originalName = '') {
    if (!this.sock || this.status !== 'connected') {
      throw new Error('WhatsApp is not connected');
    }
    if (!fs.existsSync(videoPath)) {
      throw new Error(`Video file not found at ${videoPath}`);
    }

    const fileName = originalName || path.basename(videoPath);
    console.log(`Sending video to ${jid}: "${fileName}" with caption "${caption.slice(0, 40)}..."`);

    // Try sending as native video message first (using URL stream to avoid large memory allocations)
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
      console.warn(`Native video send error (${videoErr.message}), falling back to document video...`);
      // If video exceeds WhatsApp inline media streaming threshold, send as high-quality video document (supports up to 2GB)
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

  /**
   * Send image message with caption
   */
  async sendImageMessage(jid, imagePath, caption = '', mimetype = 'image/jpeg', originalName = '') {
    if (!this.sock || this.status !== 'connected') {
      throw new Error('WhatsApp is not connected');
    }
    if (!fs.existsSync(imagePath)) {
      throw new Error(`Image file not found at ${imagePath}`);
    }

    const fileName = originalName || path.basename(imagePath);
    console.log(`Sending image to ${jid}: "${fileName}"`);

    const result = await this.sock.sendMessage(jid, {
      image: { url: imagePath },
      caption: caption || '',
      mimetype: mimetype || 'image/jpeg'
    });
    setTimeout(() => this.cleanupAuthFiles(jid.split('@')[0]), 1500);
    return result;
  }

  /**
   * Pre-uploads media files to WhatsApp server ONCE.
   * This prevents re-uploading large files to each of the 10,000 customers!
   */
  async prepareMediaBundle(mediaFiles = []) {
    if (!this.sock || this.status !== 'connected') {
      throw new Error('WhatsApp is not connected');
    }

    const preparedList = [];
    for (const media of mediaFiles) {
      if (!fs.existsSync(media.path)) {
        console.warn(`File not found: ${media.path}`);
        continue;
      }

      const isImg = media.type === 'image' || (media.mimetype && media.mimetype.startsWith('image/'));
      console.log(`[Media Pre-upload] Pre-uploading ${isImg ? 'image' : 'video'} "${media.originalName}" to WhatsApp server ONCE...`);

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
          // Check file size: WhatsApp native video stream limit is ~64 MB.
          // For files > 60MB, WhatsApp requires document upload to avoid upload failure.
          const stats = fs.statSync(media.path);
          const fileSizeMB = stats.size / (1024 * 1024);

          if (fileSizeMB > 60) {
            console.log(`[Media Pre-upload] Video is ${fileSizeMB.toFixed(1)} MB (> 60MB). Pre-uploading as high-capacity document video once...`);
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
              console.warn(`[Media Pre-upload] Video native upload failed (${vidErr.message}), retrying as document video...`);
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
        }
      } catch (uploadErr) {
        console.warn(`[Media Pre-upload] Pre-upload warning for ${media.originalName} (${uploadErr.message}). Using direct streaming fallback.`);
        preparedList.push({
          type: isImg ? 'image' : 'video',
          message: null,
          originalName: media.originalName,
          mimetype: media.mimetype,
          path: media.path
        });
      }
    }

    console.log(`[Media Pre-upload] Successfully prepared ${preparedList.length} media file(s).`);
    return preparedList;
  }

  /**
   * Transmits pre-uploaded media bundle to a recipient in ~50ms without re-uploading file!
   */
  async sendPreloadedMediaBundle(jid, preparedMediaList = [], caption = '') {
    if (!this.sock || this.status !== 'connected') {
      throw new Error('WhatsApp is not connected');
    }

    const results = [];
    for (let idx = 0; idx < preparedMediaList.length; idx++) {
      const media = preparedMediaList[idx];
      const isFirst = idx === 0;
      const itemCaption = isFirst ? caption : '';

      // If pre-upload succeeded, relay message using preloaded media token (0 bytes uploaded, takes 50ms!)
      if (media.message) {
        try {
          let messageContent;
          if (media.type === 'image') {
            messageContent = {
              imageMessage: {
                ...media.message,
                caption: itemCaption || ''
              }
            };
          } else if (media.type === 'video') {
            messageContent = {
              videoMessage: {
                ...media.message,
                caption: itemCaption || ''
              }
            };
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
          console.warn(`Relay failed (${relayErr.message}), falling back to direct send...`);
          if (media.type === 'image') {
            const res = await this.sendImageMessage(jid, media.path, itemCaption, media.mimetype, media.originalName);
            results.push(res);
          } else if (media.type === 'document') {
            const res = await this.sock.sendMessage(jid, {
              document: { url: media.path },
              mimetype: media.mimetype || 'video/mp4',
              fileName: media.originalName,
              caption: itemCaption || ''
            });
            results.push(res);
          } else {
            const res = await this.sendVideoMessage(jid, media.path, itemCaption, media.mimetype, media.originalName);
            results.push(res);
          }
        }
      } else {
        // Fallback to streaming directly from disk
        if (media.type === 'image') {
          const res = await this.sendImageMessage(jid, media.path, itemCaption, media.mimetype, media.originalName);
          results.push(res);
        } else {
          const res = await this.sendVideoMessage(jid, media.path, itemCaption, media.mimetype, media.originalName);
          results.push(res);
        }
      }

      if (idx < preparedMediaList.length - 1) {
        await new Promise((r) => setTimeout(r, 400));
      }
    }

    setTimeout(() => this.cleanupAuthFiles(jid.split('@')[0]), 1500);
    return results;
  }

  /**
   * Send a bundle of multiple images and/or videos to a recipient (direct method).
   * The first media item carries the caption.
   */
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

  /**
   * Check if a phone number is registered on WhatsApp using Baileys onWhatsApp.
   * Returns { exists: boolean, jid: string|null } or null on check error.
   */
  async checkNumber(phoneNumber) {
    if (!this.sock || this.status !== 'connected') {
      throw new Error('WhatsApp is not connected');
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
}

export const whatsappService = new WhatsAppService();
