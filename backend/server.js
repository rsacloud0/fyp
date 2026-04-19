require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const { MongoClient, ObjectId } = require('mongodb');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const app = express();
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'thinkia_secret_key_2024_change_in_production';
const JWT_EXPIRY = process.env.JWT_EXPIRY || '7d';
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const DB_NAME = process.env.DB_NAME || 'thinkia';
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || '';

let db;
let users, sessions, messages, metrics, goals;

async function initDB() {
  try {
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    db = client.db(DB_NAME);

    users = db.collection('users');
    sessions = db.collection('sessions');
    messages = db.collection('messages');
    metrics = db.collection('metrics');
    goals = db.collection('goals');

    await users.createIndex({ email: 1 }, { unique: true });
    await users.createIndex({ device_id: 1 }, { sparse: true });
    await sessions.createIndex({ user_id: 1 });
    await sessions.createIndex({ device_id: 1 }, { sparse: true });
    await messages.createIndex({ session_id: 1 });
    await goals.createIndex({ user_id: 1 });
    await goals.createIndex({ device_id: 1 }, { sparse: true });
    await goals.createIndex({ session_id: 1 });

    const guestExists = await users.findOne({ email: 'guest@thinkia.com' });
    if (!guestExists) {
      const hashedPassword = await bcrypt.hash('guest123', 10);
      await users.insertOne({
        name: 'Guest',
        email: 'guest@thinkia.com',
        password: hashedPassword,
        created_at: new Date()
      });
      console.log('✅ Guest account created: guest@thinkia.com / guest123');

      const guest = await users.findOne({ email: 'guest@thinkia.com' });
      await metrics.insertOne({
        user_id: guest._id,
        depth: 0,
        assumptions: 0,
        counterargument: 0,
        evidence: 0,
        clarity: 0,
        bloom_remember: 0,
        bloom_understand: 0,
        bloom_apply: 0,
        bloom_analyse: 0,
        bloom_evaluate: 0,
        bloom_create: 0,
        total_messages: 0,
        total_sessions: 0,
        active_days: []
      });
      console.log('✅ Guest metrics created');
    }

    console.log('✅ MongoDB connected successfully');
  } catch (err) {
    console.warn('⚠️ MongoDB connection failed:', err.message);
    console.warn('   App will run without database persistence');
    db = null;
  }
}

app.use(cors({
  origin: ['http://localhost:8080', 'http://localhost:3000', 'http://127.0.0.1:8080', '*'],
  methods: ['GET', 'POST', 'DELETE', 'PUT'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '2mb' }));

app.use((req, res, next) => {
  // Basic security headers
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.removeHeader('X-Powered-By');
  
  // Cloudflare security headers (for when deployed behind Cloudflare)
  res.setHeader('X-UA-Compatible', 'IE=Edge');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  
  // Content Security Policy (helps prevent XSS/injection)
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' https://fonts.googleapis.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: https:; font-src 'self' https://fonts.gstatic.com; connect-src 'self' https://openrouter.ai https://youtube.googleapis.com");
  
  next();
});

// ════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════

function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    req.isGuest = decoded.isGuest || false;
    req.deviceId = decoded.device_id || null;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

async function getOwnedSession(sessionId, userId) {
  if (!ObjectId.isValid(sessionId) || !ObjectId.isValid(userId)) {
    return null;
  }
  return sessions.findOne({
    _id: new ObjectId(sessionId),
    user_id: new ObjectId(userId)
  });
}

async function getOwnedSessionAny(sessionId, userId, deviceId) {
  if (!ObjectId.isValid(sessionId)) {
    return null;
  }
  // Try user_id first, then device_id
  if (userId && ObjectId.isValid(userId)) {
    const session = await sessions.findOne({
      _id: new ObjectId(sessionId),
      user_id: new ObjectId(userId)
    });
    if (session) return session;
  }
  if (deviceId) {
    const session = await sessions.findOne({
      _id: new ObjectId(sessionId),
      device_id: deviceId
    });
    if (session) return session;
  }
  return null;
}

// FIX 1: Helper to normalise message content (same as frontend coerceMessageText)
function normalizeMessageContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(item => {
      if (typeof item === 'string') return item;
      if (item && typeof item.text === 'string') return item.text;
      if (item && typeof item.content === 'string') return item.content;
      return '';
    }).filter(Boolean).join('\n');
  }
  if (content && typeof content === 'object') {
    if (typeof content.text === 'string') return content.text;
    if (typeof content.answer === 'string') return content.answer;
    if (typeof content.content === 'string') return content.content;
    try { return JSON.stringify(content); } catch (e) { return String(content); }
  }
  return content == null ? '' : String(content);
}

