// WhatsApp Direct Video & Contacts Dispatcher - Client Application Logic

// Persistent Device ID for multi-device & multi-instance isolation
function getOrCreateDeviceId() {
  let devId = localStorage.getItem('wa_device_id');
  if (!devId) {
    devId = 'dev_' + Math.random().toString(36).substring(2, 9) + Date.now().toString(36);
    localStorage.setItem('wa_device_id', devId);
  }
  return devId;
}
const deviceId = getOrCreateDeviceId();

// Intercept all native fetch calls to automatically attach X-Device-Id
const _nativeFetch = window.fetch;
window.fetch = function (url, options = {}) {
  const opts = { ...options };
  opts.headers = new Headers(opts.headers || {});
  if (!opts.headers.has('X-Device-Id')) {
    opts.headers.set('X-Device-Id', deviceId);
  }
  return _nativeFetch(url, opts);
};

const socket = io();
socket.on('connect', () => {
  socket.emit('client:init', { deviceId });
});

// Application State
const state = {
  whatsappStatus: 'disconnected', // 'disconnected' | 'connecting' | 'qr_ready' | 'connected'
  user: null,
  contacts: [],
  selectedContacts: new Set(),
  mediaFiles: [], // Array of { id, filename, originalName, size, type: 'image'|'video', mimetype, url, path }
  campaignRunning: false,
  campaignPaused: false,
  campaignReport: [],
  searchQuery: ''
};

// DOM Elements
const el = {
  // Navigation
  tabs: document.querySelectorAll('.nav-tab'),
  panels: document.querySelectorAll('.tab-panel'),
  tabContactCount: document.getElementById('tabContactCount'),
  tabMediaCount: document.getElementById('tabMediaCount'),

  // Header status
  btnMobileAccess: document.getElementById('btnMobileAccess'),
  connectionPill: document.getElementById('connectionPill'),
  connectionText: document.getElementById('connectionText'),
  logoutBtn: document.getElementById('logoutBtn'),

  // Tab 1: WhatsApp Connect
  btnModeQr: document.getElementById('btnModeQr'),
  btnModePairing: document.getElementById('btnModePairing'),
  qrModeView: document.getElementById('qrModeView'),
  pairingModeView: document.getElementById('pairingModeView'),
  pairingPhoneInput: document.getElementById('pairingPhoneInput'),
  btnGetPairingCode: document.getElementById('btnGetPairingCode'),
  pairingCodeCard: document.getElementById('pairingCodeCard'),
  pairingCodeText: document.getElementById('pairingCodeText'),
  pairingPhoneDisplay: document.getElementById('pairingPhoneDisplay'),
  btnCopyPairingCode: document.getElementById('btnCopyPairingCode'),

  qrLoading: document.getElementById('qrLoading'),
  qrDisplay: document.getElementById('qrDisplay'),
  qrImage: document.getElementById('qrImage'),
  connectedCard: document.getElementById('connectedCard'),
  connectedUserName: document.getElementById('connectedUserName'),
  connectedUserPhone: document.getElementById('connectedUserPhone'),
  reconnectBtn: document.getElementById('reconnectBtn'),

  // Tab 2: Contacts
  contactsAccountBadge: document.getElementById('contactsAccountBadge'),
  countryCodeSelect: document.getElementById('countryCodeSelect'),
  contactsDropZone: document.getElementById('contactsDropZone'),
  contactsFileInput: document.getElementById('contactsFileInput'),
  contactsTableSection: document.getElementById('contactsTableSection'),
  totalContactsLoaded: document.getElementById('totalContactsLoaded'),
  selectedContactsCount: document.getElementById('selectedContactsCount'),
  contactSearchInput: document.getElementById('contactSearchInput'),
  selectAllCheckbox: document.getElementById('selectAllCheckbox'),
  contactsTableBody: document.getElementById('contactsTableBody'),
  clearContactsBtn: document.getElementById('clearContactsBtn'),

  // Paste Modal
  openPasteModalBtn: document.getElementById('openPasteModalBtn'),
  pasteModal: document.getElementById('pasteModal'),
  closePasteModalBtn: document.getElementById('closePasteModalBtn'),
  cancelPasteBtn: document.getElementById('cancelPasteBtn'),
  importPastedBtn: document.getElementById('importPastedBtn'),
  pasteModalTextarea: document.getElementById('pasteModalTextarea'),

  // Tab 3: Composer
  messageTemplate: document.getElementById('messageTemplate'),
  charCount: document.getElementById('charCount'),
  mediaDropZone: document.getElementById('mediaDropZone'),
  mediaFileInput: document.getElementById('mediaFileInput'),
  mediaDropPrompt: document.getElementById('mediaDropPrompt'),
  mediaSummaryText: document.getElementById('mediaSummaryText'),
  mediaGalleryContainer: document.getElementById('mediaGalleryContainer'),
  mediaCountBadge: document.getElementById('mediaCountBadge'),
  mediaListGrid: document.getElementById('mediaListGrid'),
  clearAllMediaBtn: document.getElementById('clearAllMediaBtn'),

  // Mockup Preview
  mockupContactName: document.getElementById('mockupContactName'),
  mockupMediaWrap: document.getElementById('mockupMediaWrap'),
  mockupMediaPreview: document.getElementById('mockupMediaPreview'),
  mockupMediaBadge: document.getElementById('mockupMediaBadge'),
  mockupBubbleText: document.getElementById('mockupBubbleText'),
  mockupTime: document.getElementById('mockupTime'),

  // Tab 4: Campaign
  minDelayInput: document.getElementById('minDelayInput'),
  maxDelayInput: document.getElementById('maxDelayInput'),
  testPhoneInput: document.getElementById('testPhoneInput'),
  sendTestBtn: document.getElementById('sendTestBtn'),
  testSendFeedback: document.getElementById('testSendFeedback'),

  summaryRecipientCount: document.getElementById('summaryRecipientCount'),
  summaryMediaStatus: document.getElementById('summaryMediaStatus'),
  summaryEstTime: document.getElementById('summaryEstTime'),

  startCampaignBtn: document.getElementById('startCampaignBtn'),
  pauseCampaignBtn: document.getElementById('pauseCampaignBtn'),
  resumeCampaignBtn: document.getElementById('resumeCampaignBtn'),
  stopCampaignBtn: document.getElementById('stopCampaignBtn'),

  progressSection: document.getElementById('progressSection'),
  campaignStatusLabel: document.getElementById('campaignStatusLabel'),
  progressPercentage: document.getElementById('progressPercentage'),
  progressBarFill: document.getElementById('progressBarFill'),
  metricTotal: document.getElementById('metricTotal'),
  metricSent: document.getElementById('metricSent'),
  metricFailed: document.getElementById('metricFailed'),
  metricRemaining: document.getElementById('metricRemaining'),

  terminalBody: document.getElementById('terminalBody'),
  clearLogsBtn: document.getElementById('clearLogsBtn'),
  exportReportBtn: document.getElementById('exportReportBtn')
};

