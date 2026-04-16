/**
 * Public stats + volunteer leaderboard
 * GET /api/stats          — community impact counters (public, no auth)
 * GET /api/stats/leaderboard — top 8 volunteers by completed tasks
 */
const express = require('express');
const { getDb } = require('../db/mongo');
const router = express.Router();
// Public impact counters
router.get('/', async (_req, res) => {
  try {
    const db = getDb();
    const [totalRequests, completedTasks, totalUsers] = await Promise.all([
      db.collection('requests').countDocuments({}),
      db.collection('tasks').countDocuments({ status: 'Completed' }),
      db.collection('users').countDocuments({ isAdmin: { $ne: true } }),
    ]);
    const volunteerHours = completedTasks * 2; // avg 2 hrs per task estimate
    return res.json({ totalRequests, completedTasks, totalUsers, volunteerHours });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Volunteer leaderboard
router.get('/leaderboard', async (_req, res) => {
  try {
    const db = getDb();
    const rows = await db.collection('tasks').aggregate([
      { $match: { status: 'Completed', helperId: { $exists: true, $ne: null } } },
      { $group: { _id: '$helperId', completedCount: { $sum: 1 } } },
      { $sort: { completedCount: -1 } },
      { $limit: 8 },
    ]).toArray();

    // Fetch user names + ratings
    const { ObjectId } = require('mongodb');
    const enriched = await Promise.all(rows.map(async (row) => {
      try {
        const user = await db.collection('users').findOne(
          { _id: new ObjectId(String(row._id)) },
          { projection: { name: 1, rating: 1, pincode: 1, location: 1, skills: 1 } },
        );
        if (!user) return null;
        return {
          userId: String(row._id),
          name: user.name,
          rating: user.rating || 0,
          location: user.location || '',
          skills: user.skills || [],
          completedCount: row.completedCount,
        };
      } catch { return null; }
    }));

    return res.json({ leaderboard: enriched.filter(Boolean) });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