// FIX 1: Parse AI JSON response and extract just the answer field for display
function parseAIResponse(rawText) {
  const trimmed = (rawText || '').trim();
  try {
    const cleaned = trimmed.replace(/```json|```/g, '').trim();
    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (firstError) {
      const firstBrace = cleaned.indexOf('{');
      const lastBrace = cleaned.lastIndexOf('}');
      if (firstBrace >= 0 && lastBrace > firstBrace) {
        parsed = JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
      } else {
        throw firstError;
      }
    }
    return {
      answer: parsed.answer || parsed.response || parsed.content || parsed.message || parsed.text || trimmed,
      bloom_level: Number(parsed.bloom_level || parsed.level) || null,
      bloom_label: parsed.bloom_label || parsed.label || '',
      thinking_insight: parsed.thinking_insight || '',
      challenge_question: parsed.challenge_question || '',
      metrics: parsed.metrics || {},
      fallacies_detected: parsed.fallacies_detected || [],
      framework_suggested: parsed.framework_suggested || null,
      concepts: parsed.concepts || [],
      resources: parsed.resources || []
    };
  } catch (e) {
    // If parsing fails, treat the whole text as the answer
    return {
      answer: trimmed,
      bloom_level: null,
      bloom_label: '',
      thinking_insight: '',
      challenge_question: '',
      metrics: {},
      fallacies_detected: [],
      framework_suggested: null,
      concepts: [],
      resources: []
    };
  }
}

// FIX 3: Track active days in MongoDB so activity log survives localStorage clears
async function trackActiveDay(userIdObj) {
  if (!db) return;
  const today = new Date().toISOString().split('T')[0]; // "2026-04-18"
  await metrics.updateOne(
    { user_id: userIdObj },
    { $addToSet: { active_days: today } }
  );
}

// ════════════════════════════════════════
// HEALTH CHECK
// ════════════════════════════════════════
app.get('/health', (req, res) => {
  res.json({ status: 'ThinkIA backend running', timestamp: new Date().toISOString() });
});

// ════════════════════════════════════════
// YOUTUBE API - Search and get exact video links
// ════════════════════════════════════════
app.get('/api/youtube/search', authenticate, async (req, res) => {
  try {
    const query = req.query.q || req.query.query;
    if (!query) {
      return res.status(400).json({ error: 'Query parameter q is required' });
    }

    console.log('YouTube search for:', query, 'Key exists:', !!YOUTUBE_API_KEY);

    // Use YouTube Data API if key is configured
    if (YOUTUBE_API_KEY && YOUTUBE_API_KEY.length > 10) {
      try {
        const ytUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&maxResults=3&q=${encodeURIComponent(query)}&type=video&key=${YOUTUBE_API_KEY}`;
        const ytRes = await fetch(ytUrl);
        const ytData = await ytRes.json();
        
        console.log('YouTube API response:', ytData.error?.message || 'OK');
        
        if (ytData.items && ytData.items.length > 0) {
          const videos = ytData.items.map(item => ({
            title: item.snippet.title,
            channel: item.snippet.channelTitle,
            videoId: item.id.videoId,
            thumbnail: item.snippet.thumbnails?.medium?.url,
            url: `https://www.youtube.com/watch?v=${item.id.videoId}`
          }));
          return res.json({ videos, fromApi: true });
        }
      } catch (ytError) {
        console.error('YouTube API error:', ytError.message);
      }
    }

    // Fallback to search page
    res.json({
      videos: [],
      searchUrl: `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`,
      message: YOUTUBE_API_KEY ? 'No results found' : 'Add YOUTUBE_API_KEY to .env'
    });
  } catch (error) {
    console.error('YouTube search error:', error);
    res.status(500).json({ error: 'Search failed' });
  }
});

