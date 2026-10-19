# 🚀 WhatsApp Direct Video & Google Contacts Dispatcher

A fast, 100% free, and automated WhatsApp messaging & video sender that connects directly to your phone via WhatsApp Web multi-device protocol.

---

## 🌟 New & Advanced Features

- **🔒 Account-Isolated Contacts**: Contacts are strictly scoped to the active WhatsApp account. If you log in with Account A, only Account A's contacts are visible. When you switch to Account B, Account A's contacts are hidden and Account B's isolated contacts are loaded.
- **📱 Direct Phone Contacts Access (1-Click)**: In the Android APK (or mobile Chrome), click **"📱 Import Phone Contacts"** to read and import all contacts directly from your phone's address book with 1 click!
- **🧹 Auto-Purge Non-WhatsApp Numbers**: The engine automatically verifies each phone number. If a contact is not registered on WhatsApp, it is **instantly deleted from the database** automatically, keeping your database clean.
- **💾 Mobile Database Persistence**: All database operations work seamlessly from your phone. Any contact imported, edited, or cleaned on the phone is permanently saved on the server database.
- **🖥️ Standalone Desktop App (`WhatsApp-Sender.exe`)**: No more terminal commands, Node commands, or port conflicts! Just double-click the `.exe` (or the Desktop shortcut `WhatsApp Sender`). It automatically manages ports, kills zombie processes, starts the engine silently, and opens your browser.
- **📱 Standalone Android App (`WhatsApp-Sender.apk`)**: Install the native APK directly on your phone with full camera, contact access, and file upload support.
- **🔢 Link with Phone Number (Pairing Code)**: No camera needed! Enter your phone number, get an 8-digit code, and pair in seconds.
- **Multiple Images & Videos**: Attach multiple photos (`.jpg`, `.png`, `.webp`) and large videos (`.mp4`, `.mov`, `.mkv`) simultaneously.
- **Google Contacts Sync**: Import contacts directly from Google Contacts export (`Google CSV` or `.vcf` vCard), Excel (`.xlsx`, `.xls`), or paste raw text.
- **Customer Name Editor**: Edit any customer's name directly in the table with one click.
- **🛡️ Smart Anti-Ban Human Pacing**: Randomized delay between messages (default 4 to 8 seconds) to mimic natural human behavior.
- **Real-Time Terminal Console & CSV Export**: Live audit log showing instant status for each message with 1-click CSV report download.

---

## ⚡ Quick Start Guide

### 1. Launch the Application (.exe)
Double-click:
```
WhatsApp-Sender.exe
```
*(or the shortcut **"WhatsApp Sender"** on your Desktop)*.

The app will:
1. Automatically clear port 3000 to prevent conflicts.
2. Launch the engine in the background.
3. Open your browser directly to `http://localhost:3000`.
4. Display a clean management window with your local & mobile Wi-Fi URLs.

---

### 2. Connect Your WhatsApp (Step 1)
You can choose either of two connection methods:

#### Method A: 8-Digit Pairing Code (No Camera Needed)
1. In Step 1, click **"Link with Phone Number"**.
2. Enter your phone number with country code (e.g., `919725537047`) and click **Get Code**.
3. On your phone: Open **WhatsApp** > **Linked Devices** > **Link a Device** > **"Link with phone number instead"**.
4. Type the 8-digit code displayed on screen.

#### Method B: QR Code Scan
1. In Step 1, click **"Scan QR Code"**.
2. Open **WhatsApp** on your phone > **Linked Devices** > **Link a Device**.
3. Point your camera at the QR code on the screen.

---

### 3. Open on Your Android / iPhone (Phone App)
1. Connect your phone to the same Wi-Fi as your computer.
2. Click the **📱 Phone Access** button in the top right header of the dashboard.
3. Scan the QR code with your phone camera (or type the shown Wi-Fi URL, e.g. `http://172.xx.xx.xx:3000`).
4. **Install as App on Android**: In Chrome on your phone, tap **⋮ (Menu)** > tap **"Add to Home screen"** (or "Install app"). It will place an icon on your phone's home screen and open full-screen!

---

### 4. Import Contacts & Compose (Steps 2, 3, 4)
- **Step 2**: Import Google Contacts CSV, vCard, Excel, or paste numbers. Notice the **Account Badge** showing which WhatsApp account these contacts belong to.
- **Step 3**: Type your message with tags (`{name}`, `{firstName}`, `{phone}`) and drag & drop images or videos.
- **Step 4**: Run an Instant Test Send or click **Start WhatsApp Campaign**.
