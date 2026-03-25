# FortifyXRB — X Region Blocker

> **Filter posts on X by region. Instantly. Silently. At the API level.**

FortifyXRB is a privacy-first browser extension for Brave and Chrome that lets you block posts, comments, and profiles from specific geographic regions on X (formerly Twitter). No extra tabs. No scraping. No noise.

---

## ✨ Features

- 🔴 **Overlay Mode** — covers blocked posts with a bold no-symbol overlay showing the blocked region
- 🌫️ **Blur Mode** — softly blurs blocked content out of view
- 🙈 **Hide Mode** — removes blocked posts from your feed entirely
- 🌍 **Region Blocking** — block by country, region, or any location string (e.g. "India", "South Asia", "West Asia")
- ⚡ **API-Level Detection** — passively intercepts X's own GraphQL responses to get location data for free, with zero extra tabs
- 🧠 **Smart Caching** — location data is cached locally for 30 days so repeat visits are instant
- 🔁 **Real-Time** — works on your Home feed, profile pages, search results, notifications, and more
- 🔒 **Privacy First** — no data is ever sent anywhere. Everything runs locally in your browser.
- 🛡️ **Profile Blocking** — visiting a blocked user's profile shows a no-symbol overlay on their avatar and a region warning banner

---

## 🚀 Installation

### Brave / Chrome (Manual Load)

1. Download the latest `FortifyXRB-v1.0.zip` from the [Releases](#) page
2. Unzip the file — you should see a single `FortifyXRB-v1.0` folder
3. Open your browser and navigate to:
   - **Brave:** `brave://extensions/`
   - **Chrome:** `chrome://extensions/`
4. Enable **Developer Mode** using the toggle in the top-right corner
5. Click **Load unpacked**
6. Select the `FortifyXRB-v1.0` folder
7. FortifyXRB will appear in your extensions bar — pin it for easy access

> **Note:** After loading, refresh any open X tabs for the extension to activate.

---

## 🛠️ How to Use

### Adding a Region

1. Click the **FortifyXRB** icon in your browser toolbar
2. Type a region name in the input field (e.g. `India`, `Nigeria`, `South Asia`)
3. Press **Enter** or click **Add**
4. The region tag will appear and blocking begins immediately

### Quick Presets

Click any preset button to instantly add a commonly blocked region:

`🇮🇳 India` · `🌏 South Asia` · `🌍 West Asia` · `🇳🇬 Nigeria` · `🌍 Africa` · `🇮🇱 Israel` · `🇷🇺 Russia` · `🇨🇳 China` · `🇮🇷 Iran` · `🇰🇵 N. Korea` · `🇧🇾 Belarus` · `🇸🇾 Syria`

### Block Modes

| Mode | What it does |
|------|-------------|
| 🔴 **Overlay** | Covers the post with a dark overlay, no-symbol icon, and region label |
| 🌫️ **Blur** | Blurs and fades the post so it's unreadable |
| 🙈 **Hide** | Removes the post from the DOM entirely |

### Removing a Region

Click the **×** on any region tag to remove it. Blocking clears immediately across all open X tabs.

### Clear All

Click **Clear all** at the bottom of the popup to remove all blocked regions at once.

---

## 🔍 How It Works

FortifyXRB uses two detection methods simultaneously:

**1. Passive API Interception (Free Data)**
The extension's injector runs in X's own JavaScript context and silently monitors the GraphQL API responses that X's app makes naturally as you browse. When X fetches user data, FortifyXRB reads the location fields from those responses at zero extra cost.

**2. Active GraphQL Lookup**
For users not yet seen in passive data, FortifyXRB makes a background request to X's `AboutAccountQuery` API endpoint — the same one X uses for its own "About" popups — to retrieve the account's registered country. Results are cached locally for 30 days.

---

## 🔐 Permissions

| Permission | Why it's needed |
|------------|----------------|
| `storage` | Save your blocked regions and location cache locally |
| `tabs` | Detect when you navigate to X so scripts can be injected |
| `scripting` | Inject the content scripts into X tabs |
| `host_permissions` (x.com, twitter.com, api.x.com) | Allow the extension to operate on X pages and make API requests |

> FortifyXRB does **not** request `cookies`, `history`, `bookmarks`, or any sensitive permissions. It never phones home.

---

## 📁 File Structure

```
FortifyXRB-v1.0/
├── manifest.json       # Extension manifest (MV3)
├── background.js       # Service worker — injects scripts into X tabs
├── injector.js         # MAIN world script — intercepts X's API responses
├── content.js          # ISOLATED world script — DOM scanning and blocking logic
├── content.css         # Styles for overlays, banners, and animations
├── popup.html          # Extension popup UI
├── popup.js            # Popup logic
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

---

## 🤝 Contributing

FortifyXRB is open source. Pull requests are welcome! If you find a bug or have a feature request, please open an issue.

---

## 📄 License

MIT License — free to use, modify, and distribute.

---