// 🔧 FIX: Add token verification endpoint for frontend auth checks
app.get('/api/auth/verify', authenticate, (req, res) => {
  res.json({ valid: true, userId: req.userId });
});

// ════════════════════════════════════════
// AUTH
// ════════════════════════════════════════
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    if (!db) {
      return res.status(500).json({ error: 'Database not available' });
    }

    const user = await users.findOne({ email });
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = jwt.sign(
      { userId: user._id.toString(), email: user.email },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRY }
    );

    res.json({
      user: { id: user._id.toString(), name: user.name, email: user.email },
      token,
      expiresIn: JWT_EXPIRY
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Guest login (no account required) - dual auth system
app.post('/api/auth/guest-login', async (req, res) => {
  try {
    const { device_id } = req.body;

    if (!device_id) {
      return res.status(400).json({ error: 'Device ID is required' });
    }

    if (!db) {
      return res.status(500).json({ error: 'Database not available' });
    }

    // Check if guest user exists for this device
    let user = await users.findOne({ device_id });

    if (!user) {
      // Create new guest user
      const now = new Date();
      const result = await users.insertOne({
        name: 'Guest',
        email: null,  // No email for guest
        password: null,  // No password for guest
        device_id: device_id,
        is_guest: true,
        created_at: now
      });

      // Create metrics for guest
      await metrics.insertOne({
        user_id: result.insertedId,
        depth: 0,
        assumptions: 0,
        counterargument: 0,
        evidence: 0,
        clarity: 0,
        bloom_remember: 0,
        bloom_understand: 0,
        bloom_apply: 0,
        bloom_analyse: 0,
        bloom_evaluate: 0,
        bloom_create: 0,
        total_messages: 0,
        total_sessions: 0,
        active_days: []
      });

      user = await users.findOne({ _id: result.insertedId });
      console.log(`✅ Guest account created: device_id ${device_id}`);
    }

    // Generate token for guest (shorter expiry for guests)
    const token = jwt.sign(
      { userId: user._id.toString(), device_id: user.device_id, isGuest: true },
      JWT_SECRET,
      { expiresIn: '30d' }  // Longer expiry for guests
    );

    res.json({
      user: { id: user._id.toString(), name: user.name, is_guest: true },
      token,
      expiresIn: '30d',
      is_guest: true
    });
  } catch (error) {
    console.error('Guest login error:', error);
    res.status(500).json({ error: 'Guest login failed' });
  }
});

// Register (create account from guest or new)
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, name, device_id } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    if (!db) {
      return res.status(500).json({ error: 'Database not available' });
    }

    // Check if email already exists
    const existingUser = await users.findOne({ email });
    if (existingUser) {
      return res.status(401).json({ error: 'Email already registered' });
    }

    let userIdObj = null;
    let newUserId = null;

    // If device_id provided, try to upgrade guest account
    if (device_id) {
      const guestUser = await users.findOne({ device_id });
      if (guestUser && guestUser.is_guest) {
        userIdObj = guestUser._id;
        newUserId = userIdObj.toString();
      }
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    if (userIdObj) {
      // Upgrade existing guest account
      await users.updateOne(
        { _id: userIdObj },
        {
          $set: {
            name: name || 'User',
            email: email,
            password: hashedPassword,
            is_guest: false,
            upgraded_at: new Date()
          },
          $unset: { device_id: '' }
        }
      );

      // Also update metrics to remove device_id reference
      await metrics.updateOne(
        { user_id: userIdObj },
        { $unset: { device_id: '' } }
      );

      newUserId = newUserId;
    } else {
      // Create new account
      const result = await users.insertOne({
        name: name || 'User',
        email: email,
        password: hashedPassword,
        device_id: null,
        is_guest: false,
        created_at: new Date()
      });

      await metrics.insertOne({
        user_id: result.insertedId,
        depth: 0,
        assumptions: 0,
        counterargument: 0,
        evidence: 0,
        clarity: 0,
        bloom_remember: 0,
        bloom_understand: 0,
        bloom_apply: 0,
        bloom_analyse: 0,
        bloom_evaluate: 0,
        bloom_create: 0,
        total_messages: 0,
        total_sessions: 0,
        active_days: []
      });

      newUserId = result.insertedId.toString();
    }

    const token = jwt.sign(
      { userId: newUserId, email: email },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRY }
    );

    res.json({
      user: { id: newUserId, name: name || 'User', email: email },
      token,
      expiresIn: JWT_EXPIRY,
      registered: true
    });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// ════════════════════════════════════════
// SESSIONS
// ════════════════════════════════════════
app.get('/api/sessions', authenticate, async (req, res) => {
  try {
    if (!db) return res.json([]);

    // Support both user_id and device_id (for guests)
    const query = req.isGuest && req.deviceId
      ? { $or: [{ user_id: new ObjectId(req.userId) }, { device_id: req.deviceId }] }
      : { user_id: new ObjectId(req.userId) };

    const userSessions = await sessions.find(query)
      .sort({ updated_at: -1 })
      .toArray();

    // FIX 2: Also fetch goals so dashboard can match sessions to goals
    const sessionIds = userSessions.map(s => s._id.toString());
    const sessionGoals = await goals.find({
      user_id: new ObjectId(req.userId),
      session_id: { $in: sessionIds }
    }).toArray();

    const goalsBySessionId = {};
    sessionGoals.forEach(g => { goalsBySessionId[g.session_id] = g.goal; });

    res.json(userSessions.map(s => ({
      id: s._id.toString(),
      title: s.title,
      goal: goalsBySessionId[s._id.toString()] || '',
      created_at: s.created_at,
      updated_at: s.updated_at
    })));
  } catch (error) {
    console.error('Get sessions error:', error);
    res.status(500).json({ error: 'Failed to fetch sessions' });
  }
});

app.post('/api/sessions', authenticate, async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'Database not available' });

    const { title } = req.body;
    const now = new Date();

    // Build session object - include device_id for guests
    const sessionDoc = {
      user_id: new ObjectId(req.userId),
      title: title || 'New Chat',
      created_at: now,
      updated_at: now
    };

    // If guest, also store device_id for persistence
    if (req.isGuest && req.deviceId) {
      sessionDoc.device_id = req.deviceId;
    }

    const result = await sessions.insertOne(sessionDoc);

    // FIX 2: Sync total_sessions with actual count
    const sessionCount = await sessions.countDocuments({ user_id: new ObjectId(req.userId) });
    await metrics.updateOne(
      { user_id: new ObjectId(req.userId) },
      { $set: { total_sessions: sessionCount } }
    );

    res.json({
      id: result.insertedId.toString(),
      title: title || 'New Chat',
      created_at: now
    });
  } catch (error) {
    console.error('Create session error:', error);
    res.status(500).json({ error: 'Failed to create session' });
  }
});