// ================= TAB NAVIGATION =================
window.switchTab = function (tabId) {
  el.tabs.forEach((tab) => {
    if (tab.dataset.tab === tabId) {
      tab.classList.add('active');
    } else {
      tab.classList.remove('active');
    }
  });

  document.querySelectorAll('.m-nav-item').forEach((item) => {
    if (item.dataset.tab === tabId) {
      item.classList.add('active');
    } else {
      item.classList.remove('active');
    }
  });

  el.panels.forEach((panel) => {
    if (panel.id === `tab-${tabId}`) {
      panel.classList.add('active');
    } else {
      panel.classList.remove('active');
    }
  });

  window.scrollTo({ top: 0, behavior: 'smooth' });
  updateCampaignSummary();
};

el.tabs.forEach((tab) => {
  tab.addEventListener('click', () => switchTab(tab.dataset.tab));
});

document.querySelectorAll('.m-nav-item').forEach((item) => {
  item.addEventListener('click', () => switchTab(item.dataset.tab));
});

// ================= SOCKET.IO & WHATSAPP STATUS =================
socket.on('whatsapp:status', (data) => {
  updateWhatsAppUI(data);
});

socket.on('whatsapp:qr', (data) => {
  if (data.qrDataUrl) {
    showQRCode(data.qrDataUrl);
  }
});

socket.on('whatsapp:connected', (user) => {
  state.whatsappStatus = 'connected';
  state.user = user;
  showConnectedUI(user);
});

function updateWhatsAppUI(data) {
  state.whatsappStatus = data.status;

  const mNavDot = document.getElementById('mNavConnectDot');
  if (mNavDot) {
    if (data.status === 'connected') {
      mNavDot.classList.add('connected');
    } else {
      mNavDot.classList.remove('connected');
    }
  }

  if (data.status === 'connected') {
    state.user = data.user;
    showConnectedUI(data.user);
  } else if (data.status === 'qr_ready' && data.qrDataUrl) {
    showQRCode(data.qrDataUrl);
  } else {
    // connecting or disconnected
    el.connectionPill.className = 'status-pill status-disconnected';
    el.connectionText.textContent = data.status === 'connecting' ? 'Connecting...' : 'Disconnected';
    el.logoutBtn.classList.add('hidden');

    const loginModeTabs = document.getElementById('loginModeTabs');
    if (loginModeTabs) loginModeTabs.classList.remove('hidden');

    el.connectedCard.classList.add('hidden');
    if (el.btnModePairing && el.btnModePairing.classList.contains('active')) {
      if (el.pairingModeView) el.pairingModeView.classList.remove('hidden');
      if (el.qrModeView) el.qrModeView.classList.add('hidden');
    } else {
      if (el.qrModeView) el.qrModeView.classList.remove('hidden');
      if (el.qrDisplay) el.qrDisplay.classList.add('hidden');
      if (el.qrLoading) el.qrLoading.classList.remove('hidden');
    }
  }
}

function showQRCode(qrDataUrl) {
  el.qrLoading.classList.add('hidden');
  el.connectedCard.classList.add('hidden');
  el.qrDisplay.classList.remove('hidden');
  el.qrImage.src = qrDataUrl;

  const loginModeTabs = document.getElementById('loginModeTabs');
  if (loginModeTabs) loginModeTabs.classList.remove('hidden');

  el.connectionPill.className = 'status-pill status-disconnected';
  el.connectionText.textContent = 'Scan QR Code';
  el.logoutBtn.classList.add('hidden');
}

function showConnectedUI(user) {
  const loginModeTabs = document.getElementById('loginModeTabs');
  if (loginModeTabs) loginModeTabs.classList.add('hidden');
  if (el.pairingModeView) el.pairingModeView.classList.add('hidden');
  if (el.qrModeView) el.qrModeView.classList.add('hidden');
  el.qrLoading.classList.add('hidden');
  el.qrDisplay.classList.add('hidden');
  el.connectedCard.classList.remove('hidden');

  el.connectedUserName.textContent = user?.name || 'WhatsApp Account';
  el.connectedUserPhone.textContent = `+${user?.phone || ''}`;

  el.connectionPill.className = 'status-pill status-connected';
  el.connectionText.textContent = `Connected (+${user?.phone || ''})`;
  el.logoutBtn.classList.remove('hidden');

  // If user has not tested phone, pre-fill with their own connected number
  if (user?.phone && !el.testPhoneInput.value) {
    el.testPhoneInput.value = user.phone;
  }
}

// Disconnect / Logout
el.logoutBtn.addEventListener('click', handleLogout);
el.reconnectBtn.addEventListener('click', handleLogout);

const forceResetQrBtn = document.getElementById('forceResetQrBtn');
if (forceResetQrBtn) {
  forceResetQrBtn.addEventListener('click', async () => {
    forceResetQrBtn.disabled = true;
    forceResetQrBtn.textContent = 'Resetting session...';
    try {
      await fetch('/api/whatsapp/restart', { method: 'POST' });
    } catch (err) {
      console.warn('Force reset error:', err.message);
    } finally {
      setTimeout(() => {
        forceResetQrBtn.disabled = false;
        forceResetQrBtn.textContent = '⚡ Force Reset & Regenerate QR';
      }, 3000);
    }
  });
}

async function handleLogout() {
  if (confirm('Are you sure you want to log out of this WhatsApp account?')) {
    try {
      await fetch('/api/whatsapp/logout', { method: 'POST' });
      addTerminalLog('warn', 'Logged out of WhatsApp. Generating new QR code...');
      // Clear contacts view for previous account
      state.contacts = [];
      state.selectedContacts.clear();
      renderContactsTable();
      updateCampaignSummary();
      loadSavedContacts();
    } catch (err) {
      alert('Failed to logout: ' + err.message);
    }
  }
}

// ================= LOGIN MODE TOGGLE (QR vs PHONE PAIRING) =================
if (el.btnModeQr && el.btnModePairing) {
  el.btnModeQr.addEventListener('click', () => {
    el.btnModeQr.classList.add('active');
    el.btnModePairing.classList.remove('active');
    if (el.qrModeView) el.qrModeView.classList.remove('hidden');
    if (el.pairingModeView) el.pairingModeView.classList.add('hidden');
    if (state.whatsappStatus !== 'connected' && (!el.qrImage || !el.qrImage.src || el.qrImage.src.includes('data:image/svg') || el.qrImage.classList.contains('hidden'))) {
      fetch('/api/whatsapp/restart', { method: 'POST' }).catch(() => {});
    }
  });

  el.btnModePairing.addEventListener('click', () => {
    el.btnModePairing.classList.add('active');
    el.btnModeQr.classList.remove('active');
    if (el.pairingModeView) el.pairingModeView.classList.remove('hidden');
    if (el.qrModeView) el.qrModeView.classList.add('hidden');
    if (el.pairingPhoneInput) el.pairingPhoneInput.focus();
  });
}

