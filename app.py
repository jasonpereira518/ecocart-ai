from flask import Flask, redirect, url_for, session, render_template, request, jsonify
from authlib.integrations.flask_client import OAuth
from dotenv import load_dotenv, find_dotenv
import os
from models import db, User, Activity
from urllib.parse import urlencode, quote_plus
from werkzeug.utils import secure_filename
from datetime import timedelta, datetime
import google.generativeai as genai
from PIL import Image
import uuid
from itertools import groupby

# Load environment variables
load_dotenv(find_dotenv())

app = Flask(__name__)
app.secret_key = os.getenv("FLASK_SECRET", "super-secret-key")

# Gemini Configuration
api_key = os.getenv("GEMINI_API_KEY")
if not api_key:
    print("WARNING: GEMINI_API_KEY not found in environment")
genai.configure(api_key=api_key)

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
app.config['SQLALCHEMY_DATABASE_URI'] = os.getenv("DATABASE_URL", "sqlite:///terracoach.db")
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
db.init_app(app)

# Initialize database
with app.app_context():
    db.create_all()

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

# Routes
@app.route('/')
def index():
    user_info = session.get('user')
    if user_info:
        # Check if user exists in local DB, if not create them
        user = User.query.filter_by(auth0_id=user_info['sub']).first()
        if not user:
            user = User(
                auth0_id=user_info['sub'],
                name=user_info.get('name'),
                email=user_info.get('email')
            )
            db.session.add(user)
            db.session.commit()
        
        # Fetch Stats
        total_co2 = db.session.query(db.func.sum(Activity.kg_co2e)).filter_by(user_id=user.id).scalar() or 0.0
        
        # Recent Activities
        recent_activities = Activity.query.filter_by(user_id=user.id).order_by(Activity.timestamp.desc()).limit(5).all()
        
        # Simple Habits/Trends Logic
        # (Compare this week vs last week or just show current distribution)
        categories = db.session.query(Activity.category, db.func.sum(Activity.kg_co2e)).filter_by(user_id=user.id).group_by(Activity.category).all()
        trends = {cat: float(val) for cat, val in categories}
        
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
                "title": "Welcome to TerraCoach!",
                "text": "Start by uploading a receipt or logging an activity to see your impact.",
                "saving": "Get started",
                "difficulty": "EASY"
            })

        return render_template('index.html', 
                             user=user_info, 
                             local_user=user, 
                             total_co2=round(total_co2, 2),
                             recent_activities=recent_activities,
                             all_activities=Activity.query.filter_by(user_id=user.id).order_by(Activity.timestamp.desc()).all(),
                             trends=trends,
                             insights=insights)
    
    return render_template('login.html')

@app.route('/login')
def login():
    return auth0.authorize_redirect(redirect_uri=url_for('callback', _external=True))

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
    
    # Simple aggregation logic
    total_co2 = db.session.query(db.func.sum(Activity.kg_co2e)).filter_by(user_id=user.id).scalar() or 0.0
    
    # Mock some trends for now vs last week
    trends = {
        "Red Meat": -24,
        "Car Usage": -12,
        "Walking": 30
    }
    
    recent_activities = Activity.query.filter_by(user_id=user.id).order_by(Activity.timestamp.desc()).limit(5).all()
    recent_list = [{"item_name": a.item_name, "kg_co2e": a.kg_co2e} for a in recent_activities]
    
    return jsonify({
        "total_co2": round(total_co2, 2),
        "points": user.points,
        "trends": trends,
        "name": user.name or user_info.get('name'),
        "recent_activities": recent_list
    })

@app.route('/api/history')
def get_history():
    user_info = session.get('user')
    if not user_info:
        return jsonify({"error": "Unauthorized"}), 401
    
    user = User.query.filter_by(auth0_id=user_info['sub']).one()
    activities = Activity.query.filter_by(user_id=user.id).order_by(Activity.timestamp.desc()).all()
    
    # Group by receipt_id
    grouped = []
    for r_id, items in groupby(activities, key=lambda x: x.receipt_id):
        item_list = list(items)
        grouped.append({
            "receipt_id": r_id or "Manual Entry",
            "date": item_list[0].timestamp.strftime('%B %d, %Y'),
            "total_co2": round(sum(item.kg_co2e for item in item_list), 2),
            "items": [{
                "name": item.item_name,
                "category": item.category or "General",
                "kg_co2e": round(item.kg_co2e, 2)
            } for item in item_list]
        })
    
    return jsonify({"history": grouped})

