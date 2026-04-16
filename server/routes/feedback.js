const express = require('express');
const { ObjectId } = require('mongodb');
const { getDb } = require('../db/mongo');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.post('/', requireAuth, async (req, res) => {
  const { taskId, rating, comment } = req.body || {};
  const rNum = Number(rating);
  if (!taskId || !Number.isFinite(rNum) || rNum < 1 || rNum > 5) {
    return res.status(400).json({ error: 'Invalid fields' });
  }
  const db = getDb();
  const task = await db.collection('tasks').findOne({ _id: new ObjectId(taskId) });
  if (!task) return res.status(404).json({ error: 'Task not found' });
  if (task.status !== 'Completed') return res.status(400).json({ error: 'Task not completed' });
  const me = String(req.user.userId);
  const requesterId = String(task.requesterId);
  const helperId = String(task.helperId);
  if (![requesterId, helperId].includes(me)) return res.status(403).json({ error: 'Only participants can give feedback' });

  const againstUser = me === requesterId ? helperId : requesterId;
  const doc = {
    taskId: String(taskId),
    rating: rNum,
    comment: comment ? String(comment).trim() : '',
    givenBy: me,
    againstUser,
    createdAt: new Date(),
  };

  try {
    const ins = await db.collection('feedback').insertOne(doc);
    const saved = await db.collection('feedback').findOne({ _id: ins.insertedId });

    // update rated user's rating (simple average)
    const agg = await db.collection('feedback').aggregate([
      { $match: { againstUser } },
      { $group: { _id: '$againstUser', avg: { $avg: '$rating' }, count: { $sum: 1 } } },
    ]).toArray();

    if (agg[0]?.avg != null) {
      await db.collection('users').updateOne(
        { _id: new ObjectId(againstUser) },
        { $set: { rating: Number(agg[0].avg.toFixed(2)) } },
      );
    }

    await db.collection('notifications').insertOne({
      userId: againstUser,
      message: 'You received feedback for a completed task.',
      read: false,
      createdAt: new Date(),
    });

    return res.json({ feedback: saved });
  } catch (e) {
    if (String(e?.code) === '11000') return res.status(409).json({ error: 'Feedback already submitted' });
    return res.status(500).json({ error: 'Failed to submit feedback' });
  }
});

router.get('/task/:taskId', requireAuth, async (req, res) => {
  const db = getDb();
  const taskId = String(req.params.taskId);
  const task = await db.collection('tasks').findOne({ _id: new ObjectId(taskId) });
  if (!task) return res.status(404).json({ error: 'Task not found' });
  const me = String(req.user.userId);
  const requesterId = String(task.requesterId);
  const helperId = String(task.helperId);
  if (![requesterId, helperId].includes(me)) return res.status(403).json({ error: 'Forbidden' });

  const feedback = await db.collection('feedback').find({ taskId }).sort({ createdAt: -1 }).toArray();
  
  // Populate user details
  const userIds = [...new Set(feedback.map(f => [f.givenBy, f.againstUser]).flat())];
  const users = await db.collection('users').find({ _id: { $in: userIds.map(id => new ObjectId(id)) } }).toArray();
  const userMap = users.reduce((acc, user) => {
    acc[String(user._id)] = { name: user.name, email: user.email };
    return acc;
  }, {});
  
  const feedbackWithUsers = feedback.map(f => ({
    ...f,
    givenByUser: userMap[f.givenBy] || { name: 'Unknown', email: 'Unknown' },
    againstUserUser: userMap[f.againstUser] || { name: 'Unknown', email: 'Unknown' }
  }));
  
  const myFeedback = feedbackWithUsers.find((f) => String(f.givenBy) === me) || null;
  return res.json({ feedback: feedbackWithUsers, myFeedback });
});

module.exports = router;
