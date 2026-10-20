import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { sessionManager } from './whatsappService.js';
import { contactsDb } from './contactsDb.js';

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

  replaceVariables(template, contact) {
    if (!template) return '';
    return template
      .replace(/{name}/gi, contact.name || 'Friend')
      .replace(/{firstName}/gi, contact.firstName || contact.name || 'Friend')
      .replace(/{phone}/gi, contact.phone || '');
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
      minDelay = 3,
      maxDelay = 6
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
        // Step 1: Pre-upload media to WhatsApp server ONCE
        let preparedMediaList = [];
        if (mediaFiles && mediaFiles.length > 0) {
          this.addLog('info', `⏳ Pre-uploading ${mediaFiles.length} media file(s) to WhatsApp servers ONCE... (avoids re-uploading for every customer)`);
          try {
            preparedMediaList = await this.session.prepareMediaBundle(mediaFiles);
            this.addLog('success', `✔ Media upload complete! Ready for rapid batch delivery to ${contacts.length} recipients.`);
          } catch (prepErr) {
            this.addLog('warn', `Media pre-upload notice: ${prepErr.message}. Will use direct transmission.`);
          }
        }

        // Step 2: Iterate through recipients with 0 bytes re-upload!
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
          
          try {
            let targetJid = contact.jid || `${contact.digits}@s.whatsapp.net`;
            try {
              const check = await this.session.checkNumber(contact.digits);
              if (check !== null) {
                if (!check.exists) {
                  // Auto-remove unregistered contact from persistent database
                  contactsDb.deleteByDigits(contact.digits, this.accountKey);
                  this.currentCampaign.failedCount++;
                  this.addLog('warn', `⚠️ ${contact.name} (${contact.phone}) is NOT registered on WhatsApp. Automatically removed from database.`);
                  this.currentCampaign.report.push({
                    name: contact.name,
                    phone: contact.phone,
                    status: 'Removed (Not on WhatsApp)',
                    reason: 'Number not registered on WhatsApp - deleted from DB',
                    time: new Date().toLocaleTimeString()
                  });
                  this.emit('contact:unregistered_removed', { contact, digits: contact.digits });
                  continue;
                } else if (check.jid) {
                  targetJid = check.jid;
                }
              }
            } catch (chkErr) {
              // Non-fatal check error, proceed with direct JID
            }

            // Prepare personalized text & caption
            const textToSend = this.replaceVariables(messageTemplate, contact);
            const captionToSend = this.replaceVariables(videoCaptionTemplate || messageTemplate, contact);

            // Send using preloaded media token
            if (preparedMediaList && preparedMediaList.length > 0) {
              await this.session.sendPreloadedMediaBundle(targetJid, preparedMediaList, captionToSend);
            } else if (mediaFiles && mediaFiles.length > 0) {
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

          } catch (err) {
            this.currentCampaign.failedCount++;
            const errMsg = String(err.message || '').toLowerCase();
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
