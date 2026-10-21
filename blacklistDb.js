import fs from 'fs';
import path from 'path';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const BLACKLIST_FILE = path.join(DATA_DIR, 'unsubscribed_contacts.json');

class BlacklistDatabase {
  constructor() {
    this.blacklist = new Map(); // digits -> { digits, name, reason, unsubscribedAt }
    this.ensureDir();
    this.load();
  }

  ensureDir() {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
  }

  load() {
    try {
      this.ensureDir();
      if (fs.existsSync(BLACKLIST_FILE)) {
        const data = JSON.parse(fs.readFileSync(BLACKLIST_FILE, 'utf8'));
        if (Array.isArray(data)) {
          for (const item of data) {
            if (item && item.digits) {
              const clean = String(item.digits).replace(/\D/g, '');
              this.blacklist.set(clean, item);
            }
          }
        }
      }
    } catch (e) {
      console.warn('[BlacklistDB] Load error:', e.message);
    }
  }

  persist() {
    try {
      this.ensureDir();
      const list = Array.from(this.blacklist.values());
      const tempFile = BLACKLIST_FILE + '.tmp';
      fs.writeFileSync(tempFile, JSON.stringify(list, null, 2), 'utf-8');
      fs.renameSync(tempFile, BLACKLIST_FILE);
    } catch (err) {
      console.error('[BlacklistDB] Persist error:', err);
    }
  }

  isBlacklisted(phoneNumber) {
    if (!phoneNumber) return false;
    const clean = String(phoneNumber).replace(/\D/g, '');
    if (!clean) return false;

    // Check exact digits match
    if (this.blacklist.has(clean)) return true;

    // Check without country code (last 10 digits)
    if (clean.length > 10) {
      const last10 = clean.slice(-10);
      if (this.blacklist.has(last10)) return true;
    } else if (clean.length === 10) {
      // Check with common country code e.g. 91
      if (this.blacklist.has('91' + clean)) return true;
    }

    return false;
  }

  add(phoneNumber, reason = 'Replied STOP', name = '') {
    if (!phoneNumber) return null;
    const clean = String(phoneNumber).replace(/\D/g, '');
    if (!clean) return null;

    const record = {
      digits: clean,
      phone: '+' + clean,
      name: name || 'Contact',
      reason: reason || 'Opted out / Replied STOP',
      unsubscribedAt: new Date().toISOString(),
      timestamp: new Date().toLocaleString()
    };

    this.blacklist.set(clean, record);
    this.persist();
    console.log(`[BlacklistDB] Added +${clean} to opt-out database (${reason})`);
    return record;
  }

  remove(phoneNumber) {
    const clean = String(phoneNumber).replace(/\D/g, '');
    if (this.blacklist.delete(clean)) {
      this.persist();
      return true;
    }
    return false;
  }

  clear() {
    this.blacklist.clear();
    this.persist();
    return true;
  }

  getAll() {
    return Array.from(this.blacklist.values()).sort((a, b) => 
      new Date(b.unsubscribedAt || 0) - new Date(a.unsubscribedAt || 0)
    );
  }

  count() {
    return this.blacklist.size;
  }
}

export const blacklistDb = new BlacklistDatabase();
