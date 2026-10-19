import express from 'express';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import cors from 'cors';
import os from 'os';
import dgram from 'dgram';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';

import { sessionManager, whatsappService } from './whatsappService.js';
import { getCampaignManager, campaignManager } from './campaignManager.js';
import { contactsDb } from './contactsDb.js';
import {
  parseCsvContacts,
  parseVcfContacts,
  parseExcelContacts,
  parseRawTextContacts,
  formatPhoneNumber
} from './contactParser.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: { origin: '*' }
});

const PORT = process.env.PORT || 3000;

// Setup directories
const UPLOADS_DIR = path.resolve(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Multer storage for uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${file.fieldname}-${uniqueSuffix}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 } // 2 GB max for video and media
});

// Middleware
app.use(cors());
app.use(express.json({ limit: '200mb' }));
app.use(express.urlencoded({ extended: true, limit: '200mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));

// Helper: Get device context for session isolation & multi-account handling
function getDeviceContext(req) {
  const rawId = req.headers['x-device-id'] || req.query.deviceId || req.body?.deviceId || 'default';
  const cleanId = String(rawId).replace(/[^a-zA-Z0-9_-]/g, '_') || 'default';
  const session = sessionManager.getSession(cleanId);
  const campaign = getCampaignManager(cleanId, session);
  const accountKey = session.accountPhone || cleanId;
  return { deviceId: cleanId, session, campaign, accountKey };
}

// Helper: Get local Wi-Fi / LAN IP address for phone/mobile connection
export function getLocalIpAddress() {
  const interfaces = os.networkInterfaces();
  const wifiIps = [];
  const physicalIps = [];
  const otherIps = [];

  for (const name of Object.keys(interfaces)) {
    const lowerName = name.toLowerCase();
    const isVirtual = lowerName.includes('vethernet') || 
                      lowerName.includes('virtual') || 
                      lowerName.includes('wsl') || 
                      lowerName.includes('loopback') || 
                      lowerName.includes('docker') ||
                      lowerName.includes('ethernet 3');

    const isWifi = lowerName.includes('wi-fi') || lowerName.includes('wireless') || lowerName.includes('wlan');

    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        if (iface.address.startsWith('192.168.') || iface.address.startsWith('10.') || iface.address.startsWith('172.')) {
          if (isWifi) {
            wifiIps.push(iface.address);
          } else if (!isVirtual) {
            physicalIps.push(iface.address);
          } else {
            otherIps.push(iface.address);
          }
        }
      }
    }
  }

  if (wifiIps.length > 0) return wifiIps[0];
  if (physicalIps.length > 0) return physicalIps[0];
  if (otherIps.length > 0) return otherIps[0];
  return 'localhost';
}

// === Network Info Endpoint (Mobile Access URL) ===
app.get('/api/network-info', (req, res) => {
  const ip = getLocalIpAddress();
  res.json({
    port: PORT,
    localUrl: `http://localhost:${PORT}`,
    mobileUrl: `http://${ip}:${PORT}`,
    ip,
    apkDownloadUrl: `http://${ip}:${PORT}/WhatsApp-Sender.apk`
  });
});

// === APK Direct Download Endpoint ===
app.get('/api/download-apk', (req, res) => {
  const apkPath = path.join(__dirname, 'public', 'WhatsApp-Sender.apk');
  if (fs.existsSync(apkPath)) {
    res.download(apkPath, 'WhatsApp-Sender.apk');
  } else {
    res.status(404).json({ error: 'APK file not found' });
  }
});

// === UDP Auto-Discovery Service for Android APK ===
try {
  const udpServer = dgram.createSocket('udp4');
  udpServer.on('error', () => {});
  udpServer.on('message', (msg, rinfo) => {
    const text = msg.toString();
    if (text.includes('DISCOVER_WHATSAPP_SENDER')) {
      const ip = getLocalIpAddress();
      const response = Buffer.from(`WHATSAPP_SENDER_OFFER:${ip}:${PORT}`);
      udpServer.send(response, rinfo.port, rinfo.address, () => {});
    }
  });
  udpServer.bind(3001, '0.0.0.0', () => {
    console.log('[Auto-Discovery] UDP Beacon active on port 3001');
  });
} catch (e) {
  // Ignored
}

// === WhatsApp Status & Actions (Per Device) ===
app.get('/api/whatsapp/status', (req, res) => {
  const { session } = getDeviceContext(req);
  res.json(session.getStatus());
});

app.post('/api/whatsapp/pairing-code', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) {
      return res.status(400).json({ success: false, error: 'Phone number is required' });
    }
    const { session } = getDeviceContext(req);
    const result = await session.requestPairingCode(phone);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/whatsapp/logout', async (req, res) => {
  try {
    const { deviceId } = getDeviceContext(req);
    await sessionManager.logoutSession(deviceId);
    res.json({ success: true, message: 'Logged out successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/whatsapp/restart', async (req, res) => {
  try {
    const { session } = getDeviceContext(req);
    await session.logout();
    await session.init();
    res.json({ success: true, message: 'Session reset. Generating fresh QR code...' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/whatsapp/cleanup-auth', async (req, res) => {
  try {
    const { session } = getDeviceContext(req);
    await session.cleanupAuthFiles();
    res.json({ success: true, message: 'Unnecessary auth files cleaned successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// === Contact Parsing Endpoints (Per Device / Account) ===
app.post('/api/upload-contacts', (req, res) => {
  upload.single('contactsFile')(req, res, (err) => {
    if (err) {
      console.error('Contact upload error:', err);
      return res.status(400).json({ success: false, error: err.message });
    }
    try {
      if (!req.file) {
        return res.status(400).json({ success: false, error: 'No contact file uploaded' });
      }

      const defaultCountryCode = req.body.defaultCountryCode || '91';
      const filePath = req.file.path;
      const ext = path.extname(req.file.originalname).toLowerCase();
      let contacts = [];

      const fileBuffer = fs.readFileSync(filePath);

      if (ext === '.vcf') {
        contacts = parseVcfContacts(fileBuffer, defaultCountryCode);
      } else if (ext === '.xlsx' || ext === '.xls') {
        contacts = parseExcelContacts(fileBuffer, defaultCountryCode);
      } else {
        contacts = parseCsvContacts(fileBuffer, defaultCountryCode);
      }

      fs.unlink(filePath, () => {});

      const { accountKey, deviceId } = getDeviceContext(req);
      const dbResult = contactsDb.upsertContacts(contacts, accountKey);
      io.to(`device_${deviceId}`).emit('contacts:updated');

      res.json({
        success: true,
        filename: req.file.originalname,
        count: contacts.length,
        contacts,
        dbTotal: dbResult.total,
        account: accountKey
      });
    } catch (parseErr) {
      console.error('Contact parse error:', parseErr);
      res.status(500).json({ success: false, error: 'Failed to parse contacts: ' + parseErr.message });
    }
  });
});

app.post('/api/parse-text', (req, res) => {
  try {
    const { text, defaultCountryCode = '91' } = req.body;
    if (!text) {
      return res.json({ success: true, contacts: [], count: 0 });
    }
    const contacts = parseRawTextContacts(text, defaultCountryCode);
    const { accountKey, deviceId } = getDeviceContext(req);
    const dbResult = contactsDb.upsertContacts(contacts, accountKey);
    io.to(`device_${deviceId}`).emit('contacts:updated');

    res.json({
      success: true,
      count: contacts.length,
      contacts,
      dbTotal: dbResult.total,
      account: accountKey
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/contacts', (req, res) => {
  try {
    const search = req.query.search || '';
    const { accountKey } = getDeviceContext(req);
    const contacts = contactsDb.getAll(search, accountKey);
    res.json({
      success: true,
      count: contacts.length,
      account: accountKey,
      contacts
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/contacts/save', (req, res) => {
  try {
    const { contacts } = req.body;
    if (!Array.isArray(contacts)) {
      return res.status(400).json({ error: 'Contacts array required' });
    }
    const { accountKey, deviceId } = getDeviceContext(req);
    const result = contactsDb.upsertContacts(contacts, accountKey);
    io.to(`device_${deviceId}`).emit('contacts:updated');
    res.json({
      success: true,
      ...result
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Direct Import of Android Phone Contacts
app.post('/api/contacts/import-device', (req, res) => {
  try {
    const { contacts, defaultCountryCode } = req.body;
    if (!Array.isArray(contacts) || contacts.length === 0) {
      return res.status(400).json({ success: false, error: 'No contacts provided' });
    }

    const parsedContacts = [];
    for (const c of contacts) {
      const rawPhone = String(c.phone || c.tel || '').trim();
      if (!rawPhone) continue;
      const formatted = formatPhoneNumber(rawPhone, defaultCountryCode || '+91');
      if (formatted) {
        parsedContacts.push({
          id: `c_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          name: c.name || formatted.formatted,
          firstName: c.name ? c.name.split(' ')[0] : 'Friend',
          phone: formatted.formatted,
          rawPhone,
          digits: formatted.digits,
          jid: formatted.jid
        });
      }
    }

    const { accountKey, deviceId } = getDeviceContext(req);
    const result = contactsDb.upsertContacts(parsedContacts, accountKey);
    io.to(`device_${deviceId}`).emit('contacts:updated');
    res.json({
      success: true,
      count: parsedContacts.length,
      ...result,
      contacts: parsedContacts
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.put('/api/contacts/:id', (req, res) => {
  try {
    const { name, phone } = req.body;
    if (!name && !phone) {
      return res.status(400).json({ error: 'Name or phone is required to update' });
    }
    const { accountKey, deviceId } = getDeviceContext(req);
    const updated = contactsDb.updateContact(req.params.id, { name, phone }, accountKey);
    if (!updated) {
      return res.status(404).json({ success: false, error: 'Contact not found' });
    }
    io.to(`device_${deviceId}`).emit('contacts:updated');
    res.json({ success: true, contact: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/contacts/:id', (req, res) => {
  try {
    const { accountKey, deviceId } = getDeviceContext(req);
    const ok = contactsDb.deleteById(req.params.id, accountKey);
    io.to(`device_${deviceId}`).emit('contacts:updated');
    res.json({ success: ok });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/contacts', (req, res) => {
  try {
    const { accountKey, deviceId } = getDeviceContext(req);
    contactsDb.clear(accountKey);
    io.to(`device_${deviceId}`).emit('contacts:updated');
    res.json({ success: true, message: 'Contacts database cleared' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// === Multi-Media Upload Endpoint ===
app.post('/api/upload-media', (req, res) => {
  upload.array('mediaFiles', 50)(req, res, (err) => {
    if (err) {
      console.error('Media upload error:', err);
      return res.status(400).json({ success: false, error: err.message });
    }

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ success: false, error: 'No media files provided' });
    }

    const uploaded = req.files.map((file) => {
      const isImage = file.mimetype.startsWith('image/');
      return {
        id: 'm_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
        filename: file.filename,
        originalName: file.originalname,
        size: file.size,
        mimetype: file.mimetype,
        type: isImage ? 'image' : 'video',
        path: file.path,
        url: `/uploads/${file.filename}`
      };
    });

    res.json({
      success: true,
      count: uploaded.length,
      files: uploaded
    });
  });
});

// === Legacy Video Upload Endpoint ===
app.post('/api/upload-video', (req, res) => {
  upload.single('videoFile')(req, res, (err) => {
    if (err) {
      console.error('Video upload error:', err);
      return res.status(400).json({ success: false, error: err.message });
    }

    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No video file provided' });
    }

    const isImage = req.file.mimetype.startsWith('image/');
    res.json({
      success: true,
      id: 'm_' + Date.now(),
      filename: req.file.filename,
      originalName: req.file.originalname,
      size: req.file.size,
      mimetype: req.file.mimetype,
      type: isImage ? 'image' : 'video',
      path: req.file.path,
      url: `/uploads/${req.file.filename}`
    });
  });
});

// === Single Test Message Endpoint ===
app.post('/api/test-message', async (req, res) => {
  try {
    const { phone, name = 'Tester', message, mediaFiles = [], videoFilename, countryCode = '91' } = req.body;
    if (!phone) {
      return res.status(400).json({ error: 'Phone number is required' });
    }

    const formatted = formatPhoneNumber(phone, countryCode);
    if (!formatted) {
      return res.status(400).json({ error: 'Invalid phone number format' });
    }

    const { session, campaign } = getDeviceContext(req);
    const check = await session.checkNumber(formatted.digits);
    if (!check.exists) {
      return res.status(400).json({ error: `Phone number ${formatted.formatted} is not registered on WhatsApp` });
    }

    const contactObj = { name, firstName: name.split(' ')[0], phone: formatted.formatted };
    const personalizedText = campaign.replaceVariables(message, contactObj);

    // Resolve local paths for mediaFiles
    const resolvedMedia = [];
    if (Array.isArray(mediaFiles)) {
      for (const m of mediaFiles) {
        const fullPath = m.path || path.join(UPLOADS_DIR, m.filename);
        if (fs.existsSync(fullPath)) {
          resolvedMedia.push({
            ...m,
            path: fullPath
          });
        }
      }
    }

    if (resolvedMedia.length === 0 && videoFilename) {
      const vPath = path.join(UPLOADS_DIR, videoFilename);
      if (fs.existsSync(vPath)) {
        resolvedMedia.push({
          path: vPath,
          filename: videoFilename,
          type: 'video',
          mimetype: 'video/mp4'
        });
      }
    }

    if (resolvedMedia.length > 0) {
      await session.sendMediaBundle(check.jid, resolvedMedia, personalizedText);
    } else if (personalizedText) {
      await session.sendTextMessage(check.jid, personalizedText);
    } else {
      return res.status(400).json({ error: 'Nothing to send (empty message and no media attached)' });
    }

    res.json({ success: true, message: `Test message with ${resolvedMedia.length} media item(s) sent to ${formatted.formatted}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// === Campaign Controls (Per Device / Account) ===
app.post('/api/campaign/start', async (req, res) => {
  try {
    const {
      contacts,
      messageTemplate,
      mediaFiles = [],
      videoFilename,
      videoOriginalName,
      videoCaptionTemplate,
      minDelay,
      maxDelay
    } = req.body;

    const resolvedMedia = [];
    if (Array.isArray(mediaFiles)) {
      for (const m of mediaFiles) {
        const fullPath = m.path || path.join(UPLOADS_DIR, m.filename);
        if (fs.existsSync(fullPath)) {
          resolvedMedia.push({
            ...m,
            path: fullPath
          });
        }
      }
    }

    let videoPath = null;
    if (resolvedMedia.length === 0 && videoFilename) {
      videoPath = path.join(UPLOADS_DIR, videoFilename);
    }

    const { campaign, deviceId } = getDeviceContext(req);
    setupCampaignListeners(campaign, deviceId);

    const result = await campaign.startCampaign({
      contacts,
      messageTemplate,
      mediaFiles: resolvedMedia,
      videoPath,
      videoOriginalName: videoOriginalName || '',
      videoCaptionTemplate,
      minDelay,
      maxDelay
    });

    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/campaign/pause', (req, res) => {
  const { campaign } = getDeviceContext(req);
  const ok = campaign.pause();
  res.json({ success: ok });
});

app.post('/api/campaign/resume', (req, res) => {
  const { campaign } = getDeviceContext(req);
  const ok = campaign.resume();
  res.json({ success: ok });
});

app.post('/api/campaign/stop', (req, res) => {
  const { campaign } = getDeviceContext(req);
  const ok = campaign.stop();
  res.json({ success: ok });
});

app.get('/api/campaign/status', (req, res) => {
  const { campaign } = getDeviceContext(req);
  res.json(campaign.getStatus());
});

app.post('/api/clear-uploads', async (req, res) => {
  try {
    const files = await fs.promises.readdir(UPLOADS_DIR);
    for (const f of files) {
      await fs.promises.unlink(path.join(UPLOADS_DIR, f)).catch(() => {});
    }
    res.json({ success: true, message: 'Uploads directory cleaned' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Helper for campaign event listener registration
function setupCampaignListeners(campaign, deviceId) {
  if (campaign._hasSocketListeners) return;
  campaign._hasSocketListeners = true;

  const room = `device_${deviceId}`;
  campaign.on('started', (data) => io.to(room).emit('campaign:started', data));
  campaign.on('progress', (data) => io.to(room).emit('campaign:progress', data));
  campaign.on('log', (data) => io.to(room).emit('campaign:log', data));
  campaign.on('finished', (data) => io.to(room).emit('campaign:finished', data));
  campaign.on('media_cleaned', () => io.to(room).emit('campaign:media_cleaned'));
  campaign.on('paused', () => io.to(room).emit('campaign:paused'));
  campaign.on('resumed', () => io.to(room).emit('campaign:resumed'));
  campaign.on('stopped', () => io.to(room).emit('campaign:stopped'));
  campaign.on('contact:unregistered_removed', (data) => {
    io.to(room).emit('contacts:updated');
    io.to(room).emit('campaign:contact_removed', data);
  });
}

// === Socket.IO Room-Based Device Isolation ===
io.on('connection', (socket) => {
  socket.on('client:init', ({ deviceId }) => {
    const rawId = deviceId || 'default';
    const cleanId = String(rawId).replace(/[^a-zA-Z0-9_-]/g, '_') || 'default';
    socket.deviceId = cleanId;
    socket.join(`device_${cleanId}`);

    const session = sessionManager.getSession(cleanId);
    const campaign = getCampaignManager(cleanId, session);
    setupCampaignListeners(campaign, cleanId);

    // If session is disconnected, auto-init so QR code is generated for this device
    if (session.status === 'disconnected') {
      session.init();
    }

    // Send immediate initial states for this device only
    socket.emit('whatsapp:status', session.getStatus());
    socket.emit('campaign:status', campaign.getStatus());
  });
});

// SessionManager events routed per-device
sessionManager.on('session:status', (data) => {
  const room = `device_${data.sessionId}`;
  io.to(room).emit('whatsapp:status', data);
  io.to(room).emit('contacts:updated');
});

sessionManager.on('session:qr', (data) => {
  const room = `device_${data.sessionId}`;
  io.to(room).emit('whatsapp:qr', data);
});

sessionManager.on('session:pairing_code', (data) => {
  const room = `device_${data.sessionId}`;
  io.to(room).emit('whatsapp:pairing_code', data);
});

sessionManager.on('session:connected', (data) => {
  const room = `device_${data.sessionId}`;
  io.to(room).emit('whatsapp:connected', data.user);
  io.to(room).emit('contacts:updated');
});

// Start server listening on all network interfaces
server.listen(PORT, '0.0.0.0', async () => {
  const localIp = getLocalIpAddress();
  console.log(`=======================================================`);
  console.log(`WhatsApp Contact & Video Sender is running!`);
  console.log(`Local Web App URL:    http://localhost:${PORT}`);
  console.log(`Mobile Phone Web App: http://${localIp}:${PORT}`);
  console.log(`=======================================================`);

  // If in interactive mode on Windows, open browser automatically
  if (process.platform === 'win32' && !process.env.NO_AUTO_OPEN) {
    setTimeout(() => {
      exec(`start http://localhost:${PORT}`);
    }, 1500);
  }
});
