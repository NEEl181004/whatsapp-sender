import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { sessionManager } from './whatsappService.js';
import { contactsDb } from './contactsDb.js';
import { blacklistDb } from './blacklistDb.js';

export class CampaignManager extends EventEmitter {
  constructor(sessionId, session = null) {
    super();
    this.sessionId = sessionId;
    this.session = session || sessionManager.getSession(sessionId);
    this.isRunning = false;
    this.isPaused = false;
    this.shouldStop = false;
    this.currentCampaign = null;
  }

  get accountKey() {
    return this.session?.accountPhone || this.sessionId;
  }

  getDelay(minSec = 3, maxSec = 6) {
    const min = Math.max(1, Number(minSec) || 3);
    const max = Math.max(min, Number(maxSec) || 6);
    return Math.floor(Math.random() * (max - min + 1) + min) * 1000;
  }

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  buildFormattedMessage(template, contact, autoFormat = true) {
    if (!template) return '';
    let text = String(template).trim();

    if (autoFormat) {
      const hasGreeting = /^(hi|hello|hey|dear|namaste|greetings)/i.test(text);
      const hasOptOut = /reply stop|to unsubscribe|stop to opt/i.test(text);

      let header = '';
      if (!hasGreeting) {
        header = `{Hello|Hi|Greetings} {firstName},\n\n`;
      }

      let footer = '';
      if (!hasOptOut) {
        footer = `\n\nReply STOP if you don't wish to receive future updates.`;
      }

      text = `${header}${text}${footer}`;
    }

    return this.replaceVariables(text, contact);
  }

  replaceVariables(template, contact) {
    if (!template) return '';
    let result = template
      .replace(/{name}/gi, contact.name || 'Friend')
      .replace(/{firstName}/gi, contact.firstName || contact.name || 'Friend')
      .replace(/{phone}/gi, contact.phone || '');

    // Spintax support: e.g. {Hello|Hi|Greetings} randomly selected per contact
    result = result.replace(/\{([^{}]+)\}/g, (match, choices) => {
      if (choices.includes('|')) {
        const parts = choices.split('|');
        return parts[Math.floor(Math.random() * parts.length)].trim();
      }
      return match;
    });

    // Anti-Fingerprinting: Append invisible zero-width marker to ensure unique cryptographic hash per message
    const zeroWidthMarkers = ['\u200B', '\u200C', '\u200D', '\uFEFF'];
    const marker = zeroWidthMarkers[Math.floor(Math.random() * zeroWidthMarkers.length)];
    return result + marker;
  }

