# ☁️ How to Run WhatsApp Sender 24/7 on Free Cloud (No Laptop Needed!)

By hosting the backend on **Render.com** (100% Free), your WhatsApp Sender will run 24/7 on the internet.
* **Your laptop can be turned OFF completely**.
* **Your mobile APK will work anywhere on 4G/5G mobile data and any Wi-Fi**.
* **No ports to open, no Wi-Fi IP hassles**.

---

## ⚡ 3-Minute Free Deployment Steps

### Step 1: Push Project to GitHub (Free)
1. Open your browser and go to **[github.com](https://github.com)** (sign in or create a free account).
2. Click **New Repository** (name it e.g. `whatsapp-sender`, set it to **Private** or Public).
3. Push this project folder to your GitHub repo.

---

### Step 2: Deploy on Render.com (100% Free)
1. Go to **[render.com](https://render.com)** and click **Sign Up** (choose "Sign in with GitHub").
2. On your Render dashboard, click the **New +** button in the top right > select **Web Service**.
3. Select your `whatsapp-sender` repository.
4. Render will automatically detect settings:
   - **Name**: `whatsapp-sender`
   - **Language**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Plan**: Select **Free ($0/month)**
5. Click **Deploy Web Service** at the bottom!
6. In about 2 minutes, Render will show **Live** and give you your permanent secure URL:
   👉 `https://whatsapp-sender-xxxx.onrender.com`

---

### Step 3: Connect Your Mobile APK
1. Open **WhatsApp Sender** (`WhatsApp-Sender.apk`) on your Android phone (on 4G/5G mobile data or any Wi-Fi).
2. Tap the **⚙ Settings** button in the top-right corner.
3. Paste your Render URL:
   `https://whatsapp-sender-xxxx.onrender.com`
4. Tap **Connect**!
5. **Done!** You are now running 100% independently from the cloud.
   - You can turn your laptop off.
   - You can send campaigns, manage contacts, and dispatch videos directly from your phone on mobile net anytime.