// Request WhatsApp 8-digit Pairing Code
if (el.btnGetPairingCode && el.pairingPhoneInput) {
  el.btnGetPairingCode.addEventListener('click', async () => {
    const rawPhone = el.pairingPhoneInput.value.trim();
    if (!rawPhone) {
      alert('Please enter your WhatsApp phone number with country code (e.g. 919725537047).');
      el.pairingPhoneInput.focus();
      return;
    }

    el.btnGetPairingCode.disabled = true;
    el.btnGetPairingCode.textContent = 'Generating...';
    addTerminalLog('info', `Requesting 8-digit WhatsApp pairing code for ${rawPhone}...`);

    try {
      const res = await fetch('/api/whatsapp/pairing-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: rawPhone })
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Failed to generate pairing code');
      }

      displayPairingCode(data.code, data.phone);
      addTerminalLog('success', `✔ Pairing code: ${data.code} (Phone: +${data.phone}) - enter this in your WhatsApp mobile app under "Link with phone number instead"`);
    } catch (err) {
      alert('Pairing Code error: ' + err.message);
      addTerminalLog('error', `✖ Pairing Code error: ${err.message}`);
    } finally {
      el.btnGetPairingCode.disabled = false;
      el.btnGetPairingCode.textContent = 'Get Code';
    }
  });

  el.pairingPhoneInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      el.btnGetPairingCode.click();
    }
  });
}

function displayPairingCode(code, phone = '') {
  if (!code) return;
  if (el.pairingCodeText) el.pairingCodeText.textContent = code;
  if (el.pairingPhoneDisplay) {
    el.pairingPhoneDisplay.textContent = phone ? `Phone Number: +${phone}` : '';
  }
  if (el.pairingCodeCard) el.pairingCodeCard.classList.remove('hidden');
}

if (el.btnCopyPairingCode) {
  el.btnCopyPairingCode.addEventListener('click', () => {
    const code = el.pairingCodeText ? el.pairingCodeText.textContent.trim() : '';
    if (code) {
      navigator.clipboard.writeText(code).then(() => {
        el.btnCopyPairingCode.textContent = '✔ Copied!';
        setTimeout(() => {
          el.btnCopyPairingCode.textContent = '📋 Copy Code';
        }, 2000);
      });
    }
  });
}

socket.on('whatsapp:pairing_code', (data) => {
  if (data && data.code) {
    displayPairingCode(data.code);
  }
});

// ================= MOBILE PHONE ACCESS MODAL =================
const mobileAccessModal = document.getElementById('mobileAccessModal');
const closeMobileModalBtn = document.getElementById('closeMobileModalBtn');
const dismissMobileModalBtn = document.getElementById('dismissMobileModalBtn');
const mobileUrlInput = document.getElementById('mobileUrlInput');
const btnCopyMobileUrl = document.getElementById('btnCopyMobileUrl');
const mobileQrImg = document.getElementById('mobileQrImg');

if (el.btnMobileAccess && mobileAccessModal) {
  el.btnMobileAccess.addEventListener('click', async () => {
    mobileAccessModal.classList.remove('hidden');
    try {
      const res = await fetch('/api/network-info');
      const data = await res.json();
      if (data && data.mobileUrl) {
        if (mobileUrlInput) mobileUrlInput.value = data.mobileUrl;
        if (mobileQrImg && data.qrDataUrl) {
          mobileQrImg.src = data.qrDataUrl;
        }
      }
    } catch (err) {
      console.warn('Network info error:', err);
    }
  });
}

const hideMobileModal = () => {
  if (mobileAccessModal) mobileAccessModal.classList.add('hidden');
};
if (closeMobileModalBtn) closeMobileModalBtn.addEventListener('click', hideMobileModal);
if (dismissMobileModalBtn) dismissMobileModalBtn.addEventListener('click', hideMobileModal);

if (btnCopyMobileUrl && mobileUrlInput) {
  btnCopyMobileUrl.addEventListener('click', () => {
    navigator.clipboard.writeText(mobileUrlInput.value).then(() => {
      btnCopyMobileUrl.textContent = 'Copied!';
      setTimeout(() => (btnCopyMobileUrl.textContent = 'Copy'), 2000);
    });
  });
}


// ================= CONTACTS MANAGEMENT =================
// Drag and drop for contact files
['dragenter', 'dragover'].forEach((eventName) => {
  el.contactsDropZone.addEventListener(eventName, (e) => {
    e.preventDefault();
    e.stopPropagation();
    el.contactsDropZone.classList.add('dragover');
  });
});

['dragleave', 'drop'].forEach((eventName) => {
  el.contactsDropZone.addEventListener(eventName, (e) => {
    e.preventDefault();
    e.stopPropagation();
    el.contactsDropZone.classList.remove('dragover');
  });
});

el.contactsDropZone.addEventListener('drop', (e) => {
  const files = e.dataTransfer.files;
  if (files.length > 0) {
    uploadContactsFile(files[0]);
  }
});

el.contactsFileInput.addEventListener('change', (e) => {
  if (e.target.files.length > 0) {
    uploadContactsFile(e.target.files[0]);
  }
});

async function uploadContactsFile(file) {
  const formData = new FormData();
  formData.append('contactsFile', file);
  formData.append('defaultCountryCode', el.countryCodeSelect.value);

  addTerminalLog('info', `Uploading & parsing contacts from "${file.name}"...`);

  try {
    const res = await fetch('/api/upload-contacts', {
      method: 'POST',
      body: formData
    });
    const data = await res.json();

    if (!res.ok || !data.success) {
      throw new Error(data.error || 'Failed to parse contact file');
    }

    mergeContacts(data.contacts);
    addTerminalLog('success', `✔ Successfully loaded ${data.count} contacts from ${file.name}`);
  } catch (err) {
    alert('Contact upload error: ' + err.message);
    addTerminalLog('error', `✖ Failed to load contacts: ${err.message}`);
  } finally {
    el.contactsFileInput.value = '';
  }
}

// Paste contacts modal
el.openPasteModalBtn.addEventListener('click', () => {
  el.pasteModal.classList.remove('hidden');
  el.pasteModalTextarea.focus();
});

const closePasteModal = () => el.pasteModal.classList.add('hidden');
el.closePasteModalBtn.addEventListener('click', closePasteModal);
el.cancelPasteBtn.addEventListener('click', closePasteModal);

