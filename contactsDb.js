import fs from 'fs';
import path from 'path';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const LEGACY_DB_FILE = path.join(DATA_DIR, 'contacts.json');

class ContactsDatabase {
  constructor() {
    this.contactsMap = new Map(); // Keyed by phone digits
    this.activeAccount = null; // null or phone digits of connected WhatsApp account (e.g. '919725537047')
    this.isLoaded = false;
    this.ensureDir();
    this.load();
  }

  ensureDir() {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
  }

  getActiveAccount() {
    return this.activeAccount;
  }

  getFilePath(account = null) {
    const acc = account || this.activeAccount;
    if (acc) {
      const cleanAcc = String(acc).replace(/\D/g, '');
      return path.join(DATA_DIR, `contacts_${cleanAcc}.json`);
    }
    // If no account is specified, use legacy or shared file
    return LEGACY_DB_FILE;
  }

  /**
   * Switches the active contacts database to match the currently logged in WhatsApp account.
   * Account A's contacts will never be visible to Account B.
   */
  switchAccount(accountPhone) {
    const clean = accountPhone ? String(accountPhone).replace(/\D/g, '') : null;
    this.activeAccount = clean;
    this.contactsMap.clear();

    if (!clean) {
      console.log('[Database] Active WhatsApp account cleared. Contacts isolated.');
      this.isLoaded = true;
      return;
    }

    const accountFile = this.getFilePath(clean);

    // If account-specific file does not exist yet, migrate any initial contacts from legacy contacts.json
    if (!fs.existsSync(accountFile) && fs.existsSync(LEGACY_DB_FILE)) {
      try {
        const raw = fs.readFileSync(LEGACY_DB_FILE, 'utf-8');
        const list = JSON.parse(raw);
        if (Array.isArray(list) && list.length > 0) {
          console.log(`[Database] Linking ${list.length} initial contacts to account +${clean}...`);
          fs.writeFileSync(accountFile, JSON.stringify(list, null, 2), 'utf-8');
        }
      } catch (_) {}
    }

    this.load();
  }

  load() {
    try {
      this.ensureDir();
      const targetFile = this.getFilePath();

      if (fs.existsSync(targetFile)) {
        const raw = fs.readFileSync(targetFile, 'utf-8');
        const list = JSON.parse(raw);
        if (Array.isArray(list)) {
          this.contactsMap.clear();
          for (const item of list) {
            if (item && item.digits) {
              this.contactsMap.set(item.digits, item);
            }
          }
          console.log(`[Database] Loaded ${this.contactsMap.size} persistent contacts for account: ${this.activeAccount || 'default'} from ${path.basename(targetFile)}`);
        }
      } else {
        this.contactsMap.clear();
        if (this.activeAccount) {
          this.persist();
        }
      }
      this.isLoaded = true;
    } catch (err) {
      console.error('[Database] Error loading contacts DB:', err);
      this.contactsMap = new Map();
      this.isLoaded = true;
    }
  }

  persist() {
    try {
      this.ensureDir();
      const targetFile = this.getFilePath();
      const list = Array.from(this.contactsMap.values());
      const tempFile = targetFile + '.tmp';
      fs.writeFileSync(tempFile, JSON.stringify(list, null, 2), 'utf-8');
      fs.renameSync(tempFile, targetFile);
    } catch (err) {
      console.error('[Database] Error persisting contacts to disk:', err);
    }
  }

  /**
   * Upsert contacts: adds new or updates existing without duplicates
   */
  upsertContacts(contactsArray) {
    let added = 0;
    let updated = 0;

    for (const c of contactsArray) {
      if (!c || !c.digits) continue;

      if (this.contactsMap.has(c.digits)) {
        const existing = this.contactsMap.get(c.digits);
        // Update name if previously generic
        if (c.name && (!existing.name || existing.name.startsWith('Contact '))) {
          existing.name = c.name;
          existing.firstName = c.firstName || c.name.split(' ')[0];
        }
        existing.updatedAt = new Date().toISOString();
        updated++;
      } else {
        const newContact = {
          id: c.id || `c_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          name: c.name || `Contact ${this.contactsMap.size + 1}`,
          firstName: c.firstName || (c.name ? c.name.split(' ')[0] : 'Friend'),
          phone: c.phone,
          rawPhone: c.rawPhone || c.phone,
          digits: c.digits,
          jid: c.jid || `${c.digits}@s.whatsapp.net`,
          createdAt: new Date().toISOString(),
          lastStatus: null,
          lastSentAt: null
        };
        this.contactsMap.set(c.digits, newContact);
        added++;
      }
    }

    this.persist();
    return { added, updated, total: this.contactsMap.size, account: this.activeAccount };
  }

  getAll(search = '') {
    const all = Array.from(this.contactsMap.values());
    if (!search) return all;

    const q = search.toLowerCase();
    return all.filter((c) => {
      return (c.name && c.name.toLowerCase().includes(q)) ||
        (c.phone && c.phone.includes(q)) ||
        (c.digits && c.digits.includes(q));
    });
  }

  getById(id) {
    for (const c of this.contactsMap.values()) {
      if (c.id === id) return c;
    }
    return null;
  }

  getByDigits(digits) {
    return this.contactsMap.get(digits) || null;
  }

  updateContact(id, updates = {}) {
    for (const [digits, c] of this.contactsMap.entries()) {
      if (c.id === id) {
        if (updates.name !== undefined) {
          c.name = String(updates.name).trim();
          c.firstName = c.name ? c.name.split(' ')[0] : 'Friend';
        }
        if (updates.phone !== undefined && updates.phone) {
          c.phone = updates.phone;
        }
        c.updatedAt = new Date().toISOString();
        this.persist();
        return c;
      }
    }
    return null;
  }

  deleteById(id) {
    for (const [digits, c] of this.contactsMap.entries()) {
      if (c.id === id) {
        this.contactsMap.delete(digits);
        this.persist();
        return true;
      }
    }
    return false;
  }

  deleteByDigits(digits) {
    if (this.contactsMap.has(digits)) {
      this.contactsMap.delete(digits);
      this.persist();
      return true;
    }
    return false;
  }

  clear() {
    this.contactsMap.clear();
    this.persist();
    return true;
  }

  updateStatus(digits, status, reason = '') {
    const contact = this.contactsMap.get(digits);
    if (contact) {
      contact.lastStatus = status;
      contact.lastStatusReason = reason;
      contact.lastSentAt = new Date().toISOString();
      this.persist();
    }
  }

  count() {
    return this.contactsMap.size;
  }
}

export const contactsDb = new ContactsDatabase();
