

const express = require('express');
const { ObjectId } = require('mongodb');
const { getDb } = require('../db/mongo');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

function parseVolunteersNeeded(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 1;
  if (n < 1) return 1;
  return Math.floor(n);
}

router.post('/', requireAuth, async (req, res) => {
  const { title, description, category, location, pincode, urgency, volunteersNeeded, deadline } = req.body || {};
  if (!title || !description || !pincode) return res.status(400).json({ error: 'Missing fields' });
  if (!/^\d{6}$/.test(String(pincode).trim())) return res.status(400).json({ error: 'Invalid pincode' });

  const db = getDb();
  const now = new Date();
  const needed = parseVolunteersNeeded(volunteersNeeded);
  const doc = {
    title: String(title).trim(),
    description: String(description).trim(),
    category: category ? String(category).trim() : 'General',
    location: location ? String(location).trim() : '',
    pincode: String(pincode).trim(),
    urgency: urgency ? String(urgency).trim() : 'Medium',
    volunteersNeeded: needed,
    deadline: deadline ? new Date(deadline) : null,
    status: 'Open',
    postedBy: String(req.user.userId),
    acceptedBy: [],
    createdAt: now,
  };
  const r = await db.collection('requests').insertOne(doc);
  const request = await db.collection('requests').findOne({ _id: r.insertedId });
  return res.json({ request });
});

router.get('/', requireAuth, async (req, res) => {
  const { status, category, location, q } = req.query || {};
  const filter = { status: { $nin: ['Full', 'Completed'] } };
  if (status) filter.status = String(status);
  if (category) filter.category = String(category);
  if (location) filter.location = String(location);
  if (q) filter.title = { $regex: String(q), $options: 'i' };

  const db = getDb();
  const requests = await db
    .collection('requests')
    .find(filter)
    .sort({ pinned: -1, createdAt: -1 })
    .limit(200)
    .toArray();

  return res.json({ requests });
});

router.get('/mine', requireAuth, async (req, res) => {
  const db = getDb();
  const requests = await db
    .collection('requests')
    .find({ postedBy: String(req.user.userId) })
    .sort({ createdAt: -1 })
    .limit(200)
    .toArray();
  return res.json({ requests });
});

router.get('/:id', requireAuth, async (req, res) => {
  const db = getDb();
  const requestIdObj = new ObjectId(req.params.id);
  const request = await db.collection('requests').findOne({ _id: requestIdObj });
  if (!request) return res.status(404).json({ error: 'Request not found' });

  const userId = String(req.user.userId);
  const acceptedBy = Array.isArray(request.acceptedBy) ? request.acceptedBy : [];
  const allowed = String(request.postedBy) === userId || acceptedBy.includes(userId);
  if (!allowed) return res.status(403).json({ error: 'Forbidden' });

  const tasks = await db
    .collection('tasks')
    .find({ requestId: String(request._id) })
    .project({ requestId: 1, requesterId: 1, helperId: 1, status: 1, acceptedAt: 1, completedAt: 1 })
    .sort({ acceptedAt: 1 })
    .toArray();

  // Fetch helper user info (name, email, rating) for all accepted volunteers
  const helperIds = [...new Set(acceptedBy)];
  const helpers = await Promise.all(helperIds.map(async (hid) => {
    try {
      const u = await db.collection('users').findOne(
        { _id: new ObjectId(hid) },
        { projection: { name: 1, email: 1, rating: 1 } }
      );
      return u ? { _id: String(u._id), name: u.name, email: u.email, rating: u.rating ?? 0 } : null;
    } catch { return null; }
  }));

  return res.json({ request, tasks, helpers: helpers.filter(Boolean) });
});

router.delete('/:id', requireAuth, async (req, res) => {
  const db = getDb();
  const requestIdObj = new ObjectId(req.params.id);
  const userId = String(req.user.userId);

  const request = await db.collection('requests').findOne({ _id: requestIdObj });
  if (!request) return res.status(404).json({ error: 'Request not found' });
  if (String(request.postedBy) !== userId) return res.status(403).json({ error: 'Forbidden' });

  const acceptedCount = Array.isArray(request.acceptedBy) ? request.acceptedBy.length : 0;
  if (acceptedCount > 0) return res.status(400).json({ error: 'Cannot delete: volunteers already accepted' });

  const taskCount = await db.collection('tasks').countDocuments({ requestId: String(request._id) });
  if (taskCount > 0) return res.status(400).json({ error: 'Cannot delete: tasks already created' });

  await db.collection('requests').deleteOne({ _id: requestIdObj, postedBy: userId });
  return res.json({ ok: true });
});