  async ensureConnected(maxWaitMs = 45000) {
    if (this.session && this.session.status === 'connected') {
      return true;
    }
    this.addLog('warn', `⏳ WhatsApp connection temporarily interrupted. Pausing campaign and waiting for reconnect (up to ${Math.round(maxWaitMs / 1000)}s)...`);
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      if (this.shouldStop) return false;
      await this.sleep(1500);
      if (this.session && this.session.status === 'connected') {
        this.addLog('success', `✔ WhatsApp connection restored! Resuming campaign.`);
        return true;
      }
    }
    return false;
  }

  async startCampaign(options) {
    if (this.isRunning) {
      throw new Error('A campaign is already running on this device');
    }

    const {
      contacts = [],
      messageTemplate = '',
      videoPath = null,
      videoOriginalName = '',
      mediaFiles = [],
      videoCaptionTemplate = '',
      minDelay = 8,
      maxDelay = 18,
      simulateTyping = true,
      batchSize = 20,
      batchRestSec = 120,
      randomCooldown = true,
      batchMinMsgs = 12,
      batchMaxMsgs = 25,
      cooldownMinSec = 60,
      cooldownMaxSec = 150,
      autoFormatMessage = true
    } = options;

    if (!contacts || contacts.length === 0) {
      throw new Error('No contacts provided');
    }

    const hasMedia = (mediaFiles && mediaFiles.length > 0) || Boolean(videoPath);
    if (!messageTemplate && !hasMedia) {
      throw new Error('Please provide either a message or media files to send');
    }

    this.isRunning = true;
    this.isPaused = false;
    this.shouldStop = false;

    // Helper to calculate the next unpredictable message burst count (e.g. 12 - 25 messages)
    const getNextBurstTarget = () => {
      if (!randomCooldown && batchSize > 0) return batchSize;
      const min = Math.max(5, Number(batchMinMsgs) || 12);
      const max = Math.max(min + 1, Number(batchMaxMsgs) || 25);
      return Math.floor(Math.random() * (max - min + 1)) + min;
    };

    // Helper to calculate the next unpredictable rest duration in seconds (e.g. 60s - 150s)
    const getNextCooldownSec = () => {
      if (!randomCooldown && batchRestSec > 0) return batchRestSec;
      const min = Math.max(20, Number(cooldownMinSec) || 60);
      const max = Math.max(min + 10, Number(cooldownMaxSec) || 150);
      return Math.floor(Math.random() * (max - min + 1)) + min;
    };

    const isCooldownEnabled = (batchSize > 0 || randomCooldown) && (batchRestSec > 0 || cooldownMinSec > 0);
    let burstCount = 0;
    let nextBurstMilestone = getNextBurstTarget();

    this.currentCampaign = {
      startTime: new Date().toISOString(),
      total: contacts.length,
      current: 0,
      sentCount: 0,
      failedCount: 0,
      skippedCount: 0,
      logs: [],
      report: []
    };

    this.emit('started', this.currentCampaign);

    (async () => {
      try {
        for (let i = 0; i < contacts.length; i++) {
          if (this.shouldStop) {
            this.addLog('warn', 'Campaign stopped by user.');
            break;
          }

          while (this.isPaused) {
            await this.sleep(1000);
            if (this.shouldStop) break;
          }

          if (this.shouldStop) break;

          const contact = contacts[i];

          // Check if contact has previously unsubscribed / replied STOP
          if (blacklistDb.isBlacklisted(contact.digits)) {
            this.currentCampaign.skippedCount++;
            this.addLog('warn', `⏭️ Skipped ${contact.name} (${contact.phone}): Contact previously replied STOP (Unsubscribed).`);
            this.currentCampaign.report.push({
              name: contact.name,
              phone: contact.phone,
              status: 'Skipped (Unsubscribed)',
              reason: 'On STOP / Opt-Out Blacklist',
              time: new Date().toLocaleTimeString()
            });
            continue;
          }

          // Ensure session is connected before attempting to send
          if (!this.session || this.session.status !== 'connected') {
            const reconnected = await this.ensureConnected(45000);
            if (!reconnected) {
              this.addLog('error', `🛑 WhatsApp disconnected. Campaign is safely PAUSED at contact ${i + 1} of ${contacts.length} to preserve your remaining ${contacts.length - i} contacts. Click Resume when WhatsApp reconnects.`);
              this.isPaused = true;
              this.emit('paused', { reason: 'WhatsApp disconnected' });
              while (this.isPaused) {
                await this.sleep(1000);
                if (this.shouldStop) break;
              }
              if (this.shouldStop) break;
              i--; // Retry this contact after resuming
              continue;
            }
          }

          this.currentCampaign.current = i + 1;

          this.emit('progress', {
            current: i + 1,
            total: contacts.length,
            sentCount: this.currentCampaign.sentCount,
            failedCount: this.currentCampaign.failedCount,
            currentContact: contact,
            percentage: Math.round(((i + 1) / contacts.length) * 100)
          });

          this.addLog('info', `Checking & sending to ${contact.name} (${contact.phone})...`);
          
          const targetJid = contact.jid || `${contact.digits}@s.whatsapp.net`;
          const textToSend = this.buildFormattedMessage(messageTemplate, contact, autoFormatMessage);
          const captionToSend = this.buildFormattedMessage(videoCaptionTemplate || messageTemplate, contact, autoFormatMessage);

          // Human simulation: Emulate typing presence for 1.8s - 3.2s
          if (simulateTyping && this.session?.simulateTyping) {
            const typingDuration = Math.floor(Math.random() * 1400 + 1800);
            await this.session.simulateTyping(targetJid, typingDuration);
          }

          try {
            // Direct, reliable transmission using Baileys standard socket protocol
            if (mediaFiles && mediaFiles.length > 0) {
              await this.session.sendMediaBundle(targetJid, mediaFiles, captionToSend);
            } else if (videoPath) {
              await this.session.sendVideoMessage(targetJid, videoPath, captionToSend, 'video/mp4', videoOriginalName);
            } else if (textToSend) {
              await this.session.sendTextMessage(targetJid, textToSend);
            }

            this.currentCampaign.sentCount++;
            contactsDb.updateStatus(contact.digits, 'Sent', 'Delivered', this.accountKey);

            this.addLog('success', `✔ Delivered to ${contact.name} (${contact.phone})`);
            this.currentCampaign.report.push({
              name: contact.name,
              phone: contact.phone,
              status: 'Sent',
              reason: 'Delivered',
              time: new Date().toLocaleTimeString()
            });

            burstCount++;

            // Dynamic Anti-Ban Cooldown: Rest after an unpredictable, randomized number of sends
            if (isCooldownEnabled && burstCount >= nextBurstMilestone && i < contacts.length - 1 && !this.shouldStop) {
              const cooldownSec = getNextCooldownSec();
              const cooldownMins = Math.round((cooldownSec / 60) * 10) / 10;
              this.addLog('warn', `🛡️ Dynamic Anti-Ban Cooldown: Sent a burst of ${burstCount} messages. Taking an unpredictable human break for ${cooldownSec}s (~${cooldownMins}m) to defeat automated pattern detection...`);
              const restStart = Date.now();
              while (Date.now() - restStart < cooldownSec * 1000) {
                if (this.shouldStop) break;
                while (this.isPaused) {
                  await this.sleep(1000);
                  if (this.shouldStop) break;
                }
                await this.sleep(1000);
              }
              burstCount = 0;
              nextBurstMilestone = getNextBurstTarget();
              if (!this.shouldStop) {
                this.addLog('info', `✔ Cooldown break finished! Resuming next batch (next pause in ~${nextBurstMilestone} messages)...`);
              }
            }

          } catch (err) {
            const errMsg = String(err.message || '').toLowerCase();
            const isConnErr = errMsg.includes('not connected') || 
                              errMsg.includes('connection closed') || 
                              errMsg.includes('connection lost') ||
                              errMsg.includes('timed out');

            // Handle temporary socket glitch: attempt reconnection and retry contact once
            if (isConnErr) {
              this.addLog('warn', `⚠️ Connection glitch while sending to ${contact.name}. Waiting for reconnect to retry...`);
              const reconnected = await this.ensureConnected(45000);
              if (reconnected) {
                try {
                  await this.sleep(1500);
                  if (mediaFiles && mediaFiles.length > 0) {
                    await this.session.sendMediaBundle(targetJid, mediaFiles, captionToSend);
                  } else if (videoPath) {
                    await this.session.sendVideoMessage(targetJid, videoPath, captionToSend, 'video/mp4', videoOriginalName);
                  } else if (textToSend) {
                    await this.session.sendTextMessage(targetJid, textToSend);
                  }

                  this.currentCampaign.sentCount++;
                  contactsDb.updateStatus(contact.digits, 'Sent', 'Delivered', this.accountKey);
                  this.addLog('success', `✔ Delivered to ${contact.name} (${contact.phone}) (after reconnect)`);
                  this.currentCampaign.report.push({
                    name: contact.name,
                    phone: contact.phone,
                    status: 'Sent',
                    reason: 'Delivered (reconnected)',
                    time: new Date().toLocaleTimeString()
                  });
                  continue; // Successfully delivered on retry!
                } catch (_) {
                  // Fall through to failure recording
                }
              } else {
                // Connection permanently lost: PAUSE CAMPAIGN SAFELY!
                this.isPaused = true;
                this.addLog('error', `🛑 WhatsApp disconnected and could not reconnect. Campaign is PAUSED at contact ${i + 1} of ${contacts.length}. Your remaining ${contacts.length - i} contacts are safe. Click Resume once WhatsApp is reconnected.`);
                this.emit('paused', { reason: 'WhatsApp disconnected' });
                while (this.isPaused) {
                  await this.sleep(1000);
                  if (this.shouldStop) break;
                }
                if (this.shouldStop) break;
                i--; // Retry this contact after resuming
                continue;
              }
            }

            this.currentCampaign.failedCount++;
            const isNotOnWa = errMsg.includes('not-authorized') || 
                              errMsg.includes('not registered') || 
                              errMsg.includes('item-not-found');

            if (isNotOnWa) {
              contactsDb.deleteByDigits(contact.digits, this.accountKey);
              this.addLog('warn', `⚠️ Removed ${contact.name} (${contact.phone}) from database: Number is not on WhatsApp.`);
              this.emit('contact:unregistered_removed', { contact, digits: contact.digits });
            } else {
              contactsDb.updateStatus(contact.digits, 'Failed', err.message, this.accountKey);
            }

            this.addLog('error', `✖ Error sending to ${contact.name} (${contact.phone}): ${err.message}`);
            this.currentCampaign.report.push({
              name: contact.name,
              phone: contact.phone,
              status: isNotOnWa ? 'Removed (Not on WhatsApp)' : 'Failed',
              reason: err.message,
              time: new Date().toLocaleTimeString()
            });
          }

          // Anti-ban delay before next contact
          if (i < contacts.length - 1 && !this.shouldStop) {
            const delayMs = this.getDelay(minDelay, maxDelay);
            const delaySec = (delayMs / 1000).toFixed(1);
            this.addLog('info', `⏳ Anti-ban waiting ${delaySec}s before next contact...`);
            await this.sleep(delayMs);
          }
        }
      } catch (fatalErr) {
        this.addLog('error', `Campaign stopped unexpectedly: ${fatalErr.message}`);
      } finally {
        this.isRunning = false;
        this.isPaused = false;

        // Automatically delete uploaded media files from disk once message has been sent to users
        try {
          let cleanedFilesCount = 0;
          if (mediaFiles && mediaFiles.length > 0) {
            for (const media of mediaFiles) {
              const targetPath = media.path || (media.filename ? path.resolve(process.cwd(), 'uploads', media.filename) : null);
              if (targetPath && fs.existsSync(targetPath)) {
                try {
                  await fs.promises.unlink(targetPath);
                  cleanedFilesCount++;
                  console.log(`[Media Cleanup ${this.sessionId}] Deleted ${targetPath} from disk.`);
                } catch (delErr) {
                  console.warn(`[Media Cleanup ${this.sessionId}] Could not delete ${targetPath}:`, delErr.message);
                }
              }
            }
          }
          if (videoPath && fs.existsSync(videoPath)) {
            try {
              await fs.promises.unlink(videoPath);
              cleanedFilesCount++;
              console.log(`[Media Cleanup ${this.sessionId}] Deleted ${videoPath} from disk.`);
            } catch (_) {}
          }
          if (cleanedFilesCount > 0) {
            this.addLog('info', `🗑 Cleaned up ${cleanedFilesCount} uploaded media file(s) from server storage.`);
            this.emit('media_cleaned');
          }
        } catch (cleanupErr) {
          console.warn(`[Media Cleanup ${this.sessionId}] Error cleaning media files:`, cleanupErr.message);
        }

        this.emit('finished', {
          summary: {
            total: this.currentCampaign.total,
            sentCount: this.currentCampaign.sentCount,
            failedCount: this.currentCampaign.failedCount,
            skippedCount: this.currentCampaign.skippedCount,
            report: this.currentCampaign.report
          }
        });
      }
    })();

    return { success: true, message: 'Campaign started' };
  }

  pause() {
    if (this.isRunning && !this.isPaused) {
      this.isPaused = true;
      this.addLog('warn', 'Campaign paused.');
      this.emit('paused');
      return true;
    }
    return false;
  }

  resume() {
    if (this.isRunning && this.isPaused) {
      this.isPaused = false;
      this.addLog('info', 'Campaign resumed.');
      this.emit('resumed');
      return true;
    }
    return false;
  }

  stop() {
    if (this.isRunning) {
      this.shouldStop = true;
      this.isPaused = false;
      this.addLog('warn', 'Stopping campaign...');
      this.emit('stopped');
      return true;
    }
    return false;
  }

  addLog(type, text) {
    const logItem = {
      timestamp: new Date().toLocaleTimeString(),
      type,
      text
    };
    if (this.currentCampaign) {
      this.currentCampaign.logs.push(logItem);
    }
    this.emit('log', logItem);
  }

  getStatus() {
    return {
      sessionId: this.sessionId,
      isRunning: this.isRunning,
      isPaused: this.isPaused,
      currentCampaign: this.currentCampaign
    };
  }
}

const campaignManagers = new Map();

export function getCampaignManager(sessionId = 'default', session = null) {
  const cleanId = String(sessionId || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
  if (!campaignManagers.has(cleanId)) {
    const s = session || sessionManager.getSession(cleanId);
    campaignManagers.set(cleanId, new CampaignManager(cleanId, s));
  }
  return campaignManagers.get(cleanId);
}

// Default instance for backwards compatibility
export const campaignManager = getCampaignManager('default');
