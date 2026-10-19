import fs from 'fs';
import path from 'path';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const LEGACY_DB_FILE = path.join(DATA_DIR, 'contacts.json');

class ContactsDatabase {
  constructor() {
    this.stores = new Map(); // cleanAccountKey -> Map<digits, contact>
    this.ensureDir();
    this.initLegacy();
  }

  ensureDir() {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
  }

  cleanKey(key) {
    if (!key) return 'default';
    const digitsOnly = String(key).replace(/\D/g, '');
    if (digitsOnly.length >= 7) return digitsOnly;
    return String(key).replace(/[^a-zA-Z0-9_-]/g, '_') || 'default';
  }

  getFilePath(accountKey = 'default') {
    const clean = this.cleanKey(accountKey);
    return path.join(DATA_DIR, `contacts_${clean}.json`);
  }

  getStore(accountKey = 'default') {
    const clean = this.cleanKey(accountKey);
    if (!this.stores.has(clean)) {
      const map = new Map();
      const targetFile = this.getFilePath(clean);

      if (fs.existsSync(targetFile)) {
        try {
          const list = JSON.parse(fs.readFileSync(targetFile, 'utf8'));
          if (Array.isArray(list)) {
            for (const item of list) {
              if (item && item.digits) {
                map.set(item.digits, item);
              }
            }
          }
        } catch (e) {
          console.warn(`[ContactsDB] Error reading ${targetFile}:`, e.message);
        }
      } else if (clean === 'default' && fs.existsSync(LEGACY_DB_FILE)) {
        try {
          const list = JSON.parse(fs.readFileSync(LEGACY_DB_FILE, 'utf8'));
          if (Array.isArray(list)) {
            for (const item of list) {
              if (item && item.digits) map.set(item.digits, item);
            }
          }
        } catch (_) {}
      }

      this.stores.set(clean, map);
    }
    return this.stores.get(clean);
  }

  persist(accountKey = 'default') {
    try {
      this.ensureDir();
      const clean = this.cleanKey(accountKey);
      const store = this.getStore(clean);
      const targetFile = this.getFilePath(clean);
      const list = Array.from(store.values());
      const tempFile = targetFile + '.tmp';
      fs.writeFileSync(tempFile, JSON.stringify(list, null, 2), 'utf-8');
      fs.renameSync(tempFile, targetFile);
    } catch (err) {
      console.error('[ContactsDB] Persist error:', err);
    }
  }

  linkAccount(oldKey, newPhone) {
    if (!oldKey || !newPhone) return;
    const cleanOld = this.cleanKey(oldKey);
    const cleanNew = this.cleanKey(newPhone);
    if (cleanOld === cleanNew) return;

    const oldStore = this.getStore(cleanOld);
    const newStore = this.getStore(cleanNew);

    if (oldStore && oldStore.size > 0 && newStore.size === 0) {
      for (const [digits, item] of oldStore.entries()) {
        newStore.set(digits, { ...item });
      }
      this.persist(cleanNew);
      console.log(`[ContactsDB] Linked ${oldStore.size} contacts from ${cleanOld} to account ${cleanNew}`);
    }
  }

  initLegacy() {
    this.getStore('default');
  }

  upsertContacts(contactsArray, accountKey = 'default') {
    const clean = this.cleanKey(accountKey);
    const store = this.getStore(clean);
    let added = 0;
    let updated = 0;

    for (const c of contactsArray) {
      if (!c || !c.digits) continue;

      if (store.has(c.digits)) {
        const existing = store.get(c.digits);
        if (c.name && (!existing.name || existing.name.startsWith('Contact '))) {
          existing.name = c.name;
          existing.firstName = c.firstName || c.name.split(' ')[0];
        }
        existing.updatedAt = new Date().toISOString();
        updated++;
      } else {
        const newContact = {
          id: c.id || `c_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          name: c.name || `Contact ${store.size + 1}`,
          firstName: c.firstName || (c.name ? c.name.split(' ')[0] : 'Friend'),
          phone: c.phone,
          rawPhone: c.rawPhone || c.phone,
          digits: c.digits,
          jid: c.jid || `${c.digits}@s.whatsapp.net`,
          createdAt: new Date().toISOString(),
          lastStatus: null,
          lastSentAt: null
        };
        store.set(c.digits, newContact);
        added++;
      }
    }

    this.persist(clean);
    return { added, updated, total: store.size, account: clean };
  }

  getAll(search = '', accountKey = 'default') {
    const clean = this.cleanKey(accountKey);
    const store = this.getStore(clean);
    const all = Array.from(store.values());
    if (!search) return all;

    const q = search.toLowerCase();
    return all.filter((c) => {
      return (c.name && c.name.toLowerCase().includes(q)) ||
        (c.phone && c.phone.includes(q)) ||
        (c.digits && c.digits.includes(q));
    });
  }

  getById(id, accountKey = 'default') {
    const store = this.getStore(accountKey);
    for (const c of store.values()) {
      if (c.id === id) return c;
    }
    return null;
  }

  getByDigits(digits, accountKey = 'default') {
    return this.getStore(accountKey).get(digits) || null;
  }

  updateContact(id, updates = {}, accountKey = 'default') {
    const clean = this.cleanKey(accountKey);
    const store = this.getStore(clean);
    for (const [digits, c] of store.entries()) {
      if (c.id === id) {
        if (updates.name !== undefined) {
          c.name = String(updates.name).trim();
          c.firstName = c.name ? c.name.split(' ')[0] : 'Friend';
        }
        if (updates.phone !== undefined && updates.phone) {
          c.phone = updates.phone;
        }
        c.updatedAt = new Date().toISOString();
        this.persist(clean);
        return c;
      }
    }
    return null;
  }

  deleteById(id, accountKey = 'default') {
    const clean = this.cleanKey(accountKey);
    const store = this.getStore(clean);
    for (const [digits, c] of store.entries()) {
      if (c.id === id) {
        store.delete(digits);
        this.persist(clean);
        return true;
      }
    }
    return false;
  }

  deleteByDigits(digits, accountKey = 'default') {
    const clean = this.cleanKey(accountKey);
    const store = this.getStore(clean);
    if (store.has(digits)) {
      store.delete(digits);
      this.persist(clean);
      return true;
    }
    return false;
  }

  clear(accountKey = 'default') {
    const clean = this.cleanKey(accountKey);
    const store = this.getStore(clean);
    store.clear();
    this.persist(clean);
    return true;
  }

  updateStatus(digits, status, reason = '', accountKey = 'default') {
    const clean = this.cleanKey(accountKey);
    const store = this.getStore(clean);
    const contact = store.get(digits);
    if (contact) {
      contact.lastStatus = status;
      contact.lastStatusReason = reason;
      contact.lastSentAt = new Date().toISOString();
      this.persist(clean);
    }
  }

  count(accountKey = 'default') {
    return this.getStore(accountKey).size;
  }
}

export const contactsDb = new ContactsDatabase();
