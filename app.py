from flask import Flask, redirect, url_for, session, render_template, request, jsonify
from authlib.integrations.flask_client import OAuth
from dotenv import load_dotenv, find_dotenv
import os
import json
import math
from models import db, User, Activity, seed_mock_data, Swap, ChatMessage
from urllib.parse import urlencode, quote_plus
from werkzeug.utils import secure_filename
from datetime import datetime, timedelta
import google.generativeai as genai
from PIL import Image
import uuid
import random
import hashlib
from collections import defaultdict
from sqlalchemy import text
from supermarket_layout import (
    compute_route,
    get_layout_dict,
    match_activity_to_layout_product,
)

# Load environment variables
load_dotenv(find_dotenv())

app = Flask(__name__)
app.secret_key = os.getenv("FLASK_SECRET", "super-secret-key")


def _wants_json_response():
    if request.path.startswith("/api/"):
        return True
    accept = (request.headers.get("Accept") or "") + " " + (
        request.headers.get("Content-Type") or ""
    )
    return "application/json" in accept


@app.errorhandler(404)
def handle_not_found(e):
    if _wants_json_response():
        return jsonify({"error": "Not found"}), 404
    html = (
        "<!DOCTYPE html><html lang=en><head><meta charset=utf-8>"
        "<meta name=viewport content='width=device-width,initial-scale=1'>"
        "<title>Not found — EcoCart AI</title></head>"
        "<body style='font-family:system-ui,sans-serif;max-width:520px;margin:4rem auto;padding:0 1.5rem;color:#132a13'>"
        "<h1>Page not found</h1>"
        "<p>The page you requested does not exist.</p>"
        "<p><a href='/'>Return to EcoCart AI</a></p></body></html>"
    )
    return html, 404, {"Content-Type": "text/html; charset=utf-8"}


@app.errorhandler(500)
def handle_server_error(e):
    if request.path.startswith("/api/"):
        return jsonify({"error": "Internal server error"}), 500
    html = (
        "<!DOCTYPE html><html lang=en><head><meta charset=utf-8>"
        "<meta name=viewport content='width=device-width,initial-scale=1'>"
        "<title>Error — EcoCart AI</title></head>"
        "<body style='font-family:system-ui,sans-serif;max-width:520px;margin:4rem auto;padding:0 1.5rem;color:#132a13'>"
        "<h1>Something went wrong</h1>"
        "<p>Please try again in a moment.</p>"
        "<p><a href='/'>Return to EcoCart AI</a></p></body></html>"
    )
    return html, 500, {"Content-Type": "text/html; charset=utf-8"}

# Gemini Configuration
api_key = os.getenv("GEMINI_API_KEY")
if not api_key:
    print("WARNING: GEMINI_API_KEY not found in environment")
genai.configure(api_key=api_key)

model = None
try:
    # List models to see what's available
    print("Available Gemini Models:", flush=True)
    models = genai.list_models()
    for m in models:
        print(f"- {m.name} ({m.supported_generation_methods})", flush=True)

    # Use gemini-2.5-flash for broader compatibility
    model = genai.GenerativeModel('gemini-2.5-flash')
    print(f"Gemini model '{model.model_name}' initialized successfully", flush=True)
except Exception as e:
    print(f"Error initializing Gemini model: {e}", flush=True)

# Database configuration
app.config['SQLALCHEMY_DATABASE_URI'] = os.getenv("DATABASE_URL", "sqlite:///ecocart.db")
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
db.init_app(app)


def _sqlite_table_columns(connection, table_name):
    rows = connection.execute(text(f'PRAGMA table_info("{table_name}")')).fetchall()
    return {row[1] for row in rows}


def _sqlite_add_missing_columns(connection, table_name, col_defs):
    """col_defs: list of (name, sqlite_type_fragment) e.g. ('total_co2_saved', 'REAL DEFAULT 0')"""
    existing = _sqlite_table_columns(connection, table_name)
    for col_name, type_sql in col_defs:
        if col_name in existing:
            continue
        connection.execute(text(f'ALTER TABLE "{table_name}" ADD COLUMN {col_name} {type_sql}'))
        existing.add(col_name)


def ensure_sqlite_schema_matches_models():
    """
    create_all() does not add new columns to existing SQLite tables.
    Apply additive ALTERs so older ecocart.db files keep working.
    """
    uri = app.config.get("SQLALCHEMY_DATABASE_URI") or ""
    if not uri.startswith("sqlite:"):
        return
    with db.engine.begin() as conn:
        _sqlite_add_missing_columns(
            conn,
            "users",
            [
                ("total_co2_saved", "REAL DEFAULT 0"),
                ("streak_count", "INTEGER DEFAULT 0"),
                ("last_active_date", "DATE"),
                ("created_at", "DATETIME"),
            ],
        )
        _sqlite_add_missing_columns(
            conn,
            "activities",
            [
                ("brand", "VARCHAR(128)"),
                ("unit", "VARCHAR(32)"),
                ("price", "REAL"),
            ],
        )


# Initialize database. SQLite dev note: if you change columns on existing models, delete the
# local .db file (e.g. ecocart.db or instance DB) and restart so create_all() rebuilds schema.
# ensure_sqlite_schema_matches_models() adds missing columns in place when possible.
print(
    "NOTE: Delete the .db file and restart if leaderboard is empty — seed data needs a fresh database."
)
with app.app_context():
    db.create_all()
    ensure_sqlite_schema_matches_models()
    n_mock = User.query.filter(User.auth0_id.like("auth0|mock_%")).count()
    n_users = User.query.count()
    # Seed when there are no mock rows yet, or the DB is nearly empty (dev). seed_mock_data() is a no-op if mocks already exist.
    if n_mock == 0 or n_users < 5:
        seed_mock_data()

# Auth0 setup
oauth = OAuth(app)
auth0 = oauth.register(
    'auth0',
    client_id=os.getenv("AUTH0_CLIENT_ID"),
    client_secret=os.getenv("AUTH0_CLIENT_SECRET"),
    api_base_url=f'https://{os.getenv("AUTH0_DOMAIN")}',
    access_token_url=f'https://{os.getenv("AUTH0_DOMAIN")}/oauth/token',
    authorize_url=f'https://{os.getenv("AUTH0_DOMAIN")}/authorize',
    client_kwargs={
        'scope': 'openid profile email',
    },
    server_metadata_url=f'https://{os.getenv("AUTH0_DOMAIN")}/.well-known/openid-configuration'
)

_ALLOWED_CATEGORIES = (
    "Meat",
    "Dairy",
    "Produce",
    "Beverages",
    "Grains",
    "Snacks",
    "Frozen",
    "Household",
    "Other",
)


def _normalize_category(raw):
    if not raw:
        return "Other"
    s = str(raw).strip()
    for c in _ALLOWED_CATEGORIES:
        if s.lower() == c.lower():
            return c
    return "Other"


def _mass_kg(quantity, unit):
    q = float(quantity if quantity is not None else 1)
    u = (unit or "each").lower().strip()
    if u in ("lb", "lbs", "pound", "pounds", "#"):
        return q / 2.205
    if u in ("oz", "ounce", "ounces"):
        return q / 35.274
    if u in ("kg", "kilogram", "kilograms", "kgs"):
        return q
    if u in ("g", "gram", "grams"):
        return q / 1000.0
    return None


def _volume_liters(quantity, unit):
    q = float(quantity if quantity is not None else 1)
    u = (unit or "").lower().strip()
    if u in ("gallon", "gallons", "gal"):
        return q * 3.785
    if u in ("l", "liter", "litre", "liters", "litres"):
        return q
    if u in ("ml", "milliliter", "milliliters", "millilitre", "millilitres"):
        return q / 1000.0
    return None


