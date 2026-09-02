const express = require('express');
const mongoose = require('mongoose');

const app = express();
const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/appdb';

app.use(express.json());

let isReady = false;
let dbConnected = false;

mongoose.connect(MONGO_URI)
  .then(() => {
    dbConnected = true;
    isReady = true;
    console.log('MongoDB connected');
  })
  .catch((err) => {
    console.error('MongoDB connection error:', err.message);
    // isReady stays false -> readiness probe fails -> pod not sent traffic
  });

const Item = mongoose.model('Item', new mongoose.Schema({
  name: String,
  createdAt: { type: Date, default: Date.now }
}));

// --- Health endpoints used by k8s / ALB probes ---

// Liveness: is the process alive at all? Keep this cheap and dependency-free
// so a slow DB doesn't cause Kubernetes to kill a perfectly good pod.
app.get('/live', (req, res) => {
  res.status(200).json({ status: 'alive' });
});

// Readiness: is the app actually able to serve traffic (DB connected)?
app.get('/health', (req, res) => {
  if (isReady && dbConnected) {
    return res.status(200).json({ status: 'ok', db: 'connected' });
  }
  return res.status(503).json({ status: 'not ready', db: dbConnected ? 'connected' : 'disconnected' });
});

// --- App routes ---

app.get('/', (req, res) => {
  res.json({ message: 'Auto-Healing MERN API', pod: process.env.HOSTNAME || 'local' });
});

app.get('/items', async (req, res) => {
  try {
    const items = await Item.find().limit(50);
    res.json(items);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/items', async (req, res) => {
  try {
    const item = await Item.create({ name: req.body.name });
    res.status(201).json(item);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Deliberate failure endpoint for demonstrating self-healing ---
// Hitting this flips readiness off and then kills the process after a delay,
// so you can record the liveness probe restarting the pod.
app.post('/crash', (req, res) => {
  console.log('Crash endpoint triggered - simulating failure');
  isReady = false;
  res.json({ message: 'Crashing in 2 seconds...' });
  setTimeout(() => process.exit(1), 2000);
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

module.exports = app;