router.post('/:id/accept', requireAuth, async (req, res) => {
  const requestId = req.params.id;
  const db = getDb();
  const requests = db.collection('requests');
  const tasks = db.collection('tasks');

  const now = new Date();
  const currentUserId = String(req.user.userId);
  const requestIdObj = new ObjectId(requestId);

  // First check the current state of the request
  const reqDoc = await requests.findOne({ _id: requestIdObj });
  if (!reqDoc) return res.status(404).json({ error: 'Request not found' });
  if (String(reqDoc.postedBy) === currentUserId) return res.status(400).json({ error: 'Cannot accept your own request' });
  if (reqDoc.status === 'Completed') return res.status(400).json({ error: 'Request already completed' });

  const acceptedBy = Array.isArray(reqDoc.acceptedBy) ? reqDoc.acceptedBy : [];
  const volunteersNeeded = parseVolunteersNeeded(reqDoc.volunteersNeeded);
  const alreadyInAcceptedBy = acceptedBy.includes(currentUserId);

  // Check if task already exists for this user + request
  const existingTask = await tasks.findOne({ requestId: String(reqDoc._id), helperId: currentUserId });

  // STALE STATE RECOVERY: user is in acceptedBy but task was never created (due to previous bug)
  // → create the missing task now and return success
  if (alreadyInAcceptedBy && !existingTask) {
    const task = {
      requestId: String(reqDoc._id),
      requesterId: String(reqDoc.postedBy),
      helperId: currentUserId,
      status: 'In Progress',
      availabilityNote: req.body?.availabilityNote ? String(req.body.availabilityNote).trim() : '',
      stepStatus: 'accepted',
      acceptedAt: now,
      completedAt: null,
    };
    const tr = await tasks.insertOne(task);
    const createdTask = await tasks.findOne({ _id: tr.insertedId });
    return res.json({ task: createdTask, request: reqDoc });
  }

  // Already properly accepted with an existing task
  if (alreadyInAcceptedBy && existingTask) {
    return res.status(400).json({ error: 'Already accepted by you' });
  }

  // Check capacity
  if (reqDoc.status === 'Full' || acceptedBy.length >= volunteersNeeded) {
    return res.status(400).json({ error: 'Request is already full' });
  }

  // Atomic accept: only one update wins when capacity is tight.
  const updated = await requests.findOneAndUpdate(
    {
      _id: requestIdObj,
      status: { $nin: ['Full', 'Completed'] },
      postedBy: { $ne: currentUserId },
      acceptedBy: { $ne: currentUserId },
      $expr: {
        $lt: [
          { $size: { $ifNull: ['$acceptedBy', []] } },
          {
            $let: {
              vars: { vn: { $ifNull: ['$volunteersNeeded', 1] } },
              in: {
                $cond: [
                  { $and: [{ $isNumber: '$$vn' }, { $gt: ['$$vn', 0] }] },
                  '$$vn',
                  1,
                ],
              },
            },
          },
        ],
      },
    },
    [
      {
        $set: {
          acceptedBy: { $concatArrays: [{ $ifNull: ['$acceptedBy', []] }, [currentUserId]] },
        },
      },
      {
        $set: {
          status: {
            $let: {
              vars: { vn: { $ifNull: ['$volunteersNeeded', 1] } },
              in: {
                $let: {
                  vars: {
                    needed: {
                      $cond: [
                        { $and: [{ $isNumber: '$$vn' }, { $gt: ['$$vn', 0] }] },
                        '$$vn',
                        1,
                      ],
                    },
                    accepted: { $size: '$acceptedBy' },
                  },
                  in: {
                    $cond: [
                      { $gte: ['$$accepted', '$$needed'] },
                      'Full',
                      { $cond: [{ $gt: ['$$accepted', 0] }, 'In Progress', 'Open'] },
                    ],
                  },
                },
              },
            },
          },
        },
      },
    ],
    { returnDocument: 'after' },
  );

  if (!updated) {
    return res.status(400).json({ error: 'Could not accept request — it may be full or already completed.' });
  }

  const task = {
    requestId: String(updated._id),
    requesterId: String(updated.postedBy),
    helperId: currentUserId,
    status: 'In Progress',
    availabilityNote: req.body?.availabilityNote ? String(req.body.availabilityNote).trim() : '',
    stepStatus: 'accepted',
    acceptedAt: now,
    completedAt: null,
  };

  const tr = await tasks.insertOne(task);
  const createdTask = await tasks.findOne({ _id: tr.insertedId });

  await db.collection('notifications').insertMany([
    {
      userId: String(updated.postedBy),
      message: `Your request "${updated.title}" was accepted`,
      read: false,
      createdAt: now,
    },
    {
      userId: currentUserId,
      message: `You accepted "${updated.title}"`,
      read: false,
      createdAt: now,
    },
  ]);

  return res.json({ task: createdTask, request: updated });
});