def estimate_co2(item_name, category, quantity, unit):
    """
    Fallback kg CO2e from item text, category, quantity, and unit (LCA-style factors).
    """
    name = f" {(item_name or '').lower()} "
    cat = f" {(category or '').lower()} "
    qty = float(quantity if quantity is not None else 1)
    mass = _mass_kg(qty, unit)
    vol = _volume_liters(qty, unit)

    def per_kg(rate, default_kg_per_unit=0.35):
        if mass is not None:
            return rate * mass
        return rate * default_kg_per_unit * qty

    def per_l(rate, default_l_per_unit=1.0):
        if vol is not None:
            return rate * vol
        return rate * default_l_per_unit * qty

    if "oat milk" in name or "oatly" in name or "oat beverage" in name:
        return per_l(0.9)
    if "almond milk" in name or "soy milk" in name or "coconut milk" in name:
        return per_l(0.9)
    if "tofu" in name:
        return per_kg(2.0, 0.4)
    if any(k in name for k in ("beef", "steak", "burger", "ground beef", "ribeye", "brisket")):
        return per_kg(27, 0.35)
    if "pork" in name or "bacon" in name or "ham" in name or ("sausage" in name and "beyond" not in name):
        return per_kg(12.1, 0.25)
    if "chicken" in name or "poultry" in name or "turkey" in name:
        return per_kg(6.9, 0.4)
    if any(
        k in name
        for k in ("salmon", "tuna", "fish", "shrimp", "seafood", "cod", "tilapia", "halibut")
    ):
        return per_kg(6.0, 0.3)
    if any(k in name for k in ("cheese", "cheddar", "mozzarella", "brie", "parmesan")):
        return per_kg(13.5, 0.2)
    if "egg" in name:
        return 4.8 * 0.05 * qty
    if (
        "milk" in name
        and "oat" not in name
        and "almond" not in name
        and "coconut" not in name
        and "soy" not in name
    ):
        return per_l(3.2)
    if "rice" in name:
        return per_kg(2.7, 0.45)
    if any(k in name for k in ("bread", "bagel", "tortilla", "bun", "roll")):
        return per_kg(0.8, 0.5)
    if "produce" in cat:
        if any(
            k in name
            for k in (
                "apple",
                "banana",
                "orange",
                "berry",
                "grape",
                "fruit",
                "melon",
                "avocado",
                "pear",
                "peach",
            )
        ):
            return per_kg(0.7, 0.25)
        return per_kg(0.5, 0.3)
    if any(
        k in name
        for k in (
            "lettuce",
            "spinach",
            "carrot",
            "broccoli",
            "tomato",
            "onion",
            "pepper",
            "cucumber",
            "kale",
            "celery",
            "potato",
        )
    ):
        return per_kg(0.5, 0.3)
    if any(
        k in name
        for k in ("apple", "banana", "orange", "berry", "grape", "fruit", "melon", "avocado")
    ):
        return per_kg(0.7, 0.25)
    if any(k in name for k in ("chip", "cracker", "cookie", "cereal", "granola")) or " bar " in name:
        return per_kg(2.5, 0.2)
    if "snack" in cat:
        return 2.5 * qty
    return 1.5 * qty


def _coalesce_kg_co2e(gemini_val, item_name, category, quantity, unit):
    helper = estimate_co2(item_name, category, quantity, unit)
    try:
        g = float(gemini_val)
    except (TypeError, ValueError):
        g = 0.0
    if not math.isfinite(g) or g <= 0:
        return max(helper, 0.01)
    if helper <= 0:
        return max(g, 0.01)
    lo, hi = (g, helper) if g < helper else (helper, g)
    if lo > 0 and hi / lo > 5:
        return max(helper, 0.01)
    return g


def _parse_receipt_json(text):
    """Accept new {store_name, items} or legacy list of items."""
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return None, []
    if isinstance(data, list):
        return None, data
    if isinstance(data, dict) and "items" in data:
        store = data.get("store_name")
        items = data.get("items") or []
        if not isinstance(items, list):
            items = []
        return store, items
    return None, []


def _normalize_parsed_item(raw):
    if not isinstance(raw, dict):
        return None
    qty = raw.get("quantity", 1)
    try:
        qty = float(qty)
    except (TypeError, ValueError):
        qty = 1.0
    price = raw.get("price")
    try:
        price = float(price) if price is not None else None
    except (TypeError, ValueError):
        price = None
    return {
        "item_name": (raw.get("item_name") or "Unknown Item").strip() or "Unknown Item",
        "brand": raw.get("brand"),
        "category": _normalize_category(raw.get("category")),
        "quantity": qty,
        "unit": (raw.get("unit") or "each") or "each",
        "price": price,
        "kg_co2e": raw.get("kg_co2e", 0),
    }


def _find_activity_for_swap(activities, original_product):
    op = (original_product or "").strip().lower()
    if not op:
        return None
    for a in activities:
        if a.item_name and a.item_name.strip().lower() == op:
            return a
    for a in activities:
        iname = (a.item_name or "").strip().lower()
        if iname and (op in iname or iname in op):
            return a
    return None


def _weekly_trend(user_id):
    """Last four 7-day buckets (oldest first), UTC, for charting."""
    today = datetime.utcnow().date()
    weeks = []
    for offset in range(3, -1, -1):
        end_d = today - timedelta(days=offset * 7)
        start_d = end_d - timedelta(days=6)
        start_dt = datetime.combine(start_d, datetime.min.time())
        end_dt = datetime.combine(end_d, datetime.max.time())
        total = (
            db.session.query(db.func.coalesce(db.func.sum(Activity.kg_co2e), 0.0))
            .filter(
                Activity.user_id == user_id,
                Activity.timestamp >= start_dt,
                Activity.timestamp <= end_dt,
            )
            .scalar()
        )
        total = float(total or 0)
        if start_d.month == end_d.month:
            label = f"{start_d.strftime('%b')} {start_d.day}–{end_d.day}"
        else:
            label = f"{start_d.strftime('%b %d')}–{end_d.strftime('%b %d')}"
        weeks.append({"week_label": label, "total_co2": round(total, 2)})
    return weeks


def build_dashboard_stats(user):
    """Aggregates for dashboard view and /api/stats."""
    uid = user.id
    total_co2 = float(
        db.session.query(db.func.coalesce(db.func.sum(Activity.kg_co2e), 0.0))
        .filter_by(user_id=uid)
        .scalar()
        or 0.0
    )

    receipts_count = (
        db.session.query(db.func.count(db.func.distinct(Activity.receipt_id)))
        .filter(
            Activity.user_id == uid,
            Activity.receipt_id.isnot(None),
            Activity.receipt_id != "",
        )
        .scalar()
        or 0
    )

    cutoff = datetime.utcnow() - timedelta(days=7)
    items_this_week = Activity.query.filter(
        Activity.user_id == uid,
        Activity.timestamp >= cutoff,
    ).count()

    cat_rows = (
        db.session.query(Activity.category, db.func.sum(Activity.kg_co2e))
        .filter_by(user_id=uid)
        .group_by(Activity.category)
        .all()
    )
    trends = {
        (c if c is not None else "Other"): float(v) for c, v in cat_rows
    }

    weekly_trend = _weekly_trend(uid)
    weekly_chart_max = max((w["total_co2"] for w in weekly_trend), default=0.01)
    if weekly_chart_max <= 0:
        weekly_chart_max = 0.01

    top_rows = (
        Activity.query.filter_by(user_id=uid)
        .order_by(Activity.kg_co2e.desc())
        .limit(3)
        .all()
    )
    top_offenders = [
        {
            "item_name": a.item_name,
            "brand": (a.brand or "").strip() or "Store Brand",
            "category": a.category or "Other",
            "kg_co2e": round(float(a.kg_co2e or 0), 2),
            "receipt_id": a.receipt_id or "",
        }
        for a in top_rows
    ]

    swap_rows = (
        Swap.query.join(Activity, Swap.activity_id == Activity.id)
        .filter(Activity.user_id == uid)
        .order_by(Swap.created_at.desc())
        .limit(24)
        .all()
    )
    user_swaps = [
        {
            "id": s.id,
            "original_product": s.original_product,
            "recommended_product": s.recommended_product,
            "recommended_brand": s.recommended_brand,
            "co2_savings": round(float(s.co2_savings or 0), 2),
            "reason": s.reason,
            "aisle_location": s.aisle_location,
            "receipt_id": s.activity.receipt_id if s.activity else None,
            "accepted": bool(s.accepted),
        }
        for s in swap_rows
    ]

    recent_activities = (
        Activity.query.filter_by(user_id=uid)
        .order_by(Activity.timestamp.desc())
        .limit(5)
        .all()
    )
    recent_list = [
        {
            "item_name": a.item_name,
            "brand": (a.brand or "").strip() or "Store Brand",
            "category": a.category or "General",
            "kg_co2e": float(a.kg_co2e or 0),
        }
        for a in recent_activities
    ]

    return {
        "total_co2": round(float(total_co2), 2),
        "total_co2_saved": round(float(user.total_co2_saved or 0), 2),
        "receipts_count": int(receipts_count),
        "items_this_week": int(items_this_week),
        "weekly_trend": weekly_trend,
        "weekly_chart_max": weekly_chart_max,
        "top_offenders": top_offenders,
        "user_swaps": user_swaps,
        "trends": trends,
        "recent_activities": recent_list,
        "points": int(user.points or 0),
        "streak_count": int(user.streak_count or 0),
    }