el.importPastedBtn.addEventListener('click', async () => {
  const text = el.pasteModalTextarea.value.trim();
  if (!text) {
    alert('Please enter or paste at least one contact line.');
    return;
  }

  try {
    const res = await fetch('/api/parse-text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        defaultCountryCode: el.countryCodeSelect.value
      })
    });
    const data = await res.json();

    if (data.contacts && data.contacts.length > 0) {
      mergeContacts(data.contacts);
      addTerminalLog('success', `✔ Added ${data.contacts.length} pasted contacts`);
      el.pasteModalTextarea.value = '';
      closePasteModal();
    } else {
      alert('Could not detect any valid phone numbers. Please check formatting.');
    }
  } catch (err) {
    alert('Failed to parse text: ' + err.message);
  }
});

// ================= DIRECT PHONE CONTACTS IMPORT (ANDROID APK & MOBILE) =================
const btnSyncPhoneContacts = document.getElementById('btnSyncPhoneContacts');
if (btnSyncPhoneContacts) {
  btnSyncPhoneContacts.addEventListener('click', async () => {
    btnSyncPhoneContacts.disabled = true;
    const oldText = btnSyncPhoneContacts.innerHTML;
    btnSyncPhoneContacts.innerHTML = '⏳ Reading Phone Contacts...';
    addTerminalLog('info', '📱 Requesting access to phone contacts...');

    try {
      let rawContacts = [];

      // Method 1: Check if running inside the Android APK (via AndroidNative bridge)
      if (window.AndroidNative && typeof window.AndroidNative.getDeviceContacts === 'function') {
        const jsonStr = window.AndroidNative.getDeviceContacts();
        if (jsonStr === 'PERMISSION_REQUIRED') {
          alert('Please allow Contacts permission on your phone to import contacts.');
          return;
        }
        try {
          rawContacts = JSON.parse(jsonStr);
        } catch (e) {
          throw new Error('Failed to parse phone contacts JSON: ' + e.message);
        }
      }
      // Method 2: Check if browser supports modern Contact Picker API (Chrome on Android / PWA)
      else if ('contacts' in navigator && 'ContactsManager' in window) {
        try {
          const props = ['name', 'tel'];
          const selected = await navigator.contacts.select(props, { multiple: true });
          if (selected && selected.length > 0) {
            selected.forEach((item) => {
              const name = item.name && item.name[0] ? item.name[0] : 'Contact';
              if (item.tel && item.tel.length > 0) {
                item.tel.forEach((num) => {
                  rawContacts.push({ name, phone: num });
                });
              }
            });
          }
        } catch (pickerErr) {
          console.warn('Contact picker cancelled or failed:', pickerErr);
          return;
        }
      }
      // Method 3: Desktop browser fallback notice
      else {
        alert('Direct phone contact access is available when running inside the Android APK or Chrome on your phone.\n\nOn Desktop, please use "📁 Browse Files" to drop your Google Contacts CSV / vCard or use "📋 Paste Numbers Manually".');
        return;
      }

      if (!rawContacts || rawContacts.length === 0) {
        addTerminalLog('warn', 'No contacts selected or found on device.');
        return;
      }

      addTerminalLog('info', `Found ${rawContacts.length} contacts on phone. Saving to database...`);

      const res = await fetch('/api/contacts/import-device', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contacts: rawContacts,
          defaultCountryCode: el.countryCodeSelect.value
        })
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Failed to save contacts');
      }

      mergeContacts(data.contacts);
      addTerminalLog('success', `✔ Successfully imported ${data.count} contacts directly from your phone address book!`);
      alert(`✔ Successfully imported ${data.count} contacts from your phone!`);

    } catch (err) {
      alert('Phone contacts import error: ' + err.message);
      addTerminalLog('error', `✖ Phone contacts import failed: ${err.message}`);
    } finally {
      btnSyncPhoneContacts.disabled = false;
      btnSyncPhoneContacts.innerHTML = oldText;
    }
  });

  const btnSyncPhoneContactsMobile = document.getElementById('btnSyncPhoneContactsMobile');
  if (btnSyncPhoneContactsMobile) {
    btnSyncPhoneContactsMobile.addEventListener('click', () => btnSyncPhoneContacts.click());
  }
}

const openPasteModalBtnMobile = document.getElementById('openPasteModalBtnMobile');
if (openPasteModalBtnMobile && el.openPasteModalBtn) {
  openPasteModalBtnMobile.addEventListener('click', () => el.openPasteModalBtn.click());
}


function mergeContacts(newContacts) {
  const existingMap = new Map();
  state.contacts.forEach((c) => existingMap.set(c.digits, c));

  newContacts.forEach((c) => {
    if (!existingMap.has(c.digits)) {
      c.selected = true;
      state.contacts.push(c);
      state.selectedContacts.add(c.id);
    }
  });

  renderContactsTable();
  updateCampaignSummary();
}

