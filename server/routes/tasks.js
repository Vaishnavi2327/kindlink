

const express = require('express');
const { ObjectId } = require('mongodb');
const { getDb } = require('../db/mongo');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// ── Helpers ──────────────────────────────────────────────────────────────────

function safeObjectId(id) {
  try { return new ObjectId(id); } catch { return null; }
}

// ── IMPORTANT: Static routes MUST be defined before /:id ────────────────────

// GET /api/tasks/mine
// Self-healing: detects requests where user is in acceptedBy but task was never
// created (stale state from the MongoDB driver v7 bug), and creates missing tasks.
router.get('/mine', requireAuth, async (req, res) => {
  const db = getDb();
  const userId = String(req.user.userId);

  // 1. Find all requests where user is in acceptedBy (the source of truth for Browse)
  const acceptedRequests = await db
    .collection('requests')
    .find({ acceptedBy: userId })
    .project({ _id: 1, title: 1, postedBy: 1, status: 1 })
    .toArray();

  // 2. Find existing tasks for this user as helper
  const existingTasks = await db
    .collection('tasks')
    .find({ helperId: userId })
    .toArray();

  const existingTaskRequestIds = new Set(existingTasks.map(t => t.requestId));

  // 3. For every accepted request that has NO task → create the missing task (stale recovery)
  for (const req of acceptedRequests) {
    const reqId = String(req._id);
    if (!existingTaskRequestIds.has(reqId)) {
      try {
        await db.collection('tasks').insertOne({
          requestId: reqId,
          requesterId: String(req.postedBy),
          helperId: userId,
          status: 'In Progress',
          availabilityNote: '',
          stepStatus: 'accepted',
          acceptedAt: new Date(),
          completedAt: null,
        });
      } catch { /* ignore duplicate key errors */ }
    }
  }

  // 4. Fetch all tasks for this user (as requester OR helper) — now complete
  const allTasks = await db
    .collection('tasks')
    .find({ $or: [{ requesterId: userId }, { helperId: userId }] })
    .sort({ acceptedAt: -1 })
    .limit(200)
    .toArray();

  // 5. Enrich with request title and other-user name/email/rating
  const enriched = await Promise.all(allTasks.map(async (t) => {
    let requestTitle = '';
    try {
      const oid = safeObjectId(t.requestId);
      if (oid) {
        const reqDoc = await db.collection('requests').findOne(
          { _id: oid },
          { projection: { title: 1 } }
        );
        requestTitle = reqDoc?.title || '';
      }
    } catch {}

    const otherUserId = String(t.helperId) === userId ? t.requesterId : t.helperId;
    let otherUser = null;
    try {
      const oid = safeObjectId(otherUserId);
      if (oid) {
        const u = await db.collection('users').findOne(
          { _id: oid },
          { projection: { name: 1, email: 1, rating: 1 } }
        );
        if (u) otherUser = { name: u.name, email: u.email, rating: u.rating ?? 0 };
      }
    } catch {}

    return { ...t, requestTitle, otherUser };
  }));

  return res.json({ tasks: enriched });
});

// GET /api/tasks/history/completed
router.get('/history/completed', requireAuth, async (req, res) => {
  const db = getDb();
  const userId = String(req.user.userId);
  const tasks = await db
    .collection('tasks')
    .find({
      status: 'Completed',
      $or: [{ requesterId: userId }, { helperId: userId }],
    })
    .sort({ completedAt: -1 })
    .limit(200)
    .toArray();
  return res.json({ tasks });
});

// GET /api/tasks/:id
router.get('/:id', requireAuth, async (req, res) => {
  const db = getDb();
  const oid = safeObjectId(req.params.id);
  if (!oid) return res.status(400).json({ error: 'Invalid task id' });

  const task = await db.collection('tasks').findOne({ _id: oid });
  if (!task) return res.status(404).json({ error: 'Task not found' });

  const userId = String(req.user.userId);
  if (![String(task.requesterId), String(task.helperId)].includes(userId)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const reqOid = safeObjectId(task.requestId);
  const request = reqOid ? await db.collection('requests').findOne({ _id: reqOid }) : null;
  return res.json({ task, request });
});

// POST /api/tasks/:id/complete
router.post('/:id/complete', requireAuth, async (req, res) => {
  const db = getDb();
  const tasksCol = db.collection('tasks');
  const requestsCol = db.collection('requests');

  const oid = safeObjectId(req.params.id);
  if (!oid) return res.status(400).json({ error: 'Invalid task id' });

  const task = await tasksCol.findOne({ _id: oid });
  if (!task) return res.status(404).json({ error: 'Task not found' });
  if (task.status === 'Completed') return res.status(400).json({ error: 'Task already completed' });

  const userId = String(req.user.userId);
  if (String(task.helperId) !== userId) return res.status(403).json({ error: 'Only the helper can mark complete' });

  const now = new Date();
  await tasksCol.updateOne({ _id: task._id }, { $set: { status: 'Completed', completedAt: now } });

  // Recalculate request status
  const reqOid = safeObjectId(task.requestId);
  if (reqOid) {
    const requestDoc = await requestsCol.findOne({ _id: reqOid });
    const pendingCount = await tasksCol.countDocuments({ requestId: task.requestId, status: { $ne: 'Completed' } });
    const acceptedCount = Array.isArray(requestDoc?.acceptedBy) ? requestDoc.acceptedBy.length : 0;
    const needed = Math.max(1, Number(requestDoc?.volunteersNeeded || 1));
    const nextStatus = pendingCount === 0 && acceptedCount >= needed
      ? 'Completed'
      : (acceptedCount >= needed ? 'Full' : (acceptedCount > 0 ? 'In Progress' : 'Open'));
    await requestsCol.updateOne({ _id: reqOid }, { $set: { status: nextStatus } });

    await db.collection('notifications').insertOne({
      userId: String(task.requesterId),
      message: 'A task you requested was marked completed. Please leave feedback.',
      read: false,
      createdAt: now,
    });
  }

  const updated = await tasksCol.findOne({ _id: task._id });
  return res.json({ task: updated });
});

module.exports = router;
