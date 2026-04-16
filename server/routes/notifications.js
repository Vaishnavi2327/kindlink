const express = require('express');
const { ObjectId } = require('mongodb');
const { getDb } = require('../db/mongo');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.get('/', requireAuth, async (req, res) => {
  const db = getDb();
  const userId = String(req.user.userId);
  const notifications = await db
    .collection('notifications')
    .find({ userId })
    .sort({ createdAt: -1 })
    .limit(100)
    .toArray();
  return res.json({ notifications });
});

router.post('/:id/read', requireAuth, async (req, res) => {
  const db = getDb();
  const userId = String(req.user.userId);
  const id = req.params.id;
  await db.collection('notifications').updateOne(
    { _id: new ObjectId(id), userId },
    { $set: { read: true } },
  );
  return res.json({ ok: true });
});

module.exports = router;