// Prompt-based customer name edit (works on mobile & desktop)
async function editCustomerNamePrompt(contactId, currentName) {
  const newName = prompt('Enter updated customer name:', currentName);
  if (!newName || newName.trim() === '' || newName.trim() === currentName) {
    return;
  }
  const cleanName = newName.trim();
  try {
    const res = await fetch(`/api/contacts/${contactId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: cleanName })
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.error || 'Failed to update name');
    }
    const c = state.contacts.find((x) => x.id === contactId);
    if (c) {
      c.name = cleanName;
      c.firstName = cleanName.split(' ')[0] || 'Friend';
    }
    renderContactsTable();
    addTerminalLog('success', `✔ Updated customer name to "${cleanName}"`);
  } catch (err) {
    alert('Failed to save name: ' + err.message);
  }
}

// Re-render contacts table & mobile cards
function renderContactsTable() {
  const q = state.searchQuery.toLowerCase();
  const filtered = state.contacts.filter((c) => {
    return c.name.toLowerCase().includes(q) || c.phone.includes(q);
  });

  if (state.contacts.length > 0) {
    el.contactsTableSection.classList.remove('hidden');
  } else {
    el.contactsTableSection.classList.add('hidden');
  }

  el.totalContactsLoaded.textContent = state.contacts.length;
  el.selectedContactsCount.textContent = state.selectedContacts.size;
  el.tabContactCount.textContent = state.contacts.length;

  // Mobile Bottom Nav Badge
  const mNavContactBadge = document.getElementById('mNavContactBadge');
  if (mNavContactBadge) {
    mNavContactBadge.textContent = state.contacts.length;
  }

  // 1. Desktop Table
  el.contactsTableBody.innerHTML = '';

  // 2. Mobile Touch Cards
  const mobileList = document.getElementById('mobileContactsList');
  if (mobileList) {
    mobileList.innerHTML = '';
  }

  filtered.forEach((contact, idx) => {
    const isChecked = state.selectedContacts.has(contact.id);

    // Desktop Row
    const tr = document.createElement('tr');
    tr.dataset.id = contact.id;
    tr.innerHTML = `
      <td><input type="checkbox" data-id="${contact.id}" class="contact-checkbox" ${isChecked ? 'checked' : ''}></td>
      <td class="text-muted text-xs">${idx + 1}</td>
      <td class="name-cell">
        <div class="name-view">
          <strong class="contact-name-text">${escapeHtml(contact.name)}</strong>
          <button type="button" class="btn-edit-name-icon" title="Edit customer name">✏️</button>
        </div>
        <div class="name-edit hidden">
          <input type="text" class="name-edit-input" value="${escapeHtml(contact.name)}">
          <button type="button" class="btn-save-name" title="Save name">✔</button>
          <button type="button" class="btn-cancel-name" title="Cancel">✕</button>
        </div>
      </td>
      <td><code class="font-mono text-emerald">${contact.phone}</code></td>
      <td class="text-muted text-xs font-mono">${contact.jid}</td>
      <td>
        <div class="row-actions">
          <button type="button" class="btn-row-edit" title="Edit customer name">✏️ Edit</button>
          <button type="button" class="contact-del-btn" data-id="${contact.id}" title="Remove contact">✕</button>
        </div>
      </td>
    `;

    const chk = tr.querySelector('.contact-checkbox');
    chk.addEventListener('change', (e) => {
      if (e.target.checked) {
        state.selectedContacts.add(contact.id);
      } else {
        state.selectedContacts.delete(contact.id);
      }
      renderContactsTable();
      updateCampaignSummary();
    });

    const nameView = tr.querySelector('.name-view');
    const nameEdit = tr.querySelector('.name-edit');
    const nameInput = tr.querySelector('.name-edit-input');
    const btnEditIcon = tr.querySelector('.btn-edit-name-icon');
    const btnRowEdit = tr.querySelector('.btn-row-edit');
    const btnSave = tr.querySelector('.btn-save-name');
    const btnCancel = tr.querySelector('.btn-cancel-name');

    const startEditing = () => {
      nameView.classList.add('hidden');
      nameEdit.classList.remove('hidden');
      nameInput.value = contact.name;
      nameInput.focus();
      nameInput.select();
    };

    const cancelEditing = () => {
      nameEdit.classList.add('hidden');
      nameView.classList.remove('hidden');
    };

    const saveName = async () => {
      const newName = nameInput.value.trim();
      if (!newName) {
        alert('Customer name cannot be empty');
        nameInput.focus();
        return;
      }

      if (newName === contact.name) {
        cancelEditing();
        return;
      }

      btnSave.disabled = true;
      btnSave.textContent = '...';

      try {
        const res = await fetch(`/api/contacts/${contact.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: newName })
        });
        const data = await res.json();
        if (!res.ok || !data.success) {
          throw new Error(data.error || 'Failed to update name');
        }

        contact.name = newName;
        contact.firstName = newName.split(' ')[0] || 'Friend';
        renderContactsTable();
        addTerminalLog('success', `✔ Customer name updated to "${newName}" (${contact.phone})`);
      } catch (err) {
        alert('Failed to save name: ' + err.message);
      }
    };

    btnEditIcon.addEventListener('click', startEditing);
    btnRowEdit.addEventListener('click', startEditing);
    btnCancel.addEventListener('click', cancelEditing);
    btnSave.addEventListener('click', saveName);

    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        saveName();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cancelEditing();
      }
    });

    const del = tr.querySelector('.contact-del-btn');
    del.addEventListener('click', async () => {
      const contactId = contact.id;
      state.contacts = state.contacts.filter((c) => c.id !== contactId);
      state.selectedContacts.delete(contactId);
      renderContactsTable();
      updateCampaignSummary();
      await fetch(`/api/contacts/${contactId}`, { method: 'DELETE' }).catch(() => {});
    });

    el.contactsTableBody.appendChild(tr);

    // Mobile Card
    if (mobileList) {
      const initials = (contact.name || 'C')
        .split(' ')
        .filter(Boolean)
        .map((n) => n[0])
        .slice(0, 2)
        .join('')
        .toUpperCase() || 'C';

      const card = document.createElement('div');
      card.className = `m-contact-card ${isChecked ? 'selected' : ''}`;
      card.innerHTML = `
        <div class="m-checkbox-wrap">
          <input type="checkbox" class="m-card-chk" ${isChecked ? 'checked' : ''}>
        </div>
        <div class="m-avatar">${initials}</div>
        <div class="m-info">
          <div class="m-name-row">
            <span class="m-name">${escapeHtml(contact.name)}</span>
            <button type="button" class="m-btn-edit-name" title="Edit customer name">✏️</button>
          </div>
          <div>
            <span class="m-phone-badge">${contact.phone}</span>
            ${contact.lastStatus ? `<span class="m-status-badge ${contact.lastStatus === 'Sent' ? 'text-emerald' : 'text-danger'}">${contact.lastStatus}</span>` : ''}
          </div>
        </div>
        <div class="m-card-actions">
          <button type="button" class="m-btn-del" title="Remove contact">✕</button>
        </div>
      `;

      const mChk = card.querySelector('.m-card-chk');
      mChk.addEventListener('change', (e) => {
        if (e.target.checked) {
          state.selectedContacts.add(contact.id);
        } else {
          state.selectedContacts.delete(contact.id);
        }
        renderContactsTable();
        updateCampaignSummary();
      });

      card.querySelector('.m-btn-edit-name').addEventListener('click', () => {
        editCustomerNamePrompt(contact.id, contact.name);
      });

      card.querySelector('.m-btn-del').addEventListener('click', async () => {
        const contactId = contact.id;
        state.contacts = state.contacts.filter((c) => c.id !== contactId);
        state.selectedContacts.delete(contactId);
        renderContactsTable();
        updateCampaignSummary();
        await fetch(`/api/contacts/${contactId}`, { method: 'DELETE' }).catch(() => {});
      });

      mobileList.appendChild(card);
    }
  });

  // Select all checkbox state
  el.selectAllCheckbox.checked = state.contacts.length > 0 && state.selectedContacts.size === state.contacts.length;

  if (state.contacts.length > 0) {
    el.mockupContactName.textContent = state.contacts[0].name;
    updateMockupPreview();
  }
}

// Select all toggle
el.selectAllCheckbox.addEventListener('change', (e) => {
  const isChecked = e.target.checked;
  if (isChecked) {
    state.contacts.forEach((c) => state.selectedContacts.add(c.id));
  } else {
    state.selectedContacts.clear();
  }
  renderContactsTable();
  updateCampaignSummary();
});

// Search input
el.contactSearchInput.addEventListener('input', (e) => {
  state.searchQuery = e.target.value.trim();
  renderContactsTable();
});

// Clear all contacts
el.clearContactsBtn.addEventListener('click', async () => {
  if (confirm('Clear all contacts from device database?')) {
    state.contacts = [];
    state.selectedContacts.clear();
    renderContactsTable();
    updateCampaignSummary();
    await fetch('/api/contacts', { method: 'DELETE' }).catch(() => {});
    addTerminalLog('warn', 'Device contacts database cleared.');
  }
});

