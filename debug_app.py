from app import app, db, User, Activity
from flask import session
import os

@app.route('/debug-login')
def debug_login():
    # Create a dummy user if not exists
    user = User.query.filter_by(auth0_id='debug_user').first()
    if not user:
        user = User(
            auth0_id='debug_user',
            name='Debug Explorer',
            email='debug@example.com'
        )
        db.session.add(user)
        db.session.commit()
    
    session['user'] = {
        'sub': 'debug_user',
        'name': 'Debug Explorer',
        'given_name': 'Debug',
        'email': 'debug@example.com'
    }
    return "Logged in as Debug Explorer! Go to <a href='/'>Dashboard</a>"

if __name__ == "__main__":
    app.run(debug=True, port=5001)
