from flask import Flask, redirect, url_for, session, render_template, request, jsonify
from authlib.integrations.flask_client import OAuth
from dotenv import load_dotenv, find_dotenv
import os
from models import db, User, Activity
from urllib.parse import urlencode, quote_plus
from werkzeug.utils import secure_filename
from datetime import timedelta, datetime

# Load environment variables
load_dotenv(find_dotenv())

app = Flask(__name__)
app.secret_key = os.getenv("FLASK_SECRET", "super-secret-key")

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
        
        # Actions Today
        today = datetime.utcnow().date()
        actions_today = Activity.query.filter_by(user_id=user.id).filter(db.func.date(Activity.timestamp) == today).count()
        
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
                             actions_today=actions_today,
                             recent_activities=recent_activities,
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
    
    return jsonify({
        "total_co2": round(total_co2, 2),
        "streak": user.streak_count,
        "trends": trends,
        "name": user.name or user_info.get('name')
    })

@app.route('/api/activities')
def get_activities():
    user_info = session.get('user')
    if not user_info:
        return jsonify({"error": "Unauthorized"}), 401
    
    user = User.query.filter_by(auth0_id=user_info['sub']).one()
    activities = Activity.query.filter_by(user_id=user.id).order_by(Activity.timestamp.desc()).limit(1).all()
    
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
        file.save(os.path.join(app.config['UPLOAD_FOLDER'], unique_filename))
        
        # (Placeholder) Simulate creation of a pending activity
        user = User.query.filter_by(auth0_id=user_info['sub']).one()
        new_activity = Activity(
            type='grocery',
            item_name='Receipt Analysis (In progress)',
            kg_co2e=2.45,
            category='Shopping',
            user_id=user.id
        )
        db.session.add(new_activity)
        db.session.commit()
        
        return jsonify({
            "status": "success", 
            "filename": unique_filename,
            "message": "AI analysis queued"
        })
        
    return jsonify({"error": "Invalid file type"}), 400

if __name__ == "__main__":
    app.run(debug=True, port=5000)