app.delete('/api/sessions/:id', authenticate, async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'Database not available' });

    const ownedSession = await getOwnedSession(req.params.id, req.userId);
    if (!ownedSession) {
      return res.status(404).json({ error: 'Session not found' });
    }

    await sessions.deleteOne({ _id: ownedSession._id, user_id: new ObjectId(req.userId) });
    await messages.deleteMany({ session_id: req.params.id });
    await goals.deleteMany({ session_id: req.params.id, user_id: new ObjectId(req.userId) });

    // FIX 2: Sync total_sessions with actual count after deletion
    const sessionCount = await sessions.countDocuments({ user_id: new ObjectId(req.userId) });
    await metrics.updateOne(
      { user_id: new ObjectId(req.userId) },
      { $set: { total_sessions: sessionCount } }
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Delete session error:', error);
    res.status(500).json({ error: 'Failed to delete session' });
  }
});

// ════════════════════════════════════════
// MESSAGES
// ════════════════════════════════════════
app.get('/api/sessions/:id/messages', authenticate, async (req, res) => {
  try {
    if (!db) return res.json([]);

    const ownedSession = await getOwnedSession(req.params.id, req.userId);
    if (!ownedSession) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const sessionMsgs = await messages.find({ session_id: req.params.id })
      .sort({ created_at: 1 })
      .toArray();

    // FIX 1: Return both content (parsed answer) and raw_content (full JSON)
    // so the frontend can render the answer cleanly and still access metadata
    res.json(sessionMsgs.map(m => ({
      role: m.role,
      content: m.content,         // already-parsed answer text (set below in /api/chat)
      raw_content: m.raw_content || m.content, // full original JSON from AI
      bloom_level: m.bloom_level,
      bloom_label: m.bloom_label || '',
      thinking_insight: m.thinking_insight || '',
      challenge_question: m.challenge_question || '',
      created_at: m.created_at
    })));
  } catch (error) {
    console.error('Get messages error:', error);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// ════════════════════════════════════════
// METRICS
// ════════════════════════════════════════
app.get('/api/metrics', authenticate, async (req, res) => {
  try {
    if (!db) return res.json({});
    const userMetrics = await metrics.findOne({ user_id: new ObjectId(req.userId) });
    
    // 🔧 FIX: Ensure all expected fields exist with defaults for frontend compatibility
    res.json({
      _id: userMetrics?._id,
      depth: userMetrics?.depth || 0,
      assumptions: userMetrics?.assumptions || 0,
      counterargument: userMetrics?.counterargument || 0,
      evidence: userMetrics?.evidence || 0,
      clarity: userMetrics?.clarity || 0,
      bloom_remember: userMetrics?.bloom_remember || 0,
      bloom_understand: userMetrics?.bloom_understand || 0,
      bloom_apply: userMetrics?.bloom_apply || 0,
      bloom_analyse: userMetrics?.bloom_analyse || 0,
      bloom_evaluate: userMetrics?.bloom_evaluate || 0,
      bloom_create: userMetrics?.bloom_create || 0,
      total_messages: userMetrics?.total_messages || 0,  // ← Critical for frontend usageStats
      total_sessions: userMetrics?.total_sessions || 0,   // ← Critical for frontend usageStats
      active_days: userMetrics?.active_days || []
    });
  } catch (error) {
    console.error('Get metrics error:', error);
    res.status(500).json({ error: 'Failed to fetch metrics' });
  }
});

// FIX 3: New endpoint to return activity days from MongoDB
app.get('/api/activity', authenticate, async (req, res) => {
  try {
    if (!db) return res.json({ active_days: [] });
    const userMetrics = await metrics.findOne({ user_id: new ObjectId(req.userId) });
    res.json({ active_days: userMetrics?.active_days || [] });
  } catch (error) {
    console.error('Get activity error:', error);
    res.status(500).json({ error: 'Failed to fetch activity' });
  }
});

// ════════════════════════════════════════
// RESOURCES & CONCEPTS
// ════════════════════════════════════════
app.get('/api/resources', authenticate, async (req, res) => {
  try {
    if (!db) return res.json([]);
    const userResources = await db.collection('resources').find({ user_id: new ObjectId(req.userId) })
      .sort({ created_at: -1 })
      .limit(50)
      .toArray();
    res.json(userResources);
  } catch (error) {
    console.error('Get resources error:', error);
    res.status(500).json({ error: 'Failed to fetch resources' });
  }
});

app.get('/api/concepts', authenticate, async (req, res) => {
  try {
    if (!db) return res.json([]);
    const userConcepts = await db.collection('concepts').find({ user_id: new ObjectId(req.userId) })
      .sort({ created_at: -1 })
      .toArray();
    res.json(userConcepts.map(c => c.concept));
  } catch (error) {
    console.error('Get concepts error:', error);
    res.status(500).json({ error: 'Failed to fetch concepts' });
  }
});

// ════════════════════════════════════════
// GOALS
// ════════════════════════════════════════
app.get('/api/goals', authenticate, async (req, res) => {
  try {
    if (!db) return res.json([]);
    const userGoals = await goals.find({ user_id: new ObjectId(req.userId) })
      .sort({ created_at: -1 })
      .toArray();
    res.json(userGoals.map(g => ({
      id: g._id.toString(),
      session_id: g.session_id,
      goal: g.goal,
      created_at: g.created_at
    })));
  } catch (error) {
    console.error('Get goals error:', error);
    res.status(500).json({ error: 'Failed to fetch goals' });
  }
});

app.post('/api/goals', authenticate, async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'Database not available' });

    const { goal, session_id } = req.body;

    if (!session_id) {
      return res.status(400).json({ error: 'session_id is required' });
    }

    const ownedSession = await getOwnedSession(session_id, req.userId);
    if (!ownedSession) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const now = new Date();
    const result = await goals.insertOne({
      user_id: new ObjectId(req.userId),
      session_id,
      goal: goal || '',
      created_at: now
    });

    res.json({
      id: result.insertedId.toString(),
      session_id,
      goal: goal || '',
      created_at: now
    });
  } catch (error) {
    console.error('Create goal error:', error);
    res.status(500).json({ error: 'Failed to create goal' });
  }
});

