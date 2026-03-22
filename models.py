from flask_sqlalchemy import SQLAlchemy
from datetime import datetime

db = SQLAlchemy()

class User(db.Model):
    __tablename__ = 'users'
    id = db.Column(db.Integer, primary_key=True)
    auth0_id = db.Column(db.String(128), unique=True, nullable=False)
    name = db.Column(db.String(128))
    email = db.Column(db.String(128), unique=True)
    points = db.Column(db.Integer, default=0)
    last_login = db.Column(db.DateTime, default=datetime.utcnow)
    
    # Relationship
    activities = db.relationship('Activity', backref='user', lazy=True)

class Activity(db.Model):
    __tablename__ = 'activities'
    id = db.Column(db.Integer, primary_key=True)
    type = db.Column(db.String(64), nullable=False) # e.g. 'grocery', 'travel', 'energy'
    item_name = db.Column(db.String(128)) # e.g. 'Beef Ribeye'
    kg_co2e = db.Column(db.Float, default=0.0)
    user_id = db.Column(db.Integer, db.ForeignKey('users.id'), nullable=False)
    timestamp = db.Column(db.DateTime, default=datetime.utcnow)
    
    # Additional data for trend calculation
    quantity = db.Column(db.Float, default=1.0)
    category = db.Column(db.String(64)) # e.g., 'Meat', 'Dairy', 'Vegetable'