async function loadSavedContacts() {
  try {
    const res = await fetch('/api/contacts');
    const data = await res.json();
    if (data.success) {
      if (el.contactsAccountBadge) {
        if (data.account) {
          el.contactsAccountBadge.textContent = `Account: +${data.account}`;
          el.contactsAccountBadge.style.display = 'inline-flex';
        } else {
          el.contactsAccountBadge.textContent = 'Default (No Account Connected)';
          el.contactsAccountBadge.style.display = 'inline-flex';
        }
      }
      state.contacts = data.contacts || [];
      state.selectedContacts = new Set(state.contacts.map((c) => c.id));
      renderContactsTable();
      updateCampaignSummary();
      if (data.contacts && data.contacts.length > 0) {
        addTerminalLog('info', `💾 Loaded ${data.contacts.length} saved contacts for account [${data.account ? '+' + data.account : 'default'}]`);
      }
    }
  } catch (err) {
    console.warn('Failed to load contacts from DB:', err);
  }
}

socket.on('contacts:updated', (data) => {
  addTerminalLog('info', `🔄 Contacts refreshed from database.`);
  loadSavedContacts();
});

socket.on('campaign:contact_removed', (data) => {
  if (data && data.contact) {
    addTerminalLog('warn', `🗑 Removed unregistered number from active list: ${data.contact.name} (${data.contact.phone})`);
  }
  loadSavedContacts();
});



// ================= COMPOSER & VIDEO UPLOAD =================
window.insertTag = function (tag) {
  const textarea = el.messageTemplate;
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const text = textarea.value;

  textarea.value = text.substring(0, start) + tag + text.substring(end);
  textarea.selectionStart = textarea.selectionEnd = start + tag.length;
  textarea.focus();

  updateMockupPreview();
};

el.messageTemplate.addEventListener('input', updateMockupPreview);

function updateMockupPreview() {
  const rawText = el.messageTemplate.value || 'Hi {firstName}, here is a special message for you!';
  el.charCount.textContent = `${rawText.length} chars`;

  const sampleContact = state.contacts.length > 0 ? state.contacts[0] : { name: 'Alex Doe', firstName: 'Alex', phone: '+919876543210' };

  let previewText = rawText
    .replace(/{name}/gi, sampleContact.name)
    .replace(/{firstName}/gi, sampleContact.firstName)
    .replace(/{phone}/gi, sampleContact.phone);

  el.mockupBubbleText.textContent = previewText;

  const now = new Date();
  const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  el.mockupTime.textContent = timeStr;

  // Media preview inside chat bubble
  if (state.mediaFiles.length > 0) {
    el.mockupMediaWrap.classList.remove('hidden');
    const firstMedia = state.mediaFiles[0];
    if (firstMedia.type === 'image') {
      el.mockupMediaPreview.style.backgroundImage = `url('${firstMedia.url}')`;
      el.mockupMediaPreview.innerHTML = '';
      el.mockupMediaBadge.textContent = state.mediaFiles.length > 1 ? `1 of ${state.mediaFiles.length} (IMAGE)` : 'IMAGE';
    } else {
      el.mockupMediaPreview.style.backgroundImage = 'none';
      el.mockupMediaPreview.innerHTML = `
        <div class="video-play-overlay">
          <svg viewBox="0 0 24 24" width="32" height="32" fill="#fff">
            <polygon points="5 3 19 12 5 21 5 3"></polygon>
          </svg>
        </div>
      `;
      el.mockupMediaBadge.textContent = state.mediaFiles.length > 1 ? `1 of ${state.mediaFiles.length} (VIDEO)` : 'VIDEO';
    }
  } else {
    el.mockupMediaWrap.classList.add('hidden');
    el.mockupMediaPreview.style.backgroundImage = 'none';
    el.mockupMediaPreview.innerHTML = '';
  }
}

// Media drag and drop (multiple images & videos)
['dragenter', 'dragover'].forEach((eventName) => {
  el.mediaDropZone.addEventListener(eventName, (e) => {
    e.preventDefault();
    e.stopPropagation();
    el.mediaDropZone.classList.add('dragover');
  });
});

['dragleave', 'drop'].forEach((eventName) => {
  el.mediaDropZone.addEventListener(eventName, (e) => {
    e.preventDefault();
    e.stopPropagation();
    el.mediaDropZone.classList.remove('dragover');
  });
});

el.mediaDropZone.addEventListener('click', (e) => {
  el.mediaFileInput.click();
});

el.mediaDropZone.addEventListener('drop', (e) => {
  const files = e.dataTransfer.files;
  if (files.length > 0) {
    uploadMediaFiles(files);
  }
});

el.mediaFileInput.addEventListener('change', (e) => {
  if (e.target.files.length > 0) {
    uploadMediaFiles(e.target.files);
  }
});

async function uploadMediaFiles(fileList) {
  const files = Array.from(fileList);
  if (files.length === 0) return;

  const formData = new FormData();
  let totalBytes = 0;
  files.forEach((f) => {
    formData.append('mediaFiles', f);
    totalBytes += f.size;
  });

  const totalMb = (totalBytes / (1024 * 1024)).toFixed(1);
  addTerminalLog('info', `Uploading ${files.length} media file(s) (${totalMb} MB total)...`);

  try {
    const res = await fetch('/api/upload-media', {
      method: 'POST',
      body: formData
    });

    const raw = await res.text();
    let data;
    try {
      data = JSON.parse(raw);
    } catch (parseErr) {
      throw new Error(`Upload server error (${res.status}): ${raw.slice(0, 100)}`);
    }

    if (!res.ok || !data.success) {
      throw new Error(data.error || 'Failed to upload media');
    }

    // Append newly uploaded files
    data.files.forEach((item) => {
      state.mediaFiles.push(item);
    });

    renderMediaGallery();
    addTerminalLog('success', `✔ Added ${data.files.length} media item(s). Total attached: ${state.mediaFiles.length}`);
  } catch (err) {
    alert('Media upload error: ' + err.message);
    addTerminalLog('error', `✖ Media upload failed: ${err.message}`);
  } finally {
    el.mediaFileInput.value = '';
  }
}