def level_name_from_points(points):
    p = int(points or 0)
    if p >= 1900:
        return "Guardian"
    if p <= 100:
        return "Seedling"
    if p <= 500:
        return "Sprout"
    if p <= 1000:
        return "Sapling"
    return "Evergreen"


_LEVEL_EMOJI = {
    "Seedling": "🌱",
    "Sprout": "🌿",
    "Sapling": "🪴",
    "Evergreen": "🌲",
    "Guardian": "🌳",
}


def count_badges_earned_for_user(user):
    """Count earned badges using the same rules as GET /api/user/badges."""
    uid = user.id
    has_receipt_activity = (
        Activity.query.filter(
            Activity.user_id == uid,
            Activity.receipt_id.isnot(None),
            Activity.receipt_id != "",
        ).first()
        is not None
    )
    n_receipts = (
        db.session.query(db.func.count(db.func.distinct(Activity.receipt_id)))
        .filter(
            Activity.user_id == uid,
            Activity.receipt_id.isnot(None),
            Activity.receipt_id != "",
        )
        .scalar()
        or 0
    )
    n_accepted = (
        Swap.query.join(Activity, Swap.activity_id == Activity.id)
        .filter(Activity.user_id == uid, Swap.accepted == True)  # noqa: E712
        .count()
    )
    streak = int(user.streak_count or 0)
    saved = float(user.total_co2_saved or 0)
    n = 0
    if has_receipt_activity:
        n += 1
    if n_receipts >= 10:
        n += 1
    if n_accepted >= 5:
        n += 1
    if streak >= 7:
        n += 1
    if saved >= 50:
        n += 1
    if saved >= 100:
        n += 1
    if n_receipts >= 25:
        n += 1
    return n


def level_display_with_emoji(points):
    n = level_name_from_points(points)
    return f"{n} {_LEVEL_EMOJI.get(n, '')}".strip()