app.get('/api/sessions/:id/goal', authenticate, async (req, res) => {
  try {
    if (!db) return res.json(null);
    const goal = await goals.findOne({ session_id: req.params.id, user_id: new ObjectId(req.userId) });
    res.json(goal ? { goal: goal.goal, created_at: goal.created_at } : null);
  } catch (error) {
    console.error('Get session goal error:', error);
    res.status(500).json({ error: 'Failed to fetch session goal' });
  }
});

// ════════════════════════════════════════
// GENERATE TITLE
// ════════════════════════════════════════
app.post('/api/sessions/:id/generate-title', authenticate, async (req, res) => {
  try {
    if (!db) return res.json({ title: 'New Chat' });

    const ownedSession = await getOwnedSession(req.params.id, req.userId);
    if (!ownedSession) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const sessionMsgs = await messages.find({ session_id: req.params.id })
      .sort({ created_at: 1 })
      .toArray();

    // FIX 1: Use content field (parsed answer) not raw JSON for title generation
    const conversationText = sessionMsgs
      .filter(m => m.role === 'user')
      .slice(0, 5)
      .map(m => m.content)
      .join(' ');

    if (!conversationText) {
      return res.json({ title: 'New Chat' });
    }

    const goal = await goals.findOne({ session_id: req.params.id, user_id: new ObjectId(req.userId) });
    const goalContext = goal ? ` with goal: ${goal.goal}` : '';

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`
      },
      body: JSON.stringify({
        model: process.env.OPENROUTER_MODEL || 'google/gemini-2.0-flash-001',
        messages: [{
          role: 'user',
          content: `Based on this conversation topic and goal${goalContext}, generate a short title (max 40 characters) for this chat. Return ONLY the title, no quotes or explanation.\n\nConversation preview: ${conversationText.substring(0, 300)}`
        }],
        max_tokens: 50,
        temperature: 0.3
      })
    });

    const data = await response.json();
    let title = data.choices?.[0]?.message?.content?.trim() || 'New Chat';
    title = title.replace(/^["']|["']$/g, '').substring(0, 40);

    await sessions.updateOne(
      { _id: ownedSession._id, user_id: new ObjectId(req.userId) },
      { $set: { title } }
    );

    res.json({ title });
  } catch (error) {
    console.error('Generate title error:', error);
    res.json({ title: 'New Chat' });
  }
});

// ════════════════════════════════════════
// STARTER QUESTIONS
// ════════════════════════════════════════
app.get('/api/starter-questions', authenticate, async (req, res) => {
  try {
    if (!db) {
      return res.json({ questions: getDefaultStarters() });
    }

    const userId = new ObjectId(req.userId);

    const userConcepts = await db.collection('concepts').find({ user_id: userId }).toArray();
    const recentSessions = await sessions.find({ user_id: userId }).sort({ updated_at: -1 }).limit(5).toArray();
    const recentMessages = await messages.find({
      session_id: { $in: recentSessions.map(s => s._id.toString()) }
    }).sort({ created_at: -1 }).limit(20).toArray();

    const topics = [];
    recentMessages.forEach(m => {
      if (m.role === 'user') {
        const words = m.content.split(/\s+/).slice(0, 10).join(' ');
        if (words) topics.push(words);
      }
    });

    const interests = userConcepts.slice(0, 5).map(c => c.concept);

    const prompt = `You are ThinkIA, an AI critical thinking coach. Generate 5 thought-provoking starter questions for a critical thinking conversation.
${interests.length > 0 ? `The user has shown interest in these topics: ${interests.join(', ')}.` : ''}
${topics.length > 0 ? `Recent conversation themes: ${topics.slice(0, 3).join('. ')}` : ''}

Generate questions that:
1. Encourage critical thinking and analysis
2. Cover different domains (philosophy, science, ethics, society, etc.)
3. Range from beginner to advanced thinking levels
4. Are engaging and thought-provoking

Return ONLY valid JSON array of strings (no explanation, no backticks):
["question 1", "question 2", "question 3", "question 4", "question 5"]`;

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`
      },
      body: JSON.stringify({
        model: process.env.OPENROUTER_MODEL || 'google/gemini-2.0-flash-001',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 500,
        temperature: 0.8
      })
    });

    if (!response.ok) {
      console.error('OpenRouter API error for starter questions:', await response.text());
      return res.json({ questions: getDefaultStarters() });
    }

    const data = await response.json();
    let content = data.choices?.[0]?.message?.content || '[]';

    content = content.replace(/```json|```/g, '').trim();
    let questions = JSON.parse(content);

    if (!Array.isArray(questions) || questions.length < 3) {
      questions = getDefaultStarters();
    }

    res.json({ questions });
  } catch (error) {
    console.error('Generate starter questions error:', error);
    res.json({ questions: getDefaultStarters() });
  }
});

