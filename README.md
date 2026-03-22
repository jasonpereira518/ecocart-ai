# 🌿 EcoCart AI

**AI-powered grocery sustainability — from receipt to 3D store navigation.**

EcoCart AI is a web platform that analyzes grocery receipt purchases, estimates product-level carbon footprints, recommends lower-emission brand swaps, and guides shoppers through a 3D supermarket to make greener choices. Built for **HackDuke 2026**.

---

## ✨ Features

### 📸 Receipt Scanning & Carbon Estimation
Upload a grocery receipt photo → Gemini Vision AI extracts every item with brand, quantity, and price → each product gets a carbon footprint estimate (kg CO₂e) using a two-layer validation system combining AI estimation with published lifecycle assessment data.

### 🔄 Smart Swap Recommendations
Brand-for-brand alternatives for your highest-impact items. Not "replace beef with tofu" — real swaps like Tyson → Perdue Harvestland Organic. Every recommendation includes CO₂ savings and a specific reason.

### 🛒 3D Supermarket Navigation
A Three.js-powered 3D model of a real grocery store built from an actual floorplan. Select items from your receipt and generate an optimized walking route with zero backtracking using a zone-based sweep algorithm.

### 💬 AI Sustainability Coach
Persistent Gemini-powered chat sidebar with full context of your purchase history. Ask anything about your carbon footprint, get personalized tips, or compare products.

### 🏆 Gamification & Leaderboard
Points, streaks, badges (Seedling → Guardian), and a global leaderboard that turns carbon reduction into a community challenge.

---

## 🛠 Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Python 3.12, Flask 3, Flask-SQLAlchemy |
| Database | SQLite |
| Auth | Auth0 (OpenID Connect via Authlib) |
| AI | Google Gemini 2.5 Flash (Vision + Chat) |
| 3D | Three.js with OrbitControls (ES modules via importmap) |
| Frontend | Jinja2, Vanilla JS, CSS, Lucide Icons, Outfit font |
| Deploy | Docker, Gunicorn |

---

## 🚀 Getting Started

### Prerequisites

