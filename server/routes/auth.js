const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { ObjectId } = require('mongodb');
const { getDb } = require('../db/mongo');

const router = express.Router();

function safeUser(u) {
  if (!u) return null;
  const { password, ...rest } = u;
  return { ...rest, _id: String(u._id) };
}


function sha256Hex(input) {
  return crypto.createHash('sha256').update(String(input)).digest('hex');
}

function getResetTtlMs() {
  const minutes = Number(process.env.RESET_TOKEN_TTL_MINUTES || 30);
  if (!Number.isFinite(minutes) || minutes <= 0) return 30 * 60 * 1000;
  return minutes * 60 * 1000;
}

function isDemoShowResetLinkEnabled() {
  const v = String(process.env.DEMO_SHOW_RESET_LINK || '').toLowerCase();
  return v === 'true' || v === '1' || v === 'yes';
}

router.post('/register', async (req, res) => {
  const { name, email, password, location, pincode } = req.body || {};
  if (!name || !email || !password || !pincode) return res.status(400).json({ error: 'Missing fields' });
  if (!/^\d{6}$/.test(String(pincode).trim())) return res.status(400).json({ error: 'Invalid pincode' });
  const normalizedEmail = String(email).trim().toLowerCase();

  const db = getDb();
  const users = db.collection('users');

  const hashed = await bcrypt.hash(String(password), 10);
  const now = new Date();

  try {
    const doc = {
      name: String(name).trim(),
      email: normalizedEmail,
      password: hashed,
      location: location ? String(location).trim() : '',
      pincode: String(pincode).trim(),
      rating: 0,
      isAdmin: false,
      isBanned: false,
      onboarded: false,
      skills: [],
      createdAt: now,
    };
    const r = await users.insertOne(doc);
    const user = await users.findOne({ _id: r.insertedId });
    return res.json({ user: safeUser(user) });
  } catch (e) {
    if (String(e?.code) === '11000') return res.status(409).json({ error: 'Email already registered' });
    return res.status(500).json({ error: 'Failed to register' });
  }
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Missing fields' });

  const db = getDb();
  const users = db.collection('users');
  const user = await users.findOne({ email: String(email).trim().toLowerCase() });
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  if (user.isBanned) return res.status(403).json({ error: 'You are banned from the platform' });

  if (user.resetTokenHash && user.resetTokenExpiresAt && new Date(user.resetTokenExpiresAt) < new Date()) {
    await users.updateOne(
      { _id: user._id },
      { $unset: { resetTokenHash: '', resetTokenExpiresAt: '' } },
    );
  }

  const ok = await bcrypt.compare(String(password), user.password);
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

  const token = jwt.sign(
    { userId: String(user._id), isAdmin: Boolean(user.isAdmin) },
    process.env.JWT_SECRET,
    { expiresIn: '7d' },
  );
  return res.json({ token, user: safeUser(user) });
});

router.get('/me', async (req, res) => {
  const auth = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (!m) return res.status(401).json({ error: 'Missing token' });
  try {
    const payload = jwt.verify(m[1], process.env.JWT_SECRET);
    const db = getDb();
    const user = await db.collection('users').findOne({ _id: new ObjectId(payload.userId) });
    return res.json({ user: safeUser(user) });
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
});

router.patch('/me', async (req, res) => {
  const auth = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (!m) return res.status(401).json({ error: 'Missing token' });
  try {
    const payload = jwt.verify(m[1], process.env.JWT_SECRET);
    const { name, location, pincode, skills, onboarded, avatar } = req.body || {};
    const updates = {};
    if (typeof name === 'string') updates.name = name.trim();
    if (typeof location === 'string') updates.location = location.trim();
    if (typeof pincode === 'string') {
      const pin = pincode.trim();
      if (pin && !/^\d{6}$/.test(pin)) return res.status(400).json({ error: 'Invalid pincode' });
      updates.pincode = pin;
    }
    if (Array.isArray(skills)) {
      updates.skills = skills.map(s => String(s).trim()).filter(Boolean);
    }
    if (typeof onboarded === 'boolean') updates.onboarded = onboarded;
    if (typeof avatar === 'string') {
      if (avatar.startsWith('data:image/') || avatar.startsWith('http')) {
        updates.avatar = avatar;
      }
    }

    const db = getDb();
    await db.collection('users').updateOne(
      { _id: new ObjectId(payload.userId) },
      { $set: updates },
    );
    const user = await db.collection('users').findOne({ _id: new ObjectId(payload.userId) });
    return res.json({ user: safeUser(user) });
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
});

// Forgot password: generates a time-limited reset token (stored hashed in DB).
// In production you would email the link; in demo mode we return the link in response.
router.post('/forgot', async (req, res) => {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: 'Email is required' });

  const db = getDb();
  const users = db.collection('users');
  const normalizedEmail = String(email).trim().toLowerCase();
  const user = await users.findOne({ email: normalizedEmail });

  // Always return ok to avoid email enumeration.
  if (!user) return res.json({ ok: true });

  const rawToken = crypto.randomBytes(32).toString('hex');
  const resetTokenHash = sha256Hex(rawToken);
  const resetTokenExpiresAt = new Date(Date.now() + getResetTtlMs());

  await users.updateOne(
    { _id: user._id },
    { $set: { resetTokenHash, resetTokenExpiresAt } },
  );

  if (isDemoShowResetLinkEnabled()) {
    return res.json({ ok: true, resetLink: `/reset-password.html?token=${rawToken}` });
  }
  return res.json({ ok: true });
});

router.post('/reset', async (req, res) => {
  const { token, newPassword } = req.body || {};
  if (!token || !newPassword) return res.status(400).json({ error: 'Missing fields' });
  if (String(newPassword).length < 6) return res.status(400).json({ error: 'Password too short' });

  const db = getDb();
  const users = db.collection('users');

  const resetTokenHash = sha256Hex(token);
  const user = await users.findOne({ resetTokenHash });
  if (!user) return res.status(400).json({ error: 'Invalid or expired token' });
  if (!user.resetTokenExpiresAt || new Date(user.resetTokenExpiresAt) < new Date()) {
    await users.updateOne(
      { _id: user._id },
      { $unset: { resetTokenHash: '', resetTokenExpiresAt: '' } },
    );
    return res.status(400).json({ error: 'Invalid or expired token' });
  }

  const hashed = await bcrypt.hash(String(newPassword), 10);
  await users.updateOne(
    { _id: user._id },
    { $set: { password: hashed }, $unset: { resetTokenHash: '', resetTokenExpiresAt: '' } },
  );

  return res.json({ ok: true });
});

module.exports = router;