function getDefaultStarters() {
  return [
    "What makes an argument logically sound versus emotionally persuasive?",
    "How do cognitive biases affect our decision-making?",
    "Should we prioritize collective good over individual freedom?",
    "What role does evidence play in forming beliefs?",
    "How can we think more critically about information we consume daily?"
  ];
}

// ════════════════════════════════════════
// CHAT — main endpoint
// ════════════════════════════════════════
app.post('/api/chat', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    let userId = null;
    let userIdObj = null;

    if (authHeader && authHeader.startsWith('Bearer ')) {
      try {
        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, JWT_SECRET);
        userId = decoded.userId;
        userIdObj = new ObjectId(userId);
      } catch (e) {
        // Invalid token — continue without saving
      }
    }

    const { messages: chatMsgs, system, max_tokens, session_id } = req.body;
    const trackedMetricKeys = ['depth', 'assumptions', 'counterargument', 'evidence', 'clarity'];

    if (!chatMsgs || !Array.isArray(chatMsgs)) {
      return res.status(400).json({ error: 'messages array is required' });
    }

    if (!process.env.OPENROUTER_API_KEY) {
      return res.status(500).json({ error: 'API key not configured' });
    }

    let ownedSession = null;
    if (db && userId && session_id) {
      ownedSession = await getOwnedSession(session_id, userId);
    }

    // Save the user's message to MongoDB
    let savedUserMessageId = null;
    if (db && userId && session_id && ownedSession) {
      const lastMsg = chatMsgs[chatMsgs.length - 1];
      if (lastMsg && lastMsg.role === 'user') {
        const savedUserMessage = await messages.insertOne({
          user_id: userIdObj,
          session_id,
          role: 'user',
          content: normalizeMessageContent(lastMsg.content),
          bloom_level: null,
          created_at: new Date()
        });
        savedUserMessageId = savedUserMessage.insertedId;

        await sessions.updateOne(
          { _id: ownedSession._id, user_id: userIdObj },
          { $set: { updated_at: new Date() } }
        );

        // 🔧 FIX: Properly increment total_messages AND bloom fields
        const updateOps = { $inc: { total_messages: 1 } };
        
        if (savedUserMessageId) {
          // Bloom level will be set after AI response
        }
        
        await metrics.updateOne({ user_id: userIdObj }, updateOps);

        // FIX 3: Track this as an active day in the database
        await trackActiveDay(userIdObj);
      }
    }

    // Build messages for OpenRouter
    const openrouterMessages = [];
    if (system && system.trim()) {
      openrouterMessages.push({ role: 'system', content: system });
    }
    for (const msg of chatMsgs) {
      const normalizedContent = normalizeMessageContent(msg.content).trim();
      if (!normalizedContent) continue;
      openrouterMessages.push({
        role: msg.role === 'assistant' ? 'assistant' : 'user',
        content: normalizedContent
      });
    }

    const model = process.env.OPENROUTER_MODEL || 'google/gemini-2.0-flash-001';

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'http://localhost:3000',
        'X-Title': 'ThinkIA'
      },
      body: JSON.stringify({
        model,
        messages: openrouterMessages,
        max_tokens: max_tokens || 1200,
        temperature: 0.7
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('OpenRouter API error:', data);
      return res.status(response.status).json({ error: data.error?.message || 'OpenRouter API error' });
    }

    const rawText = data.choices?.[0]?.message?.content || '';

    // FIX 1: Parse the AI response to extract structured fields
    const parsed = parseAIResponse(rawText);

    const resolvedBloomLevel = parsed.bloom_level;
    const resolvedMetrics = {};
    if (parsed.metrics && typeof parsed.metrics === 'object') {
      for (const [key, value] of Object.entries(parsed.metrics)) {
        const numericValue = Number(value);
        if (trackedMetricKeys.includes(key) && Number.isFinite(numericValue) && numericValue !== 0) {
          resolvedMetrics[key] = numericValue;
        }
      }
    }

    // Save the assistant message to MongoDB
    if (db && userId && session_id && ownedSession) {
      if (savedUserMessageId && resolvedBloomLevel) {
        await messages.updateOne(
          { _id: savedUserMessageId, user_id: userIdObj },
          { $set: { bloom_level: resolvedBloomLevel } }
        );
      }

      // 🔧 FIX: Properly increment bloom fields with correct field names
      if (resolvedBloomLevel && resolvedBloomLevel >= 1 && resolvedBloomLevel <= 6) {
        const bloomFieldMap = {
          1: 'bloom_remember',
          2: 'bloom_understand', 
          3: 'bloom_apply',
          4: 'bloom_analyse',
          5: 'bloom_evaluate',
          6: 'bloom_create'
        };
        await metrics.updateOne(
          { user_id: userIdObj }, 
          { $inc: { [bloomFieldMap[resolvedBloomLevel]]: 1 } }
        );
      }

      if (Object.keys(resolvedMetrics).length > 0) {
        await metrics.updateOne({ user_id: userIdObj }, { $inc: resolvedMetrics });
      }

      // FIX 1: Save content as the clean answer text, and raw_content as the full JSON
      // This means when messages are loaded back, content is already display-ready
      await messages.insertOne({
        user_id: userIdObj,
        session_id,
        role: 'assistant',
        content: parsed.answer,           // ← clean answer text for display
        raw_content: rawText,             // ← full JSON for metadata (bloom, metrics, etc.)
        bloom_level: resolvedBloomLevel,
        bloom_label: parsed.bloom_label,
        thinking_insight: parsed.thinking_insight,
        challenge_question: parsed.challenge_question,
        created_at: new Date()
      });

      if (parsed.concepts.length > 0) {
        const conceptsCollection = db.collection('concepts');
        for (const concept of parsed.concepts) {
          await conceptsCollection.updateOne(
            { user_id: userIdObj, concept },
            { $setOnInsert: { user_id: userIdObj, concept, created_at: new Date() } },
            { upsert: true }
          );
        }
      }

      if (parsed.resources.length > 0) {
        const resourcesCollection = db.collection('resources');
        for (const resource of parsed.resources) {
          const exists = await resourcesCollection.findOne({ user_id: userIdObj, title: resource.title });
          if (!exists) {
            await resourcesCollection.insertOne({
              user_id: userIdObj,
              ...resource,
              created_at: new Date()
            });
          }
        }
      }
    }

    // FIX 1: Return the raw text so the frontend can do its own parsing too
    // (keeps frontend normalizeAIResponse working as a fallback)
    res.json({
      content: [{ type: 'text', text: rawText }],
      model,
      role: 'assistant'
    });

  } catch (error) {
    console.error('Server error:', error);
    res.status(500).json({ error: 'Internal server error: ' + error.message });
  }
});

// ════════════════════════════════════════
// START SERVER
// ════════════════════════════════════════
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`✅ ThinkIA backend running on port ${PORT}`);
    console.log(`   OpenRouter model: ${process.env.OPENROUTER_MODEL || 'google/gemini-2.0-flash-001'}`);
    console.log(`   MongoDB: ${MONGODB_URI}`);
  });
});