@app.route('/api/activities')
def get_activities():
    user_info = session.get('user')
    if not user_info:
        return jsonify({"error": "Unauthorized"}), 401
    
    user = User.query.filter_by(auth0_id=user_info['sub']).one()
    activities = Activity.query.filter_by(user_id=user.id).order_by(Activity.timestamp.desc()).limit(1).all()
    
    session['user'] = {
        'sub': 'test_user_long_name_123',
        'name': 'Alexandrovsky-Smith-Wellington-The-Third@extra-long-domain-name-that-definitely-overflows.com',
        'given_name': 'Alexandrovsky-Smith-Wellington',
        'email': 'extremely-long-email-address-for-testing-purposes@example.com'
    }
    
    return jsonify([{
        "id": a.id,
        "type": a.type,
        "item_name": a.item_name,
        "kg_co2e": a.kg_co2e,
        "category": a.category,
        "timestamp": a.timestamp.strftime("%Y-%m-%d %H:%M")
    } for a in activities])

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
            Analyze this receipt carefully line by line. Extract the main items and their quantities.
            For each identified item, perform a realistic estimation of its carbon footprint in kg CO2e based on widely accepted Life Cycle Assessment (LCA) averages (e.g., beef ~27kg CO2e/kg, chicken ~6kg CO2e/kg, local vegetables ~0.5kg CO2e/kg, common household goods ~2-5kg CO2e per item).
            Return a JSON list of objects representing these items exactly matching the following schema.
            Keys to include:
            "item_name" (string), "kg_co2e" (float - calculate accurately based on quantity and type), "category" (string: 'Food', 'Transport', 'Shopping', or 'Energy').
            Example: [{"item_name": "Beef Steak 1lb", "kg_co2e": 12.5, "category": "Food"}]
            """
            response = model.generate_content(
                [prompt, img],
                generation_config={"response_mime_type": "application/json"}
            )
            import json
            
            try:
                analysis_results = json.loads(response.text)
                if not isinstance(analysis_results, list):
                    analysis_results = [analysis_results]
            except json.JSONDecodeError as e:
                print(f"Failed to decode JSON: {e}\nRaw response: {response.text}")
                analysis_results = [{"item_name": "Receipt Analysis Fallback", "kg_co2e": 2.5, "category": "Shopping"}]
            
            user = User.query.filter_by(auth0_id=user_info['sub']).one()
            
            # Generate a unique receipt ID for this batch
            receipt_id = f"REF-{uuid.uuid4().hex[:8].upper()}"
            
            # Save the analyzed activities
            for item in analysis_results:
                new_activity = Activity(
                    type='grocery',
                    item_name=item.get('item_name', 'Unknown Item'),
                    kg_co2e=item.get('kg_co2e', 0.0),
                    category=item.get('category', 'Shopping'),
                    user_id=user.id,
                    receipt_id=receipt_id
                )
                db.session.add(new_activity)
            
            db.session.commit()
            
            return jsonify({
                "status": "success", 
                "filename": unique_filename,
                "message": "AI analysis complete",
                "data": analysis_results
            })
            
        except Exception as e:
            print(f"Gemini Analysis Error: {e}")
            return jsonify({"error": str(e)}), 500
        
    return jsonify({"error": "Invalid file type"}), 400

@app.route('/api/chat', methods=['POST'])
def chat():
    user_info = session.get('user')
    if not user_info:
        return jsonify({"error": "Unauthorized"}), 401
    
    data = request.json
    user_query = data.get('query')
    if not user_query:
        return jsonify({"error": "No query provided"}), 400
        
    user = User.query.filter_by(auth0_id=user_info['sub']).one()
    
    # Gather User Context
    total_co2 = db.session.query(db.func.sum(Activity.kg_co2e)).filter_by(user_id=user.id).scalar() or 0.0
    recent_activities = Activity.query.filter_by(user_id=user.id).order_by(Activity.timestamp.desc()).limit(15).all()
    
    history_summary = "\n".join([f"- {a.item_name} ({a.kg_co2e}kg CO2e) in {a.category or 'General'}" for a in recent_activities])
    
    system_prompt = f"""
    You are the TerraCoach AI Sustainability Coach. Your goal is to help {user.name} reduce their carbon footprint.
    User Context:
    - Current Total Carbon Footprint: {total_co2:.2f} kg CO2e
    - Points Earned: {user.points}
    - Recent Activities:
    {history_summary}
    
    Be supportive, insightful, and offer practical, specific advice based on their history.
    If they ask about an item from their history, refer to it specifically.
    Keep your responses relatively concise (1-3 small paragraphs).
    """
    
    try:
        chat_model = genai.GenerativeModel('gemini-2.5-flash')
        response = chat_model.generate_content([system_prompt, f"User Question: {user_query}"])
        return jsonify({"response": response.text})
    except Exception as e:
        print(f"Chat Error: {e}")
        return jsonify({"error": str(e)}), 500

if __name__ == "__main__":
    app.run(debug=True, port=5000)