- Python 3.12+
- [Auth0 account](https://auth0.com) (free tier works)
- [Google Gemini API key](https://makersuite.google.com/app/apikey)
- Docker (optional, for containerized deployment)

### 1. Clone the repo

```bash
git clone https://github.com/your-team/ecocart-ai.git
cd ecocart-ai
```

### 2. Set up environment variables

Copy the example env file and fill in your credentials:

```bash
cp .env.example .env
```

```env
FLASK_SECRET=your-random-secret-key
DATABASE_URL=sqlite:///ecocart.db
AUTH0_CLIENT_ID=your-auth0-client-id
AUTH0_CLIENT_SECRET=your-auth0-client-secret
AUTH0_DOMAIN=your-tenant.auth0.com
AUTH0_REDIRECT_URI=http://localhost:1970/callback
GEMINI_API_KEY=your-gemini-api-key
```

### 3. Auth0 Setup

In your Auth0 dashboard:
- Create a **Regular Web Application**
- Set **Allowed Callback URLs** to `http://localhost:1970/callback`
- Set **Allowed Logout URLs** to `http://localhost:1970`
- Copy the Client ID, Client Secret, and Domain into your `.env`

### 4a. Run with Flask (development)

```bash
pip install -r requirements.txt
python app.py
```

App runs at **http://localhost:1970**

### 4b. Run with Docker

```bash
docker-compose up --build
```

App runs at **http://localhost:1970**

---

## 📁 Project Structure

```
ecocart-ai/
├── app.py                  # Flask app — routes, APIs, Gemini integration
├── models.py               # SQLAlchemy models (User, Activity, Swap, ChatMessage)
├── requirements.txt        # Python dependencies
├── Dockerfile              # Docker image (python:3.12-slim + Gunicorn)
├── docker-compose.yml      # One-command deployment
├── debug_app.py            # Dev-only Auth0 bypass (DO NOT deploy)
├── .env.example            # Environment variable template
├── templates/
│   ├── index.html          # Main authenticated UI (dashboard, upload, history, 3D, leaderboard)
│   └── login.html          # Pre-auth landing page
├── static/
│   ├── app.js              # View switching, upload, chat, dashboard logic
│   ├── supermarket3d.js    # Three.js 3D supermarket (ES module)
│   └── style.css           # Global styles (Outfit font, forest green theme)
└── uploads/                # Uploaded receipt images (gitignored)
```

---

## 🔌 API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/` | Dashboard (redirects to login if unauthenticated) |
| `GET` | `/login` | Auth0 login redirect |
| `GET` | `/callback` | Auth0 OAuth callback |
| `GET` | `/logout` | Clear session + Auth0 logout |
| `GET` | `/api/stats` | User stats (CO₂ tracked, saved, points) |
| `GET` | `/api/history` | Receipt history grouped by receipt_id |
| `GET` | `/api/history/<receipt_id>` | Single receipt detail with items + swaps |
| `POST` | `/api/upload` | Upload receipt image → Gemini parse → save items |
| `POST` | `/api/generate-swaps` | Generate brand-level swap recommendations |
| `POST` | `/api/accept-swap` | Accept a swap → earn points + CO₂ savings |
| `POST` | `/api/chat` | Send message to AI coach → Gemini response |
| `GET` | `/api/chat-history` | Last 20 chat messages |
| `GET` | `/api/leaderboard` | Top 20 users ranked by points |
| `GET` | `/api/user/badges` | User's badge progress |
| `GET` | `/api/supermarket/layout` | 3D store layout JSON (zones, aisles, products) |
| `POST` | `/api/supermarket/route` | Optimized walking route for selected products |

---

## 🧠 How the Carbon Estimation Works

```
Receipt Image
     │
     ▼
┌─────────────┐     ┌──────────────────┐
│ Gemini 2.5  │────▶│ Extracted Items   │
│ Vision API  │     │ + AI CO₂ estimate │
└─────────────┘     └────────┬─────────┘
                             │
                             ▼
                   ┌──────────────────┐
                   │ Validation Layer │
                   │ ~100 food LCA    │
                   │ emission factors │
                   └────────┬─────────┘
                            │
                   If AI estimate > 5× lookup
                   → use lookup value
                            │
                            ▼
                   ┌──────────────────┐
                   │ Brand Assignment │
                   │ 200+ keyword     │
                   │ fallback map     │
                   └────────┬─────────┘
                            │
                            ▼
                    Final item record
                    with brand + CO₂e
```

**Formula:**

$$\text{CO}_2\text{e} = \text{emission factor (kg CO₂e per kg)} \times \text{quantity} \times \text{unit conversion}$$

---

## 🗺 3D Supermarket

The 3D store is built from a **real grocery store floorplan** digitized into zone coordinates:

- **Perimeter departments**: Produce, Butchers, Fishermans Market, Dairy, Bakery, Deli, Frozen, Health & Beauty
- **6 center aisles**: Canned Goods, Cereals, Baking, Pasta & Grains, Snacks, Beverages
- **Checkout, Floral, Customer Service, Entrance**

The routing algorithm uses a **zone-based sweep** (not nearest-neighbor) to visit departments in a counter-clockwise loop with zero backtracking. Paths follow walkable corridors and never cut through shelves.

---

## 🏅 Gamification

| Level | Points | Emoji |
|-------|--------|-------|
| Seedling | 0–100 | 🌱 |
| Sprout | 101–500 | 🌿 |
| Sapling | 501–1000 | 🌳 |
| Evergreen | 1001–2500 | 🌲 |
| Guardian | 2501+ | 🌳 |

**Earn points by:** scanning receipts (+50), each parsed item (+5), accepting swaps (+25), daily streaks (+10 × streak days, max +100), CO₂ milestones (+100 per 10kg saved).

**7 badges:** First Scan, Carbon Tracker, Swap Star, Streak Master, Eco Warrior, Century Saver, Upload Legend.

---

## 👥 Team

Built at **HackDuke 2026** by:
- *[Team member names here]*

---

## 📄 License

This project was built for HackDuke 2026. See [LICENSE](LICENSE) for details.

## Run locally

The app listens on port **1970**.

- **Docker:** `docker compose up --build`, then open [http://localhost:1970](http://localhost:1970).
- **Flask:** `python app.py` — same URL. In the Auth0 application settings, allow callback **http://localhost:1970/callback** (and set `AUTH0_REDIRECT_URI` in `.env` to match).