function renderMediaGallery() {
  const count = state.mediaFiles.length;
  el.mediaCountBadge.textContent = count;
  el.tabMediaCount.textContent = count;

  const mNavMediaBadge = document.getElementById('mNavMediaBadge');
  if (mNavMediaBadge) {
    mNavMediaBadge.textContent = count;
    mNavMediaBadge.style.display = count > 0 ? 'inline-block' : 'none';
  }

  if (count === 0) {
    el.mediaGalleryContainer.classList.add('hidden');
    el.mediaSummaryText.textContent = '0 files attached';
    updateMockupPreview();
    updateCampaignSummary();
    return;
  }

  el.mediaGalleryContainer.classList.remove('hidden');

  let imgCount = 0;
  let vidCount = 0;
  let totalBytes = 0;

  el.mediaListGrid.innerHTML = '';

  state.mediaFiles.forEach((media, index) => {
    totalBytes += media.size || 0;
    if (media.type === 'image') imgCount++;
    else vidCount++;

    const sizeMb = ((media.size || 0) / (1024 * 1024)).toFixed(1);
    const card = document.createElement('div');
    card.className = 'media-card';

    const thumbHtml = media.type === 'image'
      ? `<img src="${media.url}" alt="${escapeHtml(media.originalName)}">`
      : `<video src="${media.url}" preload="metadata"></video>`;

    const badgeClass = media.type === 'image' ? 'badge-image' : 'badge-video';
    const badgeText = media.type === 'image' ? 'IMAGE' : 'VIDEO';

    card.innerHTML = `
      <div class="media-thumb-wrap">
        ${thumbHtml}
        <span class="media-type-badge ${badgeClass}">${badgeText}</span>
        <button type="button" class="media-card-remove" data-id="${media.id}" title="Remove file">✕</button>
      </div>
      <div class="media-info-bar">
        <span class="media-name" title="${escapeHtml(media.originalName)}">${escapeHtml(media.originalName)}</span>
        <span class="media-size">${sizeMb} MB</span>
      </div>
    `;

    // Remove single file
    card.querySelector('.media-card-remove').addEventListener('click', (e) => {
      e.stopPropagation();
      state.mediaFiles = state.mediaFiles.filter((m) => m.id !== media.id);
      renderMediaGallery();
      addTerminalLog('info', `Removed "${media.originalName}". ${state.mediaFiles.length} file(s) remaining.`);
    });

    el.mediaListGrid.appendChild(card);
  });

  const totalMb = (totalBytes / (1024 * 1024)).toFixed(1);
  el.mediaSummaryText.textContent = `${count} files (${imgCount} img, ${vidCount} vid - ${totalMb} MB)`;

  updateMockupPreview();
  updateCampaignSummary();
}

// Clear all media
el.clearAllMediaBtn.addEventListener('click', async () => {
  if (confirm('Remove all attached images and videos?')) {
    state.mediaFiles = [];
    renderMediaGallery();
    addTerminalLog('info', 'All attached media files cleared.');
    await fetch('/api/clear-uploads', { method: 'POST' }).catch(() => {});
  }
});

socket.on('campaign:media_cleaned', () => {
  state.mediaFiles = [];
  renderMediaGallery();
  addTerminalLog('info', '🧹 Media attachments cleaned from server storage.');
});

// ================= TEST MESSAGE =================
el.sendTestBtn.addEventListener('click', async () => {
  const phone = el.testPhoneInput.value.trim();
  if (!phone) {
    el.testSendFeedback.innerHTML = `<span class="text-danger">Please enter a phone number to test</span>`;
    return;
  }

  if (state.whatsappStatus !== 'connected') {
    el.testSendFeedback.innerHTML = `<span class="text-danger">Please scan QR code and connect WhatsApp first in Step 1</span>`;
    return;
  }

  el.sendTestBtn.disabled = true;
  el.testSendFeedback.innerHTML = `<span class="text-muted">Sending test message...</span>`;
  addTerminalLog('info', `Sending test message with ${state.mediaFiles.length} media file(s) to ${phone}...`);

  try {
    const res = await fetch('/api/test-message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        phone,
        message: el.messageTemplate.value,
        mediaFiles: state.mediaFiles,
        countryCode: el.countryCodeSelect.value
      })
    });
    const data = await res.json();

    if (!res.ok || !data.success) {
      throw new Error(data.error || 'Failed to send test message');
    }

    el.testSendFeedback.innerHTML = `<span class="text-emerald">✔ Test message sent successfully!</span>`;
    addTerminalLog('success', `✔ Test message delivered to ${phone}`);
  } catch (err) {
    el.testSendFeedback.innerHTML = `<span class="text-danger">✖ ${err.message}</span>`;
    addTerminalLog('error', `✖ Test message failed: ${err.message}`);
  } finally {
    el.sendTestBtn.disabled = false;
  }
});

// ================= CAMPAIGN EXECUTION =================
function updateCampaignSummary() {
  const readyCount = state.selectedContacts.size;
  el.summaryRecipientCount.textContent = readyCount;

  if (state.mediaFiles.length > 0) {
    const imgCount = state.mediaFiles.filter((m) => m.type === 'image').length;
    const vidCount = state.mediaFiles.filter((m) => m.type === 'video').length;
    let label = `${state.mediaFiles.length} file(s)`;
    if (imgCount > 0 && vidCount > 0) label += ` (${imgCount} img, ${vidCount} vid)`;
    else if (imgCount > 0) label += ` (${imgCount} image${imgCount > 1 ? 's' : ''})`;
    else if (vidCount > 0) label += ` (${vidCount} video${vidCount > 1 ? 's' : ''})`;

    el.summaryMediaStatus.textContent = `Yes (${label})`;
    el.summaryMediaStatus.className = 'stat-val text-emerald';
  } else {
    el.summaryMediaStatus.textContent = 'No (Text Only)';
    el.summaryMediaStatus.className = 'stat-val text-muted';
  }

  const minD = Number(el.minDelayInput.value) || 4;
  const maxD = Number(el.maxDelayInput.value) || 8;
  const avgSec = (minD + maxD) / 2;
  const totalSec = Math.round(readyCount * avgSec);
  const estMins = (totalSec / 60).toFixed(1);

  el.summaryEstTime.textContent = readyCount > 0 ? `~${estMins} mins` : '0 mins';
}

[el.minDelayInput, el.maxDelayInput].forEach((input) => {
  input.addEventListener('input', () => {
    document.querySelectorAll('.btn-preset').forEach((b) => b.classList.remove('active'));
    updateCampaignSummary();
  });
});