router.post('/:id/leave', requireAuth, async (req, res) => {

  const requestId = req.params.id;
  const db = getDb();
  const requests = db.collection('requests');
  const tasks = db.collection('tasks');

  const requestIdObj = new ObjectId(requestId);
  const userId = String(req.user.userId);

  const reqDoc = await requests.findOne({ _id: requestIdObj });
  if (!reqDoc) return res.status(404).json({ error: 'Request not found' });
  if (String(reqDoc.postedBy) === userId) return res.status(400).json({ error: 'Requester cannot leave own request' });
  if (reqDoc.status === 'Completed') return res.status(400).json({ error: 'Request already completed' });

  const acceptedBy = Array.isArray(reqDoc.acceptedBy) ? reqDoc.acceptedBy : [];
  if (!acceptedBy.includes(userId)) return res.status(400).json({ error: 'You have not accepted this request' });

  const task = await tasks.findOne({ requestId: String(reqDoc._id), helperId: userId });
  if (task?.status === 'Completed') return res.status(400).json({ error: 'Cannot leave after completing' });

  // Remove acceptance + delete their task (if any), then recalc request status.
  await tasks.deleteOne({ requestId: String(reqDoc._id), helperId: userId });
  await requests.updateOne({ _id: requestIdObj }, { $pull: { acceptedBy: userId } });

  const updatedReq = await requests.findOne({ _id: requestIdObj });
  const updatedAccepted = Array.isArray(updatedReq?.acceptedBy) ? updatedReq.acceptedBy.length : 0;
  const needed = parseVolunteersNeeded(updatedReq?.volunteersNeeded);
  const nextStatus =
    updatedAccepted >= needed ? 'Full' :
      (updatedAccepted > 0 ? 'In Progress' : 'Open');

  await requests.updateOne({ _id: requestIdObj }, { $set: { status: nextStatus } });

  await db.collection('notifications').insertOne({
    userId: String(updatedReq.postedBy),
    message: `A volunteer left your request "${updatedReq.title}".`,
    read: false,
    createdAt: new Date(),
  });

  const finalReq = await requests.findOne({ _id: requestIdObj });
  return res.json({ ok: true, request: finalReq });
});

// Flag a request as suspicious
router.post('/:id/flag', requireAuth, async (req, res) => {
  const db = getDb();
  const reqDoc = await db.collection('requests').findOne({ _id: new ObjectId(req.params.id) });
  if (!reqDoc) return res.status(404).json({ error: 'Request not found' });

  const userId = String(req.user.userId);
  const flags = Array.isArray(reqDoc.flaggedBy) ? reqDoc.flaggedBy : [];
  if (flags.includes(userId)) return res.status(400).json({ error: 'Already flagged by you' });

  const newFlags = [...flags, userId];
  const autoHide = newFlags.length >= 3;
  await db.collection('requests').updateOne(
    { _id: new ObjectId(req.params.id) },
    { $set: { flagged: true, flaggedBy: newFlags, ...(autoHide ? { status: 'Flagged' } : {}) } },
  );
  return res.json({ ok: true, flagCount: newFlags.length, autoHidden: autoHide });
});

module.exports = router;
