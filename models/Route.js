const mongoose = require('mongoose');


const routeSchema = new mongoose.Schema({
  username: { type: String, required: true },
  name: { type: String, required: true },
  description: String,
  destination: String,
  type: { type: String, enum: ['hike', 'bike'] },
  pathEncoded: { type: String, required: true },
  pathDaysEncoded: { type: [String], default: [] },
  isSaved: { type: Boolean, default: false },
  savedAt: { type: Date, default: null },
  lastViewedAt: { type: Date, default: Date.now }
}, { timestamps: true });

// Add indexes for efficient querying
routeSchema.index({ username: 1, isSaved: 1 });
routeSchema.index({ username: 1, lastViewedAt: -1 });
routeSchema.index({ username: 1, savedAt: -1 });


module.exports = mongoose.model('Route', routeSchema); 