window.setSpeedPreset = function (minSec, maxSec, btn) {
  el.minDelayInput.value = minSec;
  el.maxDelayInput.value = maxSec;
  document.querySelectorAll('.btn-preset').forEach((b) => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  updateCampaignSummary();
};

// Start Campaign
el.startCampaignBtn.addEventListener('click', async () => {
  if (state.whatsappStatus !== 'connected') {
    alert('WhatsApp is not connected! Please go to Step 1 and scan the QR code first.');
    switchTab('connect');
    return;
  }

  const selectedList = state.contacts.filter((c) => state.selectedContacts.has(c.id));
  if (selectedList.length === 0) {
    alert('No contacts selected! Please import and select contacts in Step 2.');
    switchTab('contacts');
    return;
  }

  const messageText = el.messageTemplate.value.trim();
  if (!messageText && state.mediaFiles.length === 0) {
    alert('Please enter a message or attach images/videos in Step 3.');
    switchTab('composer');
    return;
  }

  addTerminalLog('info', `🚀 Starting campaign dispatch to ${selectedList.length} contacts (${state.mediaFiles.length} media attached)...`);

  try {
    el.startCampaignBtn.classList.add('hidden');
    el.pauseCampaignBtn.classList.remove('hidden');
    el.stopCampaignBtn.classList.remove('hidden');
    el.progressSection.classList.remove('hidden');

    state.campaignRunning = true;
    state.campaignReport = [];

    const res = await fetch('/api/campaign/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contacts: selectedList,
        messageTemplate: messageText,
        mediaFiles: state.mediaFiles,
        minDelay: Number(el.minDelayInput.value) || 4,
        maxDelay: Number(el.maxDelayInput.value) || 8
      })
    });

    const raw = await res.text();
    let data;
    try {
      data = JSON.parse(raw);
    } catch (parseErr) {
      throw new Error(`Server returned (${res.status}): ${raw.slice(0, 100)}`);
    }

    if (!res.ok || !data.success) {
      throw new Error(data.error || 'Failed to start campaign');
    }
  } catch (err) {
    alert('Failed to launch campaign: ' + err.message);
    addTerminalLog('error', `✖ Failed to start campaign: ${err.message}`);
    resetCampaignControls();
  }
});

// Pause / Resume / Stop
el.pauseCampaignBtn.addEventListener('click', async () => {
  await fetch('/api/campaign/pause', { method: 'POST' });
});

el.resumeCampaignBtn.addEventListener('click', async () => {
  await fetch('/api/campaign/resume', { method: 'POST' });
});

el.stopCampaignBtn.addEventListener('click', async () => {
  if (confirm('Stop the campaign? Unsent messages will be cancelled.')) {
    await fetch('/api/campaign/stop', { method: 'POST' });
  }
});

// Socket.io Campaign events
socket.on('campaign:started', (data) => {
  state.campaignRunning = true;
  el.progressSection.classList.remove('hidden');
  el.startCampaignBtn.classList.add('hidden');
  el.pauseCampaignBtn.classList.remove('hidden');
  el.resumeCampaignBtn.classList.add('hidden');
  el.stopCampaignBtn.classList.remove('hidden');

  const mDot = document.getElementById('mNavCampaignDot');
  if (mDot) mDot.style.display = 'block';

  el.metricTotal.textContent = data.total;
  el.metricSent.textContent = 0;
  el.metricFailed.textContent = 0;
  el.metricRemaining.textContent = data.total;
  el.campaignStatusLabel.textContent = 'Sending Campaign...';
});

socket.on('campaign:progress', (data) => {
  el.progressBarFill.style.width = `${data.percentage}%`;
  el.progressPercentage.textContent = `${data.percentage}%`;

  el.metricTotal.textContent = data.total;
  el.metricSent.textContent = data.sentCount;
  el.metricFailed.textContent = data.failedCount;
  el.metricRemaining.textContent = Math.max(0, data.total - data.current);
});

socket.on('campaign:paused', () => {
  state.campaignPaused = true;
  el.campaignStatusLabel.textContent = 'Campaign Paused';
  el.pauseCampaignBtn.classList.add('hidden');
  el.resumeCampaignBtn.classList.remove('hidden');
});

socket.on('campaign:resumed', () => {
  state.campaignPaused = false;
  el.campaignStatusLabel.textContent = 'Sending Campaign...';
  el.resumeCampaignBtn.classList.add('hidden');
  el.pauseCampaignBtn.classList.remove('hidden');
});

socket.on('campaign:finished', (data) => {
  state.campaignRunning = false;
  resetCampaignControls();
  el.campaignStatusLabel.textContent = 'Campaign Finished';
  el.progressBarFill.style.width = '100%';
  el.progressPercentage.textContent = '100%';

  const mDot = document.getElementById('mNavCampaignDot');
  if (mDot) mDot.style.display = 'none';

  if (data?.summary?.report) {
    state.campaignReport = data.summary.report;
  }

  addTerminalLog('success', `🎉 Campaign finished! Delivered: ${data?.summary?.sentCount || 0}, Failed: ${data?.summary?.failedCount || 0}`);
  alert(`Campaign completed!\n• Delivered: ${data?.summary?.sentCount || 0}\n• Failed: ${data?.summary?.failedCount || 0}\n\nYou can click "Export Report (.CSV)" to download the results.`);
});

socket.on('campaign:stopped', () => {
  state.campaignRunning = false;
  resetCampaignControls();
  el.campaignStatusLabel.textContent = 'Campaign Stopped';
  const mDot = document.getElementById('mNavCampaignDot');
  if (mDot) mDot.style.display = 'none';
  addTerminalLog('warn', 'Campaign was stopped.');
});

socket.on('campaign:log', (log) => {
  addTerminalLog(log.type, `[${log.timestamp}] ${log.text}`);
});

function resetCampaignControls() {
  el.startCampaignBtn.classList.remove('hidden');
  el.pauseCampaignBtn.classList.add('hidden');
  el.resumeCampaignBtn.classList.add('hidden');
  el.stopCampaignBtn.classList.add('hidden');
}

// Terminal logs
function addTerminalLog(type, message) {
  const line = document.createElement('div');
  line.className = `terminal-line log-${type}`;
  line.textContent = message;
  el.terminalBody.appendChild(line);
  el.terminalBody.scrollTop = el.terminalBody.scrollHeight;
}

el.clearLogsBtn.addEventListener('click', () => {
  el.terminalBody.innerHTML = '';
});

// Export CSV report
el.exportReportBtn.addEventListener('click', () => {
  if (!state.campaignReport || state.campaignReport.length === 0) {
    alert('No campaign report data available yet.');
    return;
  }

  let csvContent = 'data:text/csv;charset=utf-8,Name,Phone,Status,Reason,Time\n';
  state.campaignReport.forEach((row) => {
    const cleanName = `"${(row.name || '').replace(/"/g, '""')}"`;
    const cleanPhone = `"${row.phone || ''}"`;
    const cleanStatus = `"${row.status || ''}"`;
    const cleanReason = `"${(row.reason || '').replace(/"/g, '""')}"`;
    const cleanTime = `"${row.time || ''}"`;
    csvContent += `${cleanName},${cleanPhone},${cleanStatus},${cleanReason},${cleanTime}\n`;
  });

  const encodedUri = encodeURI(csvContent);
  const link = document.createElement('a');
  link.setAttribute('href', encodedUri);
  link.setAttribute('download', `whatsapp_campaign_report_${Date.now()}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
});

// Helper
function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Initialize on page load
updateMockupPreview();
updateCampaignSummary();
loadSavedContacts();

// Register Service Worker for Mobile PWA (Add to Home screen / APK experience)
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.warn('PWA service worker registration skipped:', err);
    });
  });
}

