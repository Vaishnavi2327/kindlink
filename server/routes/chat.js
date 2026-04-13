const express = require('express');
const { ObjectId } = require('mongodb');
const { getDb } = require('../db/mongo');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// ── Helpers ──────────────────────────────────────────────────────────────────

async function ensureTaskAccess(db, taskId, userId) {
  let task;
  try {
    task = await db.collection('tasks').findOne({ _id: new ObjectId(taskId) });
  } catch {
    return { ok: false, error: 'Invalid task id', status: 400 };
  }
  if (!task) return { ok: false, error: 'Task not found', status: 404 };
  const allowed = [String(task.requesterId), String(task.helperId)].includes(String(userId));
  if (!allowed) return { ok: false, error: 'Forbidden', status: 403 };
  return { ok: true, task };
}

async function ensureRequestAccess(db, requestId, userId) {
  let request;
  try {
    request = await db.collection('requests').findOne({ _id: new ObjectId(requestId) });
  } catch {
    return { ok: false, error: 'Invalid request id', status: 400 };
  }
  if (!request) return { ok: false, error: 'Request not found', status: 404 };
  const acceptedBy = Array.isArray(request.acceptedBy) ? request.acceptedBy.map((x) => String(x)) : [];
  const allowed = String(request.postedBy) === String(userId) || acceptedBy.includes(String(userId));
  if (!allowed) return { ok: false, error: 'Forbidden', status: 403 };
  return { ok: true, request };
}

// ── Request-based (group) chat ── MUST come before /:taskId routes ──────────

router.get('/request/:requestId/messages', requireAuth, async (req, res) => {
  const { requestId } = req.params;
  const since = req.query?.since ? new Date(String(req.query.since)) : null;

  const db = getDb();
  const access = await ensureRequestAccess(db, requestId, req.user.userId);
  if (!access.ok) return res.status(access.status).json({ error: access.error });

  const filter = { requestId: String(requestId) };
  if (since && !Number.isNaN(since.getTime())) filter.timestamp = { $gt: since };

  const messages = await db
    .collection('chat')
    .find(filter)
    .sort({ timestamp: 1 })
    .limit(500)
    .toArray();

  return res.json({ messages });
});

router.post('/request/:requestId/messages', requireAuth, async (req, res) => {
  const { requestId } = req.params;
  const { message } = req.body || {};
  if (!message || !String(message).trim()) return res.status(400).json({ error: 'Message is required' });

  const db = getDb();
  const access = await ensureRequestAccess(db, requestId, req.user.userId);
  if (!access.ok) return res.status(access.status).json({ error: access.error });

  const sender = await db.collection('users').findOne(
    { _id: new ObjectId(req.user.userId) },
    { projection: { name: 1 } },
  );

  const doc = {
    requestId: String(requestId),
    senderId: String(req.user.userId),
    senderName: sender?.name || 'User',
    message: String(message).trim(),
    timestamp: new Date(),
  };
  const r = await db.collection('chat').insertOne(doc);
  const saved = await db.collection('chat').findOne({ _id: r.insertedId });
  return res.json({ message: saved });
});

// ── Task-based (1-to-1) chat ─────────────────────────────────────────────────

router.get('/:taskId/messages', requireAuth, async (req, res) => {
  const { taskId } = req.params;
  const since = req.query?.since ? new Date(String(req.query.since)) : null;

  const db = getDb();
  const access = await ensureTaskAccess(db, taskId, req.user.userId);
  if (!access.ok) return res.status(access.status).json({ error: access.error });

  const filter = { taskId: String(taskId) };
  if (since && !Number.isNaN(since.getTime())) filter.timestamp = { $gt: since };

  const messages = await db
    .collection('chat')
    .find(filter)
    .sort({ timestamp: 1 })
    .limit(500)
    .toArray();

  return res.json({ messages });
});

router.post('/:taskId/messages', requireAuth, async (req, res) => {
  const { taskId } = req.params;
  const { message } = req.body || {};
  if (!message || !String(message).trim()) return res.status(400).json({ error: 'Message is required' });

  const db = getDb();
  const access = await ensureTaskAccess(db, taskId, req.user.userId);
  if (!access.ok) return res.status(access.status).json({ error: access.error });

  const sender = await db.collection('users').findOne(
    { _id: new ObjectId(req.user.userId) },
    { projection: { name: 1 } },
  );

  const doc = {
    taskId: String(taskId),
    senderId: String(req.user.userId),
    senderName: sender?.name || 'User',
    message: String(message).trim(),
    timestamp: new Date(),
  };
  const r = await db.collection('chat').insertOne(doc);
  const saved = await db.collection('chat').findOne({ _id: r.insertedId });
  return res.json({ message: saved });
});

module.exports = router;