def co2_saved_milestone_crossings(old_saved, new_saved):
    o = float(old_saved or 0)
    n = float(new_saved or 0)
    if n <= o:
        return 0
    return max(0, int(n // 10) - int(o // 10))


def award_points(user, action, metadata=None):
    """
    Apply point deltas for gamification. Mutates user.points. Does not commit.
    Returns (points_awarded_this_action, new_points_total).
    """
    md = metadata or {}
    amount = 0
    if action == "receipt_upload":
        amount = 50
    elif action == "receipt_items":
        amount = 5 * max(0, int(md.get("count", 0)))
    elif action == "accept_swap":
        amount = 25
    elif action == "daily_streak":
        streak_n = max(0, int(md.get("streak_count", user.streak_count or 0)))
        amount = min(10 * streak_n, 100)
    elif action == "co2_milestone":
        amount = 100 * max(0, int(md.get("crossings", 0)))
    cur = int(user.points or 0)
    user.points = cur + amount
    return amount, user.points


def _clean_display_name(raw: str | None) -> str | None:
    if not raw or not str(raw).strip():
        return None
    s = str(raw).strip()
    if "@" in s:
        return None
    return s


def resolve_display_name(user: User, userinfo: dict | None = None) -> str:
    """Human-readable name for UI; never use email as display name."""
    if user:
        n = _clean_display_name(user.name)
        if n:
            return n
    if userinfo:
        for key in ("name", "given_name", "nickname"):
            v = userinfo.get(key)
            cn = _clean_display_name(str(v) if v is not None else None)
            if cn:
                return cn
    return "Jason"


def leaderboard_display_name(u: User) -> str:
    n = _clean_display_name(u.name)
    return n if n else "Jason"


def apply_daily_streak_on_page_visit(user):
    """
    Run on GET / for logged-in users. Updates streak_count / last_active_date (UTC) and awards streak points when the calendar day advances.
    """
    today = datetime.utcnow().date()
    yesterday = today - timedelta(days=1)
    lad = user.last_active_date

    if lad is None:
        user.streak_count = 1
        user.last_active_date = today
        award_points(user, "daily_streak", {"streak_count": 1})
    elif lad == today:
        return
    elif lad == yesterday:
        user.streak_count = int(user.streak_count or 0) + 1
        user.last_active_date = today
        award_points(user, "daily_streak", {"streak_count": user.streak_count})
    else:
        user.streak_count = 1
        user.last_active_date = today
        award_points(user, "daily_streak", {"streak_count": 1})


def user_snapshot_for_api(user, userinfo=None):
    dash = build_dashboard_stats(user)
    return {
        "points": dash["points"],
        "streak_count": dash["streak_count"],
        "total_co2_saved": dash["total_co2_saved"],
        "total_co2": dash["total_co2"],
        "receipts_count": dash["receipts_count"],
        "level_name": level_name_from_points(dash["points"]),
        "name": resolve_display_name(user, userinfo),
    }


# Routes
@app.route('/')
def index():
    user_info = session.get('user')
    if user_info:
        # Check if user exists in local DB, if not create them
        user = User.query.filter_by(auth0_id=user_info['sub']).first()
        auth_raw = (
            user_info.get("name")
            or user_info.get("given_name")
            or user_info.get("nickname")
        )
        auth_name = _clean_display_name(str(auth_raw) if auth_raw is not None else None) or "Jason"
        if not user:
            user = User(
                auth0_id=user_info["sub"],
                name=auth_name,
                email=user_info.get("email"),
            )
            db.session.add(user)
            db.session.commit()
        elif not _clean_display_name(user.name):
            user.name = auth_name
            db.session.commit()

        apply_daily_streak_on_page_visit(user)
        db.session.commit()
        db.session.refresh(user)

        dash = build_dashboard_stats(user)
        total_co2 = dash["total_co2"]
        trends = dash["trends"]
        recent_activities = (
            Activity.query.filter_by(user_id=user.id)
            .order_by(Activity.timestamp.desc())
            .limit(5)
            .all()
        )
        
        # AI Insights (Dynamic-ish)
        insights = []
        if total_co2 > 0:
            if 'Shopping' in trends and trends['Shopping'] > total_co2 * 0.3:
                insights.append({
                    "title": "Shopping Impact",
                    "text": "Your shopping trips account for a large portion of your footprint. Consider buying local or reduced-packaging items.",
                    "saving": "Saves ~1.2kg/week",
                    "difficulty": "EASY"
                })
            if 'Meat' in trends:
                 insights.append({
                    "title": "Meat Consumption",
                    "text": "Reducing red meat once more per week could lower your food footprint by 15%.",
                    "saving": "Saves ~2.1kg/week",
                    "difficulty": "MEDIUM"
                })
            
            if not insights:
                insights.append({
                    "title": "Keep it up!",
                    "text": "You're doing great! Try logging more activities to get personalized insights.",
                    "saving": "Dynamic insight",
                    "difficulty": "EASY"
                })
        else:
            insights.append({
                "title": "Welcome to EcoCart AI!",
                "text": "Start by uploading a receipt or logging an activity to see your impact.",
                "saving": "Get started",
                "difficulty": "EASY"
            })

        return render_template(
            "index.html",
            user=user_info,
            local_user=user,
            display_name=resolve_display_name(user, user_info),
            sidebar_level_display=level_display_with_emoji(user.points),
            total_co2=total_co2,
            total_co2_saved=dash["total_co2_saved"],
            receipts_count=dash["receipts_count"],
            items_this_week=dash["items_this_week"],
            weekly_trend=dash["weekly_trend"],
            weekly_chart_max=dash["weekly_chart_max"],
            top_offenders=dash["top_offenders"],
            user_swaps=dash["user_swaps"],
            dashboard_stats=dash,
            recent_activities=recent_activities,
            trends=trends,
            insights=insights,
        )
    
    return render_template('login.html')

@app.route('/login')
def login():
    redirect_uri = os.getenv("AUTH0_REDIRECT_URI") or url_for("callback", _external=True)
    return auth0.authorize_redirect(redirect_uri=redirect_uri)

@app.route('/callback')
def callback():
    token = auth0.authorize_access_token()
    session['user'] = token['userinfo']
    return redirect(url_for('index'))

@app.route('/logout')
def logout():
    session.clear()
    return redirect(
        f'https://{os.getenv("AUTH0_DOMAIN")}/v2/logout?'
        + urlencode(
            {
                "returnTo": url_for("index", _external=True),
                "client_id": os.getenv("AUTH0_CLIENT_ID"),
            },
            quote_via=quote_plus,
        )
    )



UPLOAD_FOLDER = 'uploads'
ALLOWED_EXTENSIONS = {'png', 'jpg', 'jpeg', 'gif'}

app.config['UPLOAD_FOLDER'] = UPLOAD_FOLDER
if not os.path.exists(UPLOAD_FOLDER):
    os.makedirs(UPLOAD_FOLDER)

def allowed_file(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS

# API endpoints for frontend interaction
@app.route('/api/stats')
def get_stats():
    user_info = session.get('user')
    if not user_info:
        return jsonify({"error": "Unauthorized"}), 401

    user = User.query.filter_by(auth0_id=user_info['sub']).one()
    dash = build_dashboard_stats(user)
    dash["name"] = resolve_display_name(user, user_info)
    return jsonify(dash)

@app.route("/api/accept-swap", methods=["POST"])
def accept_swap():
    user_info = session.get("user")
    if not user_info:
        return jsonify({"error": "Unauthorized"}), 401
    body = request.get_json(silent=True) or {}
    raw_id = body.get("swap_id")
    try:
        swap_id = int(raw_id)
    except (TypeError, ValueError):
        return jsonify({"error": "swap_id required"}), 400

    user = User.query.filter_by(auth0_id=user_info["sub"]).one()
    swap = Swap.query.filter_by(id=swap_id).first()
    if not swap:
        return jsonify({"error": "Swap not found"}), 404
    act = swap.activity
    if not act or act.user_id != user.id:
        return jsonify({"error": "Forbidden"}), 403
    if swap.accepted:
        return jsonify({"error": "Already accepted"}), 400

    old_saved = float(user.total_co2_saved or 0)
    swap.accepted = True
    new_saved = old_saved + float(swap.co2_savings or 0)
    user.total_co2_saved = new_saved
    pa_swap, _ = award_points(user, "accept_swap")
    cross = co2_saved_milestone_crossings(old_saved, new_saved)
    pa_mile, _ = award_points(user, "co2_milestone", {"crossings": cross})
    db.session.commit()

    snap = user_snapshot_for_api(user, user_info)
    snap["points_awarded"] = pa_swap + pa_mile
    return jsonify(snap)


@app.route("/api/leaderboard")
def api_leaderboard():
    user_info = session.get("user")
    if not user_info:
        return jsonify({"error": "Unauthorized"}), 401
    me = User.query.filter_by(auth0_id=user_info["sub"]).one()
    all_users = User.query.order_by(User.points.desc(), User.id.asc()).all()
    n_total = max(len(all_users), 1)

    ranked = []
    rank = 1
    for i, u in enumerate(all_users):
        if i > 0 and u.points < all_users[i - 1].points:
            rank = i + 1
        ranked.append((rank, u))

    leaderboard = []
    for r, u in ranked[:20]:
        lvl = level_name_from_points(u.points)
        leaderboard.append(
            {
                "rank": r,
                "user_id": u.id,
                "name": leaderboard_display_name(u),
                "points": int(u.points or 0),
                "level": lvl,
                "level_emoji": _LEVEL_EMOJI.get(lvl, ""),
                "total_co2_saved": round(float(u.total_co2_saved or 0), 2),
                "streak_count": int(u.streak_count or 0),
                "badges_earned": count_badges_earned_for_user(u),
                "is_current_user": u.id == me.id,
            }
        )

    me_rank = 1
    me_idx = 0
    for i, (r, u) in enumerate(ranked):
        if u.id == me.id:
            me_rank = r
            me_idx = i
            break

    above = ranked[me_idx - 1][1] if me_idx > 0 else None
    top_pct = max(1, min(99, math.ceil(100 * me_rank / n_total)))
    percentile = f"top {top_pct}%"

    if me_rank <= 1 or above is None:
        next_rank_name = None
        points_to_next_rank = 0
        progress_to_next_pct = 100
    else:
        next_rank_name = leaderboard_display_name(above)
        ap = int(above.points or 0)
        mp = int(me.points or 0)
        points_to_next_rank = max(0, ap - mp)
        progress_to_next_pct = (
            int(round(100 * mp / ap)) if ap > 0 else 0
        )

    current_user = {
        "rank": me_rank,
        "name": leaderboard_display_name(me),
        "points": int(me.points or 0),
        "percentile": percentile,
        "next_rank_name": next_rank_name,
        "points_to_next_rank": points_to_next_rank,
        "user_id": me.id,
        "progress_to_next_pct": progress_to_next_pct,
    }

    name_pool = [leaderboard_display_name(u) for _, u in ranked[:20]]
    random.shuffle(name_pool)
    weekly_movers = []
    for i in range(min(3, len(name_pool))):
        weekly_movers.append(
            {
                "name": name_pool[i],
                "direction": "up" if random.random() > 0.35 else "down",
                "positions": random.randint(1, 4),
            }
        )

    total_saved_all = sum(float(u.total_co2_saved or 0) for u in all_users)
    streak_leader = max(all_users, key=lambda u: int(u.streak_count or 0))
    community_stats = {
        "total_co2_saved_all": round(total_saved_all, 2),
        "receipts_scanned_week": 347,
        "longest_streak_days": int(streak_leader.streak_count or 0),
        "longest_streak_name": leaderboard_display_name(streak_leader),
    }

    return jsonify(
        {
            "leaderboard": leaderboard,
            "current_user": current_user,
            "weekly_movers": weekly_movers,
            "community_stats": community_stats,
        }
    )


@app.route("/api/user/badges")
def api_user_badges():
    user_info = session.get("user")
    if not user_info:
        return jsonify({"error": "Unauthorized"}), 401
    user = User.query.filter_by(auth0_id=user_info["sub"]).one()
    uid = user.id

    has_receipt_activity = (
        Activity.query.filter(
            Activity.user_id == uid,
            Activity.receipt_id.isnot(None),
            Activity.receipt_id != "",
        ).first()
        is not None
    )
    n_receipts = (
        db.session.query(db.func.count(db.func.distinct(Activity.receipt_id)))
        .filter(
            Activity.user_id == uid,
            Activity.receipt_id.isnot(None),
            Activity.receipt_id != "",
        )
        .scalar()
        or 0
    )
    n_accepted = (
        Swap.query.join(Activity, Swap.activity_id == Activity.id)
        .filter(Activity.user_id == uid, Swap.accepted == True)  # noqa: E712
        .count()
    )
    streak = int(user.streak_count or 0)
    saved = float(user.total_co2_saved or 0)

    def prog(cur, need):
        return f"{min(int(cur), int(need))}/{need}"

    badges = [
        {
            "name": "First Scan",
            "icon": "📸",
            "description": "Upload your very first grocery receipt.",
            "earned": has_receipt_activity,
            "progress": "1/1" if has_receipt_activity else "0/1",
            "lucide": "scan-line",
        },
        {
            "name": "Carbon Tracker",
            "icon": "📊",
            "description": "Track 10 or more receipts to master your footprint.",
            "earned": n_receipts >= 10,
            "progress": prog(n_receipts, 10),
            "lucide": "bar-chart-2",
        },
        {
            "name": "Swap Star",
            "icon": "🔄",
            "description": "Accept 5 eco-friendly swap recommendations.",
            "earned": n_accepted >= 5,
            "progress": prog(n_accepted, 5),
            "lucide": "repeat",
        },
        {
            "name": "Streak Master",
            "icon": "🔥",
            "description": "Maintain a 7-day activity streak.",
            "earned": streak >= 7,
            "progress": prog(streak, 7),
            "lucide": "flame",
        },
        {
            "name": "Eco Warrior",
            "icon": "🌍",
            "description": "Save 50 kg of CO₂ through greener choices.",
            "earned": saved >= 50,
            "progress": f"{min(round(saved, 1), 50)}/50 kg",
            "lucide": "leaf",
        },
        {
            "name": "Century Saver",
            "icon": "💯",
            "description": "Reach the 100 kg CO₂ saved milestone.",
            "earned": saved >= 100,
            "progress": f"{min(round(saved, 1), 100)}/100 kg",
            "lucide": "trophy",
        },
        {
            "name": "Upload Legend",
            "icon": "🏆",
            "description": "Scan 25 receipts — you're a sustainability champion.",
            "earned": n_receipts >= 25,
            "progress": prog(n_receipts, 25),
            "lucide": "award",
        },
    ]
    return jsonify(badges)


@app.route("/api/supermarket/layout")
def api_supermarket_layout():
    return jsonify(get_layout_dict())


@app.route("/api/supermarket/route", methods=["POST"])
def api_supermarket_route():
    """Plan a shopping path (JSON body; POST avoids nonstandard GET bodies)."""
    body = request.get_json(silent=True) or {}
    product_ids = body.get("product_ids")
    if not product_ids or not isinstance(product_ids, list):
        return jsonify({"error": "product_ids (array) required"}), 400
    result = compute_route([str(x) for x in product_ids])
    if "error" in result:
        return jsonify(result), 400
    return jsonify(result)


@app.route("/api/supermarket/latest-receipt-items")
def api_supermarket_latest_receipt_items():
    user_info = session.get("user")
    if not user_info:
        return jsonify({"error": "Unauthorized"}), 401
    user = User.query.filter_by(auth0_id=user_info["sub"]).one()
    latest = (
        Activity.query.filter_by(user_id=user.id)
        .order_by(Activity.timestamp.desc())
        .first()
    )
    if not latest:
        return jsonify({"items": [], "receipt_id": None})
    rid = latest.receipt_id
    rows = (
        Activity.query.filter_by(user_id=user.id, receipt_id=rid)
        .order_by(Activity.id.asc())
        .all()
    )
    items = []
    for a in rows:
        cat = a.category or "Other"
        mp = match_activity_to_layout_product(a.item_name or "", cat)
        items.append(
            {
                "activity_id": a.id,
                "name": a.item_name or "Item",
                "category": cat,
                "kg_co2e": round(float(a.kg_co2e or 0), 2),
                "layout_product_id": mp,
            }
        )
    return jsonify({"items": items, "receipt_id": rid})


RECEIPT_KEY_MANUAL = "__manual__"


def _receipt_group_key(receipt_id):
    return receipt_id if receipt_id else RECEIPT_KEY_MANUAL


def _history_activity_summary(a):
    item_name = a.item_name or "Item"
    brand = (a.brand or "").strip() or "Store Brand"
    return {
        "name": item_name,
        "item_name": item_name,
        "brand": brand,
        "category": a.category or "General",
        "kg_co2e": round(float(a.kg_co2e or 0), 2),
        "quantity": float(a.quantity or 1),
        "unit": getattr(a, "unit", None),
        "price": getattr(a, "price", None),
    }


def _history_activity_detail(a):
    return {
        "id": a.id,
        "item_name": a.item_name or "Item",
        "brand": (a.brand or "").strip() or "Store Brand",
        "category": a.category or "General",
        "quantity": float(a.quantity or 1),
        "unit": a.unit or "each",
        "price": a.price,
        "kg_co2e": round(float(a.kg_co2e or 0), 2),
        "timestamp": a.timestamp.replace(microsecond=0).isoformat() + "Z",
    }


@app.route('/api/history')
def get_history():
    user_info = session.get('user')
    if not user_info:
        return jsonify({"error": "Unauthorized"}), 401

    user = User.query.filter_by(auth0_id=user_info['sub']).one()
    try:
        page = int(request.args.get("page", 1))
    except (TypeError, ValueError):
        page = 1
    page = max(1, page)
    try:
        per_page = int(request.args.get("per_page", 20))
    except (TypeError, ValueError):
        per_page = 20
    per_page = max(1, min(per_page, 100))

    activities = (
        Activity.query.filter_by(user_id=user.id)
        .order_by(Activity.timestamp.desc())
        .all()
    )

    by_key = defaultdict(list)
    for a in activities:
        by_key[_receipt_group_key(a.receipt_id)].append(a)

    def latest_ts(item_list):
        return max(x.timestamp for x in item_list)

    sorted_keys = sorted(by_key.keys(), key=lambda k: latest_ts(by_key[k]), reverse=True)
    total_receipts = len(sorted_keys)
    if total_receipts == 0:
        total_pages = 0
    else:
        total_pages = (total_receipts + per_page - 1) // per_page
    start = (page - 1) * per_page
    page_keys = sorted_keys[start : start + per_page]

    history = []
    for key in page_keys:
        item_list = by_key[key]
        newest_first = sorted(item_list, key=lambda x: x.timestamp, reverse=True)
        date_str = newest_first[0].timestamp.strftime("%B %d, %Y")
        total_co2 = round(sum(float(x.kg_co2e or 0) for x in item_list), 2)
        history.append(
            {
                "receipt_key": key,
                "receipt_label": "Manual Entry" if key == RECEIPT_KEY_MANUAL else key,
                "receipt_id": None if key == RECEIPT_KEY_MANUAL else key,
                "date": date_str,
                "total_co2": total_co2,
                "item_count": len(item_list),
                "items": [_history_activity_summary(x) for x in newest_first],
            }
        )

    return jsonify(
        {
            "history": history,
            "page": page,
            "total_pages": total_pages,
            "total_receipts": total_receipts,
        }
    )


@app.route("/api/history/<string:receipt_key>")
def get_history_receipt_detail(receipt_key):
    user_info = session.get("user")
    if not user_info:
        return jsonify({"error": "Unauthorized"}), 401

    user = User.query.filter_by(auth0_id=user_info["sub"]).one()
    q = Activity.query.filter_by(user_id=user.id)
    if receipt_key == RECEIPT_KEY_MANUAL:
        q = q.filter(Activity.receipt_id.is_(None))
    else:
        q = q.filter(Activity.receipt_id == receipt_key)

    acts = q.order_by(Activity.timestamp.desc()).all()
    if not acts:
        return jsonify({"error": "Receipt not found"}), 404

    items_detail = [_history_activity_detail(a) for a in acts]
    act_ids = [a.id for a in acts]
    swap_rows = (
        Swap.query.filter(Swap.activity_id.in_(act_ids))
        .order_by(Swap.created_at.desc())
        .all()
    )
    swaps_out = []
    for s in swap_rows:
        swaps_out.append(
            {
                "swap_id": s.id,
                "activity_id": s.activity_id,
                "original_product": s.original_product,
                "recommended_product": s.recommended_product,
                "recommended_brand": s.recommended_brand,
                "co2_savings": round(float(s.co2_savings or 0), 4),
                "reason": s.reason,
                "aisle_location": s.aisle_location,
                "accepted": bool(s.accepted),
            }
        )

    breakdown = defaultdict(float)
    for a in acts:
        cat = a.category or "Other"
        breakdown[cat] += float(a.kg_co2e or 0)
    category_breakdown = {k: round(v, 2) for k, v in sorted(breakdown.items())}

    top = max(acts, key=lambda x: float(x.kg_co2e or 0))
    highest = _history_activity_detail(top)

    key = receipt_key
    label = "Manual Entry" if key == RECEIPT_KEY_MANUAL else key
    date_str = acts[0].timestamp.strftime("%B %d, %Y")
    total_co2 = round(sum(float(x.kg_co2e or 0) for x in acts), 2)

    return jsonify(
        {
            "receipt_key": key,
            "receipt_label": label,
            "receipt_id": None if key == RECEIPT_KEY_MANUAL else key,
            "date": date_str,
            "total_co2": total_co2,
            "items": items_detail,
            "swaps": swaps_out,
            "highest_co2_item": highest,
            "category_breakdown": category_breakdown,
        }
    )


@app.route("/api/smart-list")
def api_smart_list():
    user_info = session.get("user")
    if not user_info:
        return jsonify({"error": "Unauthorized"}), 401

    user = User.query.filter_by(auth0_id=user_info["sub"]).first()
    if not user:
        return jsonify({"error": "User not found"}), 404

    activities = (
        Activity.query.filter_by(user_id=user.id)
        .order_by(Activity.timestamp.desc())
        .all()
    )

    if not activities:
        return jsonify(
            {
                "smart_list": [],
                "by_category": {},
                "stats": {
                    "total_items": 0,
                    "original_co2": 0,
                    "optimized_co2": 0,
                    "total_saved": 0,
                    "swap_count": 0,
                },
                "message": "Upload some receipts first to generate your smart list!",
            }
        )

    item_frequency = defaultdict(
        lambda: {
            "count": 0,
            "item_name": "",
            "brand": "",
            "category": "",
            "total_co2": 0.0,
            "total_quantity": 0.0,
            "unit": "",
            "avg_price": None,
            "last_purchased": None,
            "activity_ids": [],
        }
    )

    for act in activities:
        key = (act.item_name or "").lower().strip()
        if not key:
            continue

        entry = item_frequency[key]
        entry["count"] += 1
        entry["item_name"] = act.item_name or entry["item_name"]
        if act.brand:
            entry["brand"] = act.brand
        if act.category:
            entry["category"] = act.category
        entry["total_co2"] += float(act.kg_co2e or 0)
        entry["total_quantity"] += float(act.quantity or 1)
        if act.unit:
            entry["unit"] = act.unit
        elif not entry["unit"]:
            entry["unit"] = "each"
        if act.price is not None and act.price > 0:
            entry["avg_price"] = float(act.price)
        ts = act.timestamp
        if ts and (entry["last_purchased"] is None or ts > entry["last_purchased"]):
            entry["last_purchased"] = ts
        entry["activity_ids"].append(act.id)

    for _key, entry in item_frequency.items():
        c = max(entry["count"], 1)
        entry["avg_co2"] = round(entry["total_co2"] / c, 2)
        entry["avg_quantity"] = round(entry["total_quantity"] / c, 1)

    user_activity_ids = [a.id for a in activities]
    accepted_swaps = {}
    if user_activity_ids:
        swaps = Swap.query.filter(
            Swap.activity_id.in_(user_activity_ids),
            Swap.accepted.is_(True),
        ).all()
        for swap in swaps:
            act = db.session.get(Activity, swap.activity_id)
            if not act:
                continue
            ok = (act.item_name or "").lower().strip()
            if not ok:
                continue
            accepted_swaps[ok] = {
                "recommended_product": swap.recommended_product,
                "recommended_brand": swap.recommended_brand,
                "co2_savings": float(swap.co2_savings or 0),
                "reason": swap.reason,
                "aisle_location": swap.aisle_location,
            }

    smart_list = []
    for key, entry in sorted(item_frequency.items(), key=lambda x: x[1]["count"], reverse=True):
        if entry["count"] < 1:
            continue

        item_id = hashlib.md5(key.encode("utf-8")).hexdigest()[:16]
        item = {
            "id": item_id,
            "item_name": entry["item_name"],
            "brand": entry["brand"] or "",
            "category": entry["category"] or "Other",
            "times_purchased": entry["count"],
            "avg_co2": entry["avg_co2"],
            "avg_quantity": entry["avg_quantity"],
            "unit": entry["unit"] or "each",
            "avg_price": entry["avg_price"],
            "last_purchased": entry["last_purchased"].strftime("%Y-%m-%d")
            if entry["last_purchased"]
            else None,
            # Default: 1 purchase = one-time; 2+ = regular (user can override in UI)
            "is_regular": entry["count"] >= 2,
            "swapped": False,
            "swap_to": None,
            "included": entry["count"] >= 2,
        }

        if key in accepted_swaps:
            swap = accepted_swaps[key]
            item["swapped"] = True
            item["swap_to"] = {
                "product": swap["recommended_product"],
                "brand": swap["recommended_brand"],
                "co2_savings": round(swap["co2_savings"], 4),
                "reason": swap["reason"],
                "aisle_location": swap["aisle_location"],
            }
            item["swapped_co2"] = round(
                max(0.1, item["avg_co2"] - (swap["co2_savings"] or 0)), 2
            )

        smart_list.append(item)

    regular_items = [i for i in smart_list if i["is_regular"]]
    original_co2 = sum(i["avg_co2"] for i in regular_items)
    optimized_co2 = sum(i.get("swapped_co2", i["avg_co2"]) for i in regular_items)
    total_saved = round(original_co2 - optimized_co2, 2)

    category_groups = defaultdict(list)
    for item in smart_list:
        category_groups[item["category"] or "Other"].append(item)

    return jsonify(
        {
            "smart_list": smart_list,
            "by_category": dict(category_groups),
            "stats": {
                "total_items": len(regular_items),
                "original_co2": round(original_co2, 2),
                "optimized_co2": round(optimized_co2, 2),
                "total_saved": total_saved,
                "swap_count": len([i for i in smart_list if i["swapped"]]),
            },
        }
    )


@app.route("/api/smart-list/optimize", methods=["POST"])
def optimize_smart_list():
    if "user" not in session:
        return jsonify({"error": "Unauthorized"}), 401

    if model is None:
        return jsonify({"error": "AI model unavailable", "suggestions": []}), 503

    data = request.get_json(silent=True) or {}
    items = data.get("items", [])
    if not items:
        return jsonify({"suggestions": [], "message": "No items to optimize"})

    candidates = [i for i in items if i.get("included") and not i.get("swapped")]
    if not candidates:
        return jsonify(
            {
                "suggestions": [],
                "message": "All your items are already optimized! Great job.",
            }
        )

    candidates.sort(key=lambda x: float(x.get("avg_co2") or 0), reverse=True)
    top_items = candidates[:5]

    items_text = "\n".join(
        [
            f"- {i.get('item_name', '')} by {i.get('brand') or 'Unknown'} "
            f"({i.get('category', 'Other')}): {i.get('avg_co2', 0)} kg CO2e per purchase"
            for i in top_items
        ]
    )

    n = len(top_items)
    prompt = f"""You are an eco-grocery advisor. The user has these items on their regular grocery list. For EACH item, suggest a more sustainable alternative.

STRICT RULES:
- Suggest the SAME type of product, just a more sustainable brand or variation
- If the item is "Tyson Chicken Breast", suggest "Perdue Harvestland Organic Chicken Breast" — NOT tofu or lentils
- If the item is "Horizon Whole Milk", suggest "Organic Valley Whole Milk" — NOT oat milk
- Focus on: brands with better sustainability practices, local/regional options, organic, regenerative farming, less packaging
- Every recommendation must include a REAL brand name that exists in US grocery stores
- CO2 savings should be realistic (10-30% of original, not 90%)
- You MUST return exactly one suggestion per item — do not skip any

Items to optimize (ordered from highest to lowest carbon impact):
{items_text}

Respond ONLY with a valid JSON array with exactly {n} entries:
[{{"original_product": "exact item name from above", "original_brand": "exact brand from above", "recommended_product": "specific replacement product name", "recommended_brand": "real brand name", "co2_savings": number_between_0.1_and_5.0, "reason": "one sentence explaining why this is better", "aisle_location": "which aisle or section of the store"}}]"""

    try:
        response = model.generate_content(prompt)
        text = (response.text or "").strip()
        if text.startswith("```"):
            text = text.split("\n", 1)[1].rsplit("```", 1)[0].strip()
        parsed = json.loads(text)
        if isinstance(parsed, list):
            suggestions = parsed
        elif isinstance(parsed, dict):
            suggestions = parsed.get("suggestions") or parsed.get("items") or []
            if not isinstance(suggestions, list):
                suggestions = []
        else:
            suggestions = []

        validated = []
        for s in suggestions:
            if not isinstance(s, dict):
                continue
            orig = None
            op = (s.get("original_product") or "").lower()
            for item in top_items:
                iname = (item.get("item_name") or "").lower()
                if iname and (iname in op or op in iname):
                    orig = item
                    break
            if orig:
                max_savings = float(orig.get("avg_co2") or 1) * 0.4
                raw = float(s.get("co2_savings") or 0)
                s["co2_savings"] = min(raw, round(max_savings, 2))
                s["co2_savings"] = max(float(s["co2_savings"]), 0.1)
            validated.append(s)

        return jsonify({"suggestions": validated})
    except Exception as e:
        print(f"Optimize error: {e}", flush=True)
        return jsonify({"error": str(e), "suggestions": []}), 500


@app.route('/api/upload', methods=['POST'])
def upload_file():
    user_info = session.get('user')
    if not user_info:
        return jsonify({"error": "Unauthorized"}), 401
    
    if 'file' not in request.files:
        return jsonify({"error": "No file part"}), 400
        
    file = request.files['file']
    if file.filename == '':
        return jsonify({"error": "No selected file"}), 400
        
    if file and allowed_file(file.filename):
        filename = secure_filename(file.filename)
        # Add timestamp to filename to avoid collisions
        unique_filename = f"{user_info['sub'].replace('|', '_')}_{int(datetime.now().timestamp())}_{filename}"
        file_path = os.path.join(app.config['UPLOAD_FOLDER'], unique_filename)
        file.save(file_path)
        
        # Analyze with Gemini
        try:
            img = Image.open(file_path)
            prompt = """
            Analyze this grocery receipt image carefully. Read the store name from the header if visible.
            Extract each line item with: product name, brand (if printed), quantity, unit (lb, oz, each, gallon, kg, L, etc.), and price if shown.
            For each item, estimate total kg CO2e for that line (quantity-adjusted) using realistic LCA-style factors.

            Respond ONLY with valid JSON matching this exact structure (no markdown):
            {
              "store_name": "string or null",
              "items": [
                {
                  "item_name": "string",
                  "brand": "string or null",
                  "category": "string (one of: Meat, Dairy, Produce, Beverages, Grains, Snacks, Frozen, Household, Other)",
                  "quantity": 1,
                  "unit": "each",
                  "price": null,
                  "kg_co2e": 0.0
                }
              ]
            }
            Use null for unknown brand or price. quantity must be a number (default 1). unit must be a short string.
            """
            response = model.generate_content(
                [prompt, img],
                generation_config={"response_mime_type": "application/json"},
            )

            store_name, raw_items = _parse_receipt_json(response.text)
            if not raw_items:
                print(f"Failed to parse receipt JSON; raw: {response.text[:500]}")
                fb_q, fb_u = 1.0, "each"
                analysis_results = [
                    {
                        "item_name": "Receipt Analysis Fallback",
                        "brand": None,
                        "category": "Other",
                        "quantity": fb_q,
                        "unit": fb_u,
                        "price": None,
                        "kg_co2e": round(
                            _coalesce_kg_co2e(
                                2.5,
                                "Receipt Analysis Fallback",
                                "Other",
                                fb_q,
                                fb_u,
                            ),
                            4,
                        ),
                    }
                ]
                store_name = store_name or None
            else:
                analysis_results = []
                for raw in raw_items:
                    norm = _normalize_parsed_item(raw)
                    if not norm:
                        continue
                    norm["kg_co2e"] = round(
                        _coalesce_kg_co2e(
                            norm["kg_co2e"],
                            norm["item_name"],
                            norm["category"],
                            norm["quantity"],
                            norm["unit"],
                        ),
                        4,
                    )
                    if norm.get("brand") is not None:
                        b = str(norm["brand"]).strip()
                        norm["brand"] = b if b else None
                    analysis_results.append(norm)
                if not analysis_results:
                    fb_q, fb_u = 1.0, "each"
                    analysis_results = [
                        {
                            "item_name": "Receipt Analysis Fallback",
                            "brand": None,
                            "category": "Other",
                            "quantity": fb_q,
                            "unit": fb_u,
                            "price": None,
                            "kg_co2e": round(
                                estimate_co2("unknown", "Other", fb_q, fb_u), 4
                            ),
                        }
                    ]

            user = User.query.filter_by(auth0_id=user_info['sub']).one()

            receipt_id = f"REF-{uuid.uuid4().hex[:8].upper()}"

            for item in analysis_results:
                brand = item.get("brand")
                unit = item.get("unit") or "each"
                price = item.get("price")
                qty = item.get("quantity", 1.0)
                new_activity = Activity(
                    type="grocery",
                    item_name=item.get("item_name", "Unknown Item"),
                    brand=brand,
                    unit=unit[:32] if unit else None,
                    price=price,
                    kg_co2e=float(item.get("kg_co2e", 0) or 0),
                    quantity=float(qty) if qty is not None else 1.0,
                    category=item.get("category") or "Other",
                    user_id=user.id,
                    receipt_id=receipt_id,
                )
                db.session.add(new_activity)

            n_items = len(analysis_results)
            pa_upload, _ = award_points(user, "receipt_upload")
            pa_items, new_pts = award_points(
                user, "receipt_items", {"count": n_items}
            )
            db.session.commit()

            return jsonify(
                {
                    "status": "success",
                    "filename": unique_filename,
                    "message": "AI analysis complete",
                    "receipt_id": receipt_id,
                    "store_name": store_name,
                    "data": analysis_results,
                    "points": new_pts,
                    "points_awarded": pa_upload + pa_items,
                }
            )
            
        except Exception as e:
            print(f"Gemini Analysis Error: {e}")
            return jsonify({"error": str(e)}), 500
        
    return jsonify({"error": "Invalid file type"}), 400


@app.route("/api/generate-swaps", methods=["POST"])
def generate_swaps():
    user_info = session.get("user")
    if not user_info:
        return jsonify({"error": "Unauthorized"}), 401

    body = request.get_json(silent=True) or {}
    receipt_id = body.get("receipt_id")
    if not receipt_id:
        return jsonify({"error": "receipt_id required"}), 400

    user = User.query.filter_by(auth0_id=user_info["sub"]).one()
    activities = (
        Activity.query.filter_by(receipt_id=receipt_id, user_id=user.id)
        .order_by(Activity.kg_co2e.desc())
        .all()
    )
    if not activities:
        return jsonify({"error": "No items for this receipt"}), 404

    lines = []
    for a in activities:
        lines.append(
            f"- {a.item_name} | category={a.category or 'Other'} | {a.kg_co2e:.2f} kg CO2e | "
            f"brand={a.brand or 'n/a'} | qty={a.quantity} {a.unit or 'each'}"
        )

    prompt = f"""Given these grocery items with their carbon footprints, suggest lower-carbon alternatives for the top 3 highest-emission items. For each suggestion include: the original product name, a specific recommended replacement product (include brand name), estimated CO2 savings in kg, a brief reason it's better, and which aisle it would typically be found in at a grocery store. Respond ONLY with valid JSON array:
[{{ "original_product": "...", "recommended_product": "...", "recommended_brand": "...", "co2_savings": 0.0, "reason": "...", "aisle_location": "..." }}]

Items on receipt:
{chr(10).join(lines)}

Use original_product strings that exactly match the item name before the pipe (|) in each line above."""

    try:
        resp = model.generate_content(
            prompt,
            generation_config={"response_mime_type": "application/json"},
        )
        swaps_raw = json.loads(resp.text)
        if not isinstance(swaps_raw, list):
            swaps_raw = [swaps_raw]
    except Exception as e:
        print(f"generate-swaps Gemini error: {e}")
        return jsonify({"error": "Failed to generate swaps"}), 500

    ids = [a.id for a in activities]
    for aid in ids:
        Swap.query.filter_by(activity_id=aid).delete()

    created = []
    for sw in swaps_raw:
        if not isinstance(sw, dict):
            continue
        orig = sw.get("original_product")
        act = _find_activity_for_swap(activities, orig)
        if not act:
            continue
        try:
            savings = float(sw.get("co2_savings") or 0)
        except (TypeError, ValueError):
            savings = 0.0
        rec = Swap(
            activity_id=act.id,
            original_product=(orig or act.item_name or "").strip() or "Item",
            recommended_product=(sw.get("recommended_product") or "Alternative").strip()
            or "Alternative",
            recommended_brand=(sw.get("recommended_brand") or None),
            co2_savings=savings,
            reason=(sw.get("reason") or "").strip() or "Lower-carbon alternative.",
            aisle_location=(sw.get("aisle_location") or None),
            accepted=False,
        )
        if rec.recommended_brand is not None:
            rb = str(rec.recommended_brand).strip()
            rec.recommended_brand = rb if rb else None
        db.session.add(rec)
        created.append(rec)

    db.session.flush()
    out = []
    for rec in created:
        act = rec.activity
        out.append(
            {
                "swap_id": rec.id,
                "original_product": rec.original_product,
                "recommended_product": rec.recommended_product,
                "recommended_brand": rec.recommended_brand,
                "co2_savings": rec.co2_savings,
                "reason": rec.reason,
                "aisle_location": rec.aisle_location,
                "activity_id": rec.activity_id,
            }
        )

    db.session.commit()
    return jsonify({"swaps": out})


def _eco_level_from_points(points):
    return level_name_from_points(points)


@app.route("/api/chat-history", methods=["GET"])
def chat_history():
    user_info = session.get("user")
    if not user_info:
        return jsonify({"error": "Unauthorized"}), 401
    user = User.query.filter_by(auth0_id=user_info["sub"]).one()
    rows = (
        ChatMessage.query.filter_by(user_id=user.id)
        .order_by(ChatMessage.created_at.desc())
        .limit(20)
        .all()
    )
    rows.reverse()
    out = [
        {
            "role": m.role,
            "content": m.content,
            "created_at": m.created_at.replace(microsecond=0).isoformat() + "Z",
        }
        for m in rows
    ]
    return jsonify(out)


@app.route("/api/chat/clear", methods=["POST"])
def clear_chat():
    user_info = session.get("user")
    if not user_info:
        return jsonify({"error": "Unauthorized"}), 401
    user = User.query.filter_by(auth0_id=user_info["sub"]).first()
    if not user:
        return jsonify({"error": "User not found"}), 404
    ChatMessage.query.filter_by(user_id=user.id).delete()
    db.session.commit()
    return jsonify({"status": "ok", "message": "Chat history cleared"})


@app.route('/api/chat', methods=['POST'])
def chat():
    user_info = session.get('user')
    if not user_info:
        return jsonify({"error": "Unauthorized"}), 401

    if model is None:
        return jsonify({"error": "AI model unavailable"}), 503

    data = request.json or {}
    user_query = data.get('query')
    if not user_query:
        return jsonify({"error": "No query provided"}), 400

    user = User.query.filter_by(auth0_id=user_info['sub']).one()

    total_co2 = db.session.query(db.func.sum(Activity.kg_co2e)).filter_by(user_id=user.id).scalar() or 0.0
    recent_activities = Activity.query.filter_by(user_id=user.id).order_by(Activity.timestamp.desc()).limit(15).all()

    cat_rows = (
        db.session.query(Activity.category, db.func.sum(Activity.kg_co2e).label("tot"))
        .filter(Activity.user_id == user.id)
        .group_by(Activity.category)
        .order_by(db.func.sum(Activity.kg_co2e).desc())
        .limit(3)
        .all()
    )
    top_cats = "\n".join(
        f"- {(c or 'Other')}: {float(t or 0):.2f} kg CO2e total" for c, t in cat_rows
    ) or "- No category data yet"

    recent_swaps = (
        Swap.query.join(Activity)
        .filter(Activity.user_id == user.id)
        .order_by(Swap.created_at.desc())
        .limit(8)
        .all()
    )
    swap_lines = []
    for s in recent_swaps:
        brand = f" ({s.recommended_brand})" if s.recommended_brand else ""
        reason_snip = (s.reason or "")[:120]
        swap_lines.append(
            f"- {s.original_product} → {s.recommended_product}{brand}: ~{s.co2_savings:.2f} kg CO2e saved potential; {reason_snip}"
        )
    swaps_summary = "\n".join(swap_lines) if swap_lines else "- None generated yet"

    history_summary = "\n".join(
        [f"- {a.item_name} ({a.kg_co2e:.2f} kg CO2e) in {a.category or 'General'}" for a in recent_activities]
    ) or "- No recent items"

    level = _eco_level_from_points(user.points)
    points = int(user.points or 0)

    receipt_context = data.get("receipt_context")
    receipt_extra = ""
    if receipt_context and isinstance(receipt_context, dict):
        items = receipt_context.get("items") or []
        lines = []
        for i in items:
            if not isinstance(i, dict):
                continue
            nm = i.get("item_name") or i.get("name") or "Item"
            br = (i.get("brand") or "").strip() or "Unknown"
            kg = i.get("kg_co2e")
            if kg is None:
                lines.append(f"- {nm} ({br})")
            else:
                lines.append(f"- {nm} ({br}): {kg} kg CO2e")
        items_text = "\n".join(lines) if lines else "- (no line items)"
        rid = receipt_context.get("receipt_id", "unknown")
        tot = receipt_context.get("total_co2", 0)
        try:
            tot_f = float(tot)
        except (TypeError, ValueError):
            tot_f = 0.0
        receipt_extra = f"""

The user is asking about a specific receipt ({rid}):
{items_text}
Total: {tot_f:.2f} kg CO2e
"""

    system_prompt = f"""You are EcoCoach AI, a friendly and knowledgeable grocery sustainability coach built into the EcoCart AI platform. You help users understand their grocery carbon footprint and make greener choices.

Your personality: concise, encouraging, practical. Celebrate wins, give specific brand recommendations, and never lecture or guilt-trip. When recommending products, always include real brand names. Cite approximate kg CO₂e values when discussing carbon impact. Keep responses under 150 words unless the user asks for detail.

You are helping: {resolve_display_name(user, user_info)}

User context:
- EcoCart level: {level} (from EcoPoints: {points})
- Total logged footprint (sum of purchases): {total_co2:.2f} kg CO2e
- Top categories by CO2 (lifetime):
{top_cats}
- Recent purchase line items (up to 15, newest first):
{history_summary}
- Recent swap recommendations the app has suggested (may be empty):
{swaps_summary}{receipt_extra}

Stay on topic for grocery sustainability, receipts, swaps, and climate-friendly shopping."""

    try:
        response = model.generate_content([system_prompt, f"User question: {user_query}"])
        try:
            text = (response.text or "").strip()
        except (ValueError, AttributeError):
            text = ""
        if not text:
            text = "I could not generate a reply. Please try again."
    except Exception as e:
        print(f"Chat Error: {e}")
        return jsonify({"error": str(e)}), 500

    db.session.add(ChatMessage(user_id=user.id, role="user", content=user_query))
    db.session.add(ChatMessage(user_id=user.id, role="assistant", content=text))
    db.session.commit()

    return jsonify({"response": text})

if __name__ == "__main__":
    app.run(debug=True, port=1970)


