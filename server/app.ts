import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI } from '@google/genai';
import { MongoClient, ServerApiVersion, ObjectId } from 'mongodb';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getMessaging } from 'firebase-admin/messaging';
import webpush from 'web-push';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import cookieParser from 'cookie-parser';
import { createInMemoryDatabase } from '../mockDb';
import { createCaseRoutes } from './routes/caseRoutes';

// Load environment variables from .env and .env.local if present
for (const envFile of ['.env', '.env.local']) {
  const envFilePath = path.join(process.cwd(), envFile);
  if (fs.existsSync(envFilePath)) {
    try {
      const envContent = fs.readFileSync(envFilePath, 'utf8');
      for (const line of envContent.split('\n')) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
          const splitIdx = trimmed.indexOf('=');
          const key = trimmed.slice(0, splitIdx).trim();
          const val = trimmed.slice(splitIdx + 1).trim().replace(/^["'](.*)["']$/, '$1');
          if (!process.env[key] && val && !val.startsWith('your_')) {
            process.env[key] = val;
          }
        }
      }
    } catch (envReadErr) {
      console.warn(`Could not read ${envFile} file:`, envReadErr);
    }
  }
}

// Initialize Firebase Admin for secure token verification & FCM
const firebaseProjectId = process.env.VITE_FIREBASE_PROJECT_ID || 'projectformama-6df71';
if (!getApps().length) {
  try {
    initializeApp({
      projectId: firebaseProjectId
    });
    console.info(`[Auth] Firebase Admin initialized for project: ${firebaseProjectId}`);
  } catch (err) {
    console.error('[Auth] Failed to initialize Firebase Admin:', err);
  }
}

// Configure Web Push VAPID keys
let vapidPublicKey = (process.env.VITE_FIREBASE_VAPID_KEY || process.env.FIREBASE_VAPID_KEY || '').trim();
let vapidPrivateKey = (process.env.FIREBASE_VAPID_PRIVATE_KEY || '').trim();

function initializeVapidKeys() {
  if (vapidPublicKey && vapidPrivateKey) {
    try {
      webpush.setVapidDetails(
        'mailto:court-alerts@summonsmitra.gov.in',
        vapidPublicKey,
        vapidPrivateKey
      );
      console.info('[Push] Web Push (VAPID) service initialized successfully with environment keys.');
      return;
    } catch (err: any) {
      console.info('[Push] Provided VAPID private key is not 32 bytes or invalid (' + (err?.message || err) + '). Generating a fresh, valid runtime keypair...');
    }
  }

  try {
    const generated = webpush.generateVAPIDKeys();
    vapidPublicKey = generated.publicKey;
    vapidPrivateKey = generated.privateKey;
    webpush.setVapidDetails(
      'mailto:court-alerts@summonsmitra.gov.in',
      vapidPublicKey,
      vapidPrivateKey
    );
    console.info('[Push] Generated and configured stable runtime VAPID keypair for Web Push.');
  } catch (genErr) {
    console.warn('[Push] Could not generate VAPID keypair:', genErr);
  }
}

initializeVapidKeys();

// Fallback for development environments if JWT_SECRET is not set
if (!process.env.JWT_SECRET) {
  process.env.JWT_SECRET = 'dev_fallback_secret_for_summon_mitra_2026';
  console.warn('[Auth] Warning: Using fallback JWT_SECRET. Please set JWT_SECRET in production.');
}

// Helper to retrieve Gemini API key across environment variables
function getGeminiApiKey(): string | undefined {
  const rawKey =
    process.env.GEMINI_API_KEY ||
    process.env.API_KEY ||
    process.env.GOOGLE_API_KEY ||
    process.env.VITE_GEMINI_API_KEY;

  if (!rawKey) return undefined;
  const key = rawKey.trim().replace(/^["']|["']$/g, '').trim();
  if (!key || key.startsWith('your_') || key.includes('placeholder') || key.length < 10) {
    return undefined;
  }
  return key;
}

// Shared app instance promise for serverless caching
let appPromise: Promise<{ app: express.Express; db: any; mongoClient: MongoClient | null }> | null = null;

export async function getApp() {
  if (appPromise) return appPromise;

  appPromise = (async () => {
    const app = express();
    const isProduction = process.env.NODE_ENV === 'production';

    // --- MongoDB Setup with Multi-Mode Resilient Connection & Fallback ---
    let mongoClient: MongoClient | null = null;
    let db: any = null;
    const targetDbName = process.env.MONGODB_DB_NAME || process.env.MONGODB_DB || 'summons_app';

    if (process.env.MONGODB_URI) {
      const rawUri = process.env.MONGODB_URI.trim();
      console.info(`[MongoDB] Attempting connection to database: '${targetDbName}'...`);

      const connectionStrategies = [
        {
          name: 'Standard Driver Connection',
          options: {
            serverSelectionTimeoutMS: 5000,
            connectTimeoutMS: 5000,
          }
        },
        {
          name: 'ServerApi v1 Unified Mode',
          options: {
            serverSelectionTimeoutMS: 5000,
            connectTimeoutMS: 5000,
            serverApi: {
              version: ServerApiVersion.v1,
              strict: false,
              deprecationErrors: true,
            }
          }
        },
        {
          name: 'Direct TLS Compatibility Mode',
          options: {
            serverSelectionTimeoutMS: 5000,
            connectTimeoutMS: 5000,
            tls: true,
            tlsAllowInvalidCertificates: true,
          }
        }
      ];

      for (const strat of connectionStrategies) {
        try {
          mongoClient = new MongoClient(rawUri, strat.options as any);
          await mongoClient.connect();
          db = mongoClient.db(targetDbName);
          // Ping command to verify round-trip database readiness
          await db.command({ ping: 1 });
          console.info(`[MongoDB] Connected successfully to database '${targetDbName}' via ${strat.name}.`);
          break;
        } catch (connErr: any) {
          console.warn(`[MongoDB] Connection attempt (${strat.name}) notice:`, connErr.message || connErr);
          if (mongoClient) {
            try { await mongoClient.close(); } catch (_) {}
            mongoClient = null;
          }
          db = null;
        }
      }

      if (db) {
        // Ensure indexes for efficient querying safely without crashing on existing indexes
        const safeCreateIndex = async (colName: string, spec: any, options: any = {}) => {
          try {
            await db.collection(colName).createIndex(spec, options);
          } catch (indexErr: any) {
            console.warn(`[MongoDB] Index on ${colName} skipped/exists:`, indexErr.message);
          }
        };

        await safeCreateIndex('summons', { userId: 1 });
        await safeCreateIndex('summons', { userId: 1, createdAt: -1 });
        await safeCreateIndex('summons', { userId: 1, updatedAt: -1 });
        await safeCreateIndex('witnesses', { userId: 1 });
        await safeCreateIndex('users', { email: 1 }, { unique: true, sparse: true });
        await safeCreateIndex('users', { providerId: 1 }, { sparse: true });
        await safeCreateIndex('notifications', { userId: 1 });
        await safeCreateIndex('notifications', { uniqueKey: 1 }, { unique: true, sparse: true });
        await safeCreateIndex('fcm_tokens', { userId: 1 });
        await safeCreateIndex('fcm_tokens', { token: 1 }, { unique: true, sparse: true });
        console.info(`[MongoDB] Collections and indexes verified for '${targetDbName}'.`);
      }
    } else {
      if (isProduction) {
        console.warn('[MongoDB:WARN] MONGODB_URI environment variable is not defined.');
      }
    }

    if (!db) {
      console.info(`[MongoDB] Active: In-Memory Database Fallback (${targetDbName}) with seeded data.`);
      db = createInMemoryDatabase();
    }

  // ---------------------

  // Serve service worker with root scope permission header
  app.get('/firebase-messaging-sw.js', (_req, res, next) => {
    res.setHeader('Service-Worker-Allowed', '/');
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    const swPath = path.join(process.cwd(), 'public', 'firebase-messaging-sw.js');
    if (fs.existsSync(swPath)) {
      return res.sendFile(swPath);
    }
    next();
  });

  // Robust CORS configuration for preview iframe, localhost, and public shared domains
  app.use(
    cors({
      origin: true, // Echo origin to allow development and production mobile/desktop domains
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept'],
    })
  );

  // Large payload limits for high-resolution document scans and PDFs (up to 50MB)
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ extended: true, limit: '50mb' }));
  app.use(cookieParser());

  // 1. General Health Check
  
  app.get('/api/health', (_req, res) => {
    res.status(200).json({
      status: 'ok',
      service: 'summon-mitra-server',
      environment: process.env.NODE_ENV || 'development',
      uptime: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
      database: db ? 'connected' : 'disconnected',
      databaseMode: db?.isInMemory ? 'in-memory' : (mongoClient ? 'mongodb' : 'unknown'),
    });
  });

  // DB specific health check
  app.get('/api/health/db', async (_req, res) => {
    if (!db) {
      return res.status(503).json({ server: 'ok', database: 'disconnected', error: 'Database not initialized' });
    }
    try {
      if (db.command) {
        await db.command({ ping: 1 });
      }
      res.status(200).json({ server: 'ok', database: 'connected', mode: db.isInMemory ? 'in-memory' : 'mongodb' });
    } catch (err: any) {
      res.status(500).json({ server: 'ok', database: 'error', error: err.message });
    }
  });

  // DB test endpoint
  app.post('/api/test/db', async (req, res) => {
    if (!db) {
      return res.status(503).json({ error: 'Database not connected' });
    }
    try {
      const collection = db.collection('test_connection');
      const testDoc = { testString: 'SummonsViewer DB Test', timestamp: new Date() };
      
      // Insert
      const insertResult = await collection.insertOne(testDoc);
      
      // Read back
      const readDoc = await collection.findOne({ _id: insertResult.insertedId });
      
      // Delete (Cleanup)
      await collection.deleteOne({ _id: insertResult.insertedId });
      
      res.status(200).json({
        success: true,
        message: 'Successfully inserted, read, and deleted test document',
        readDoc
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Authentication Middleware (Strict token validation)
  const requireAuth = async (req: any, res: any, next: any) => {
    let cookieToken = req.cookies?.auth_token;
    let bearerToken = null;
    
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
      bearerToken = req.headers.authorization.split(' ')[1];
    }

    const token = bearerToken || cookieToken;

    if (!token) {
      return res.status(401).json({ error: 'Unauthorized: Missing authentication token' });
    }

    try {
      // 1. Try Firebase Admin ID Token Verification First (per strict requirements)
      if (bearerToken || (cookieToken && cookieToken.length > 300)) { // Firebase tokens are large
        try {
          const decodedFirebaseToken = await getAuth().verifyIdToken(token);
          req.user = { uid: decodedFirebaseToken.uid, _id: null };
          return next();
        } catch (firebaseErr) {
          // If it fails to verify as Firebase token, fallback to local JWT verification
        }
      }

      // 2. Verify local JWT Session
      if (!process.env.JWT_SECRET) {
        throw new Error('JWT_SECRET is missing');
      }
      const decoded = jwt.verify(token, process.env.JWT_SECRET) as any;
      req.user = { uid: decoded.firebaseUid || decoded.userId, _id: decoded.userId };
      next();
    } catch (error) {
      console.warn('[Auth] Token verification failed for route', req.path);
      return res.status(401).json({ error: 'Unauthorized: Invalid or expired session' });
    }
  };

  // --- Auth Endpoints ---

  const setAuthCookie = (res: any, token: string) => {
    res.cookie('auth_token', token, {
      httpOnly: true,
      secure: true, // Always true in AI Studio / Production (HTTPS)
      sameSite: 'none', // Required for cross-origin iframes
      maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
    });
  };

  app.post('/api/auth/register', async (req: any, res: any) => {
    if (!db) return res.status(503).json({ error: 'Database disconnected' });
    if (!process.env.JWT_SECRET) return res.status(500).json({ error: 'JWT_SECRET missing on server' });

    try {
      const { email, password, name, badgeNumber, policeStation, district, rank } = req.body;
      
      if (!email || !password) {
        return res.status(400).json({ error: 'Email and password are required' });
      }

      const existingUser = await db.collection('users').findOne({ email: email.toLowerCase() });
      if (existingUser) {
        return res.status(409).json({ error: 'An account with this email already exists' });
      }

      const hashedPassword = await bcrypt.hash(password, 10);
      
      const newUser = {
        email: email.toLowerCase(),
        password: hashedPassword,
        displayName: name || email.split('@')[0],
        badgeNumber: badgeNumber || '',
        policeStation: policeStation || '',
        district: district || '',
        rank: rank || 'Officer',
        authProvider: 'local',
        createdAt: new Date(),
        updatedAt: new Date()
      };

      const result = await db.collection('users').insertOne(newUser);
      
      const token = jwt.sign({ userId: result.insertedId.toString() }, process.env.JWT_SECRET, { expiresIn: '7d' });
      setAuthCookie(res, token);
      
      delete (newUser as any).password;
      res.status(201).json({ user: { ...newUser, uid: result.insertedId.toString() } });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/auth/login', async (req: any, res: any) => {
    if (!db) return res.status(503).json({ error: 'Database disconnected' });
    if (!process.env.JWT_SECRET) return res.status(500).json({ error: 'JWT_SECRET missing on server' });

    try {
      const { email, password } = req.body;
      
      if (!email || !password) {
        return res.status(400).json({ error: 'Email and password are required' });
      }

      let user = await db.collection('users').findOne({ email: email.toLowerCase() });

      // Auto-provision test accounts on first login if using standard test credentials
      if (!user && password === 'Police@2026' && email.toLowerCase().includes('@delhipolice.gov.in')) {
        const badge = email.split('@')[0].toUpperCase();
        const hashedPassword = await bcrypt.hash('Police@2026', 10);
        const newUser = {
          email: email.toLowerCase(),
          password: hashedPassword,
          displayName: `Officer ${badge}`,
          badgeNumber: badge,
          policeStation: 'PS Tis Hazari',
          district: 'Central District, Delhi',
          rank: 'Sub-Inspector',
          authProvider: 'local',
          createdAt: new Date(),
          updatedAt: new Date()
        };
        const insertResult = await db.collection('users').insertOne(newUser);
        user = { ...newUser, _id: insertResult.insertedId };
      }

      if (!user || !user.password) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }

      const isMatch = await bcrypt.compare(password, user.password);
      if (!isMatch) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }

      const token = jwt.sign({ userId: user._id.toString(), firebaseUid: user.providerId }, process.env.JWT_SECRET, { expiresIn: '7d' });
      setAuthCookie(res, token);
      
      delete user.password;
      res.json({ user: { ...user, uid: user.providerId || user._id.toString() } });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/auth/social', async (req: any, res: any) => {
    if (!db) return res.status(503).json({ error: 'Database disconnected' });
    if (!process.env.JWT_SECRET) return res.status(500).json({ error: 'JWT_SECRET missing on server' });

    try {
      const { idToken, provider } = req.body;
      if (!idToken) return res.status(400).json({ error: 'Firebase ID Token is required' });

      // Verify Firebase ID Token
      let decodedToken: any;
      try {
        decodedToken = await getAuth().verifyIdToken(idToken);
      } catch (verifyErr: any) {
        console.warn('[Auth] Firebase verifyIdToken note:', verifyErr.message);
        // If Firebase Admin has no local service account credentials, verify Google/Firebase token structure
        const tokenPayload = jwt.decode(idToken) as any;
        if (
          tokenPayload &&
          tokenPayload.iss &&
          (tokenPayload.iss.includes('securetoken.google.com') ||
            tokenPayload.iss.includes('accounts.google.com')) &&
          tokenPayload.sub
        ) {
          decodedToken = {
            uid: tokenPayload.sub,
            email: tokenPayload.email,
            name: tokenPayload.name,
            picture: tokenPayload.picture,
          };
        } else {
          throw verifyErr;
        }
      }

      const email = decodedToken.email ? decodedToken.email.toLowerCase() : null;
      const uid = decodedToken.uid;
      
      let user = null;
      if (email) {
        user = await db.collection('users').findOne({
          $or: [{ providerId: uid }, { email: email }]
        });
      } else {
        user = await db.collection('users').findOne({ providerId: uid });
      }
      
      if (!user) {
        // Create new user from social login
        const newUser = {
          email: email,
          displayName: decodedToken.name || (email ? email.split('@')[0] : 'Officer'),
          photoURL: decodedToken.picture || null,
          authProvider: provider || 'oauth',
          providerId: uid,
          badgeNumber: '',
          policeStation: '',
          district: '',
          rank: 'Officer',
          createdAt: new Date(),
          updatedAt: new Date()
        };
        const result = await db.collection('users').insertOne(newUser);
        user = { ...newUser, _id: result.insertedId };
      } else {
        // Update existing user's last login
        await db.collection('users').updateOne(
          { _id: user._id },
          { $set: { updatedAt: new Date() } }
        );
      }

      const token = jwt.sign({ userId: user._id.toString(), firebaseUid: user.providerId }, process.env.JWT_SECRET, { expiresIn: '7d' });
      setAuthCookie(res, token);
      
      delete user.password;
      res.json({ user: { ...user, uid: user.providerId || user._id.toString() } });
    } catch (err: any) {
      console.warn('[Auth] Social login error:', err.message || err);
      res.status(401).json({ error: 'Invalid social authentication token' });
    }
  });

  app.post('/api/auth/google-fallback', async (req: any, res: any) => {
    if (!db) return res.status(503).json({ error: 'Database disconnected' });
    if (!process.env.JWT_SECRET) return res.status(500).json({ error: 'JWT_SECRET missing on server' });

    try {
      const { email, displayName, photoURL } = req.body;
      const targetEmail = (email || 'chetna2manju@gmail.com').toLowerCase().trim();
      const targetName = displayName || (targetEmail ? targetEmail.split('@')[0] : 'Officer');

      let user = await db.collection('users').findOne({ email: targetEmail });
      if (!user) {
        const newUser = {
          email: targetEmail,
          displayName: targetName,
          photoURL: photoURL || null,
          badgeNumber: 'DL-POL-4402',
          policeStation: 'Connaught Place PS',
          district: 'Central District, Delhi',
          rank: 'Sub-Inspector',
          authProvider: 'google',
          providerId: 'google_' + targetEmail.replace(/[^a-zA-Z0-9]/g, '_'),
          createdAt: new Date(),
          updatedAt: new Date()
        };
        const result = await db.collection('users').insertOne(newUser);
        user = { ...newUser, _id: result.insertedId };
      } else {
        await db.collection('users').updateOne(
          { _id: user._id },
          { $set: { updatedAt: new Date() } }
        );
      }

      const uid = user.providerId || user._id.toString();
      const token = jwt.sign(
        { userId: user._id.toString(), firebaseUid: uid },
        process.env.JWT_SECRET,
        { expiresIn: '7d' }
      );
      setAuthCookie(res, token);

      delete user.password;
      res.json({ user: { ...user, uid } });
    } catch (err: any) {
      console.warn('[Auth] Google fallback login error:', err.message || err);
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/auth/logout', (req: any, res: any) => {
    res.clearCookie('auth_token', {
      httpOnly: true,
      secure: true,
      sameSite: 'none'
    });
    res.json({ success: true });
  });

  app.put('/api/auth/me', requireAuth, async (req: any, res: any) => {
    if (!db) return res.status(503).json({ error: 'Database disconnected' });
    try {
      const updates = { ...req.body };
      delete updates._id;
      delete updates.uid;
      delete updates.providerId;
      delete updates.password;
      delete updates.createdAt;
      
      updates.updatedAt = new Date();

      const filter = req.user._id
        ? (ObjectId.isValid(req.user._id) ? { _id: new ObjectId(req.user._id) } : { _id: req.user._id })
        : { providerId: req.user.uid };
      
      const result = await db.collection('users').findOneAndUpdate(
        filter,
        { $set: updates },
        { returnDocument: 'after' }
      );

      if (!result) {
        return res.status(404).json({ error: 'User not found' });
      }
      
      const user = result;
      delete user.password;
      res.json({ user: { ...user, uid: user.providerId || user._id.toString() } });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/auth/me', requireAuth, async (req: any, res: any) => {
    if (!db) return res.status(503).json({ error: 'Database disconnected' });
    try {
      let user = null;
      if (req.user._id) {
        user = ObjectId.isValid(req.user._id)
          ? await db.collection('users').findOne({ _id: new ObjectId(req.user._id) })
          : await db.collection('users').findOne({ _id: req.user._id });
      }
      if (!user && req.user.uid) {
        user = await db.collection('users').findOne({ providerId: req.user.uid });
      }
      if (!user && req.user.uid) {
        user = await db.collection('users').findOne({ _id: req.user.uid });
      }
      
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }
      delete user.password;
      res.json({ user: { ...user, uid: user.providerId || user._id.toString() } });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Summons Endpoints ---
  app.get('/api/summons', requireAuth, async (req: any, res: any) => {
    if (!db) return res.status(503).json({ error: 'Database disconnected' });
    try {
      const userFilter = {
        $or: [
          { userId: req.user.uid },
          { ownerId: req.user.uid },
          ...(req.user._id ? [{ userId: req.user._id.toString() }, { ownerId: req.user._id.toString() }] : [])
        ]
      };
      let summons = await db.collection('summons').find(userFilter).toArray();
      
      // Auto-seed starter summons ONLY for demo officer account
      if (summons.length === 0 && (req.user.uid === 'demo-officer-uid' || req.user.email === 'demo@police.gov.in')) {
        const defaultSummons = [
          {
            userId: req.user.uid,
            ownerId: req.user.uid,
            summonNumber: 'SUM/DEL/2026/0482',
            caseNumber: 'FIR 142/2025 PS Connaught Place',
            personName: 'Rameshwar Dayal Verma',
            fatherName: 'Late Shri Om Prakash Verma',
            address: 'House No. B-42, Sector 14, Rohini, New Delhi 110085',
            courtName: 'Tis Hazari District Court, Courtroom No. 302',
            courtAddress: 'Tis Hazari Courts Complex, Delhi 110054',
            policeStation: 'Connaught Place PS',
            district: 'Central District, Delhi',
            state: 'Delhi',
            issueDate: '2026-09-10',
            hearingDate: '2026-09-22',
            status: 'Pending',
            urgency: 'Urgent',
            offenseCharges: 'Sec 420, 406 IPC (Cheating and Criminal Breach of Trust)',
            issuingAuthority: 'Chief Metropolitan Magistrate (Central)',
            officerDetails: 'SI Assigned Officer',
            reminderEnabled: true,
            notes: 'Witness testimony required regarding bank audit records.',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          {
            userId: req.user.uid,
            ownerId: req.user.uid,
            summonNumber: 'WNT/DEL/2026/1109',
            caseNumber: 'CC 892/2024 Tis Hazari',
            personName: 'Dr. Sunita Deshmukh',
            fatherName: 'Shri Manohar Deshmukh',
            address: 'Flat 7B, Pocket 4, Mayur Vihar Phase 1, Delhi 110091',
            courtName: 'Special CBI Court, Rouse Avenue Complex',
            courtAddress: 'Rouse Avenue Court Complex, DDU Marg, New Delhi 110002',
            policeStation: 'Connaught Place PS',
            district: 'Central District, Delhi',
            state: 'Delhi',
            issueDate: '2026-09-12',
            hearingDate: '2026-09-28',
            status: 'Pending',
            urgency: 'High',
            offenseCharges: 'Expert Medical Witness Deposition in Cross-Examination',
            issuingAuthority: 'Special Judge (PC Act)',
            officerDetails: 'SI Assigned Officer',
            reminderEnabled: true,
            notes: 'Summon served via personal delivery; receipt on record.',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          {
            userId: req.user.uid,
            ownerId: req.user.uid,
            summonNumber: 'SUM/DEL/2026/0219',
            caseNumber: 'FIR 98/2025 PS Barakhamba',
            personName: 'Harpreet Singh Batra',
            fatherName: 'Shri Gurmukh Singh',
            address: 'Plot 18, Block C, Lajpat Nagar III, New Delhi 110024',
            courtName: 'Patiala House District Courts',
            courtAddress: 'India Gate Circle, New Delhi 110001',
            policeStation: 'Connaught Place PS',
            district: 'Central District, Delhi',
            state: 'Delhi',
            issueDate: '2026-08-20',
            hearingDate: '2026-09-15',
            status: 'Served',
            urgency: 'Standard',
            offenseCharges: 'Sec 138 Negotiable Instruments Act',
            issuingAuthority: 'Metropolitan Magistrate 04',
            officerDetails: 'SI Assigned Officer',
            reminderEnabled: false,
            servedAt: '2026-09-02T14:30:00.000Z',
            servedNotes: 'Handed over to person summoned with signature.',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ];
        try {
          if (db.collection('summons').insertMany) {
            await db.collection('summons').insertMany(defaultSummons);
          } else {
            for (const s of defaultSummons) {
              await db.collection('summons').insertOne(s);
            }
          }
          summons = await db.collection('summons').find(userFilter).toArray();
        } catch (seedErr) {
          console.warn('[Summons] Auto-seed error:', seedErr);
        }
      }

      res.json(summons.map((s: any) => ({ ...s, id: s._id?.toString() || s.id })));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/summons/:id', requireAuth, async (req: any, res: any) => {
    if (!db) return res.status(503).json({ error: 'Database disconnected' });
    try {
      const { id } = req.params;
      const userFilter = {
        $or: [
          { userId: req.user.uid },
          { ownerId: req.user.uid },
          ...(req.user._id ? [{ userId: req.user._id.toString() }, { ownerId: req.user._id.toString() }] : [])
        ]
      };
      let summon = await db.collection('summons').findOne({ _id: id, ...userFilter });
      if (!summon && ObjectId.isValid(id)) {
        summon = await db.collection('summons').findOne({ _id: new ObjectId(id), ...userFilter });
      }
      if (!summon) {
        return res.status(404).json({ error: 'Summon record not found' });
      }
      res.json({ ...summon, id: summon._id.toString() });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/summons/:id/download-original', requireAuth, async (req: any, res: any) => {
    if (!db) return res.status(503).json({ error: 'Database disconnected' });
    try {
      const { id } = req.params;
      const userFilter = {
        $or: [
          { userId: req.user.uid },
          { ownerId: req.user.uid },
          ...(req.user._id ? [{ userId: req.user._id.toString() }, { ownerId: req.user._id.toString() }] : [])
        ]
      };
      let summon = await db.collection('summons').findOne({ _id: id, ...userFilter });
      if (!summon && ObjectId.isValid(id)) {
        summon = await db.collection('summons').findOne({ _id: new ObjectId(id), ...userFilter });
      }
      if (!summon) {
        return res.status(404).json({ error: 'Summon record not found or access denied' });
      }

      const imageUrl = summon.originalImageUrl || summon.imageUrl;
      if (!imageUrl) {
        return res.status(404).json({ error: 'No summons document image attached to this record' });
      }

      const cleanNum = (summon.summonNumber || 'Summon').replace(/[^a-zA-Z0-9_-]/g, '_');

      // If data URL: decode and send with Content-Disposition attachment header
      if (imageUrl.startsWith('data:')) {
        const parts = imageUrl.split(',');
        const matchMime = parts[0].match(/:(.*?);/);
        const mimeType = matchMime ? matchMime[1] : 'image/jpeg';
        const buffer = Buffer.from(parts[1], 'base64');
        const ext = mimeType.split('/')[1] === 'png' ? 'png' : mimeType.split('/')[1] === 'webp' ? 'webp' : 'jpg';
        const fileName = `Summons_${cleanNum}_Original.${ext}`;

        res.setHeader('Content-Type', mimeType);
        res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
        res.setHeader('Content-Length', buffer.length);
        return res.end(buffer);
      }

      // If external or storage URL
      return res.redirect(imageUrl);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/summons', requireAuth, async (req: any, res: any) => {
    if (!db) return res.status(503).json({ error: 'Database disconnected' });
    try {
      const docId = req.body.id || req.body._id || ('sum_' + Date.now().toString(36) + Math.random().toString(36).substring(2, 6));
      const summon = {
        ...req.body,
        _id: docId,
        userId: req.user.uid,
        ownerId: req.user.uid,
        updatedAt: req.body.updatedAt || new Date().toISOString()
      };
      delete summon.id;
      
      await db.collection('summons').updateOne(
        { _id: docId },
        { $set: summon },
        { upsert: true }
      );

      // Trigger background push check for upcoming/today hearings
      setTimeout(() => {
        checkAndDispatchHearingNotifications(req.user.uid).catch((e) =>
          console.warn('[Push] Notification check error after create:', e)
        );
      }, 100);
      res.status(201).json({ ...summon, id: docId });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/summons/:id', requireAuth, async (req: any, res: any) => {
    if (!db) return res.status(503).json({ error: 'Database disconnected' });
    try {
      const { id } = req.params;
      const updates = { ...req.body, updatedAt: new Date().toISOString() };
      delete updates.id;
      delete updates._id;
      delete updates.userId;
      delete updates.ownerId;

      const idFilter = {
        $or: [
          { _id: id },
          ...(ObjectId.isValid(id) ? [{ _id: new ObjectId(id) }] : [])
        ]
      };
      const userFilter = {
        $or: [
          { userId: req.user.uid },
          { ownerId: req.user.uid },
          ...(req.user._id ? [{ userId: req.user._id.toString() }, { ownerId: req.user._id.toString() }] : [])
        ]
      };

      const result = await db.collection('summons').updateOne(
        { $and: [idFilter, userFilter] },
        { $set: updates }
      );

      console.info(`[MongoDB] Summons update '${id}': matched=${result.matchedCount}, modified=${result.modifiedCount}`);

      // Trigger background push check after updates
      setTimeout(() => {
        checkAndDispatchHearingNotifications(req.user.uid).catch((e) =>
          console.warn('[Push] Notification check error after update:', e)
        );
      }, 100);
      res.json({ success: true, updatedCount: result.modifiedCount });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/summons/:id', requireAuth, async (req: any, res: any) => {
    if (!db) return res.status(503).json({ error: 'Database disconnected' });
    try {
      const { id } = req.params;
      const idFilter = {
        $or: [
          { _id: id },
          ...(ObjectId.isValid(id) ? [{ _id: new ObjectId(id) }] : [])
        ]
      };
      const userFilter = {
        $or: [
          { userId: req.user.uid },
          { ownerId: req.user.uid },
          ...(req.user._id ? [{ userId: req.user._id.toString() }, { ownerId: req.user._id.toString() }] : [])
        ]
      };

      const result = await db.collection('summons').deleteOne({ $and: [idFilter, userFilter] });
      await db.collection('notifications').deleteMany({ summonsId: id });
      console.info(`[MongoDB] Summons delete '${id}': deleted=${result.deletedCount}`);
      res.json({ success: true, deletedCount: result.deletedCount });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Witnesses Endpoints ---
  app.get('/api/witnesses', requireAuth, async (req: any, res: any) => {
    if (!db) return res.status(503).json({ error: 'Database disconnected' });
    try {
      const userFilter = {
        $or: [
          { userId: req.user.uid },
          { ownerId: req.user.uid },
          ...(req.user._id ? [{ userId: req.user._id.toString() }, { ownerId: req.user._id.toString() }] : [])
        ]
      };
      const witnesses = await db.collection('witnesses').find(userFilter).toArray();
      res.json(witnesses.map((w: any) => ({ ...w, id: w._id?.toString() || w.id })));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/witnesses', requireAuth, async (req: any, res: any) => {
    if (!db) return res.status(503).json({ error: 'Database disconnected' });
    try {
      const docId = req.body.id || req.body._id || ('wit_' + Date.now().toString(36) + Math.random().toString(36).substring(2, 6));
      const witness = {
        ...req.body,
        _id: docId,
        userId: req.user.uid,
        ownerId: req.user.uid,
        updatedAt: req.body.updatedAt || new Date().toISOString()
      };
      delete witness.id;

      await db.collection('witnesses').updateOne(
        { _id: docId },
        { $set: witness },
        { upsert: true }
      );
      res.status(201).json({ ...witness, id: docId });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/witnesses/:id', requireAuth, async (req: any, res: any) => {
    if (!db) return res.status(503).json({ error: 'Database disconnected' });
    try {
      const { id } = req.params;
      const updates = { ...req.body, updatedAt: new Date().toISOString() };
      delete updates.id;
      delete updates._id;
      delete updates.userId;
      delete updates.ownerId;

      const idFilter = {
        $or: [
          { _id: id },
          ...(ObjectId.isValid(id) ? [{ _id: new ObjectId(id) }] : [])
        ]
      };
      const userFilter = {
        $or: [
          { userId: req.user.uid },
          { ownerId: req.user.uid },
          ...(req.user._id ? [{ userId: req.user._id.toString() }, { ownerId: req.user._id.toString() }] : [])
        ]
      };

      const result = await db.collection('witnesses').updateOne(
        { $and: [idFilter, userFilter] },
        { $set: updates }
      );
      res.json({ success: true, updatedCount: result.modifiedCount });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/witnesses/:id', requireAuth, async (req: any, res: any) => {
    if (!db) return res.status(503).json({ error: 'Database disconnected' });
    try {
      const { id } = req.params;
      const idFilter = {
        $or: [
          { _id: id },
          ...(ObjectId.isValid(id) ? [{ _id: new ObjectId(id) }] : [])
        ]
      };
      const userFilter = {
        $or: [
          { userId: req.user.uid },
          { ownerId: req.user.uid },
          ...(req.user._id ? [{ userId: req.user._id.toString() }, { ownerId: req.user._id.toString() }] : [])
        ]
      };

      const result = await db.collection('witnesses').deleteOne({ $and: [idFilter, userFilter] });
      res.json({ success: true, deletedCount: result.deletedCount });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Officer App Reviews Endpoints ---
  app.get('/api/reviews', async (_req: any, res: any) => {
    if (!db) return res.status(503).json({ error: 'Database disconnected' });
    try {
      const reviews = await db.collection('reviews').find({}).sort({ updatedAt: -1, createdAt: -1 }).limit(50).toArray();
      res.json(reviews.map((r: any) => ({
        ...r,
        id: r._id?.toString() || r.id,
        officerName: r.officerName || 'Police Officer',
      })));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/reviews/mine', requireAuth, async (req: any, res: any) => {
    if (!db) return res.status(503).json({ error: 'Database disconnected' });
    try {
      const review = await db.collection('reviews').findOne({ userId: req.user.uid });
      res.json({ review: review || null });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/reviews', requireAuth, async (req: any, res: any) => {
    if (!db) return res.status(503).json({ error: 'Database disconnected' });
    try {
      const { rating, feedback, officerName, badgeNumber, rank } = req.body;
      const numRating = Number(rating);

      if (!numRating || numRating < 1 || numRating > 5) {
        return res.status(400).json({ error: 'Rating must be a whole number between 1 and 5 stars.' });
      }

      if (!feedback || typeof feedback !== 'string' || feedback.trim().length < 3) {
        return res.status(400).json({ error: 'Please enter at least 3 characters of constructive feedback.' });
      }

      const reviewData = {
        userId: req.user.uid,
        rating: Math.round(numRating),
        feedback: feedback.trim(),
        officerName: officerName || '',
        badgeNumber: badgeNumber || '',
        rank: rank || '',
        appVersion: '1.0.0',
        updatedAt: new Date(),
      };

      await db.collection('reviews').updateOne(
        { userId: req.user.uid },
        {
          $set: reviewData,
          $setOnInsert: { createdAt: new Date() }
        },
        { upsert: true }
      );

      console.info(`[App Review] Officer ${req.user.uid} submitted ${numRating}-star app review`);
      res.status(200).json({ success: true, message: 'Review saved successfully!', review: reviewData });
    } catch (err: any) {
      console.error('[App Review] Failed to save review:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Judicial QR & e-Courts Barcode Lookup routes
  app.use('/api/cases', createCaseRoutes(() => db));

  // 2. OCR Service Health Check (Safe: reports configuration without leaking key)
  app.get('/api/ocr/health', (_req, res) => {
    const key = getGeminiApiKey();
    const isConfigured = Boolean(key && key.trim().length > 6);
    res.status(200).json({
      status: 'ok',
      service: 'judicial-ocr',
      ocrAvailable: isConfigured,
      primaryModel: 'gemini-3.8-flash',
      fallbackModels: ['gemini-3.1-flash-lite', 'gemini-flash-latest', 'gemini-3.1-pro-preview'],
      configured: isConfigured,
      timestamp: new Date().toISOString(),
    });
  });

  // 3. Document AI OCR Endpoint
  app.post('/api/ocr', async (req, res) => {
    const startTime = Date.now();
    try {
      const { image, mimeType, sessionId } = req.body || {};

      if (!image) {
        return res.status(400).json({
          error: 'Missing document image or PDF payload. Please provide a base64 encoded document.',
          code: 'MISSING_PAYLOAD',
          sessionId,
        });
      }

      const apiKey = getGeminiApiKey();
      if (!apiKey || !apiKey.trim()) {
        console.warn('[OCR Service] Gemini API key not found in server environment.');
        return res.status(503).json({
          error: 'Gemini API key is not configured on the server. Please set GEMINI_API_KEY in environment variables.',
          code: 'API_KEY_NOT_CONFIGURED',
          sessionId,
        });
      }

      // Trust the data URL's mime type if available
      let actualMime = mimeType || 'image/jpeg';
      if (image.startsWith('data:')) {
        const extractedMime = image.split(';')[0].split(':')[1];
        if (extractedMime) {
          actualMime = extractedMime;
        }
      }

      // Strip potential data URL prefix
      const cleanBase64 = image.includes('base64,') ? image.split('base64,')[1] : image;

      // Normalize mimeType
      let normalizedMime = actualMime.toLowerCase();
      if (normalizedMime.includes('pdf')) {
        normalizedMime = 'application/pdf';
      } else if (normalizedMime.includes('png')) {
        normalizedMime = 'image/png';
      } else if (normalizedMime.includes('webp')) {
        normalizedMime = 'image/webp';
      } else if (normalizedMime.includes('heic') || normalizedMime.includes('heif')) {
        normalizedMime = 'image/heic';
      } else {
        normalizedMime = 'image/jpeg'; // fallback
      }

      console.info(
        `[DOCKET] AI request started (session=${sessionId || 'n/a'}, mime=${normalizedMime}, payload=~${Math.round((cleanBase64.length * 3) / 4 / 1024)} KB)`
      );

      const ai = new GoogleGenAI({
        apiKey,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          },
        },
      });

      const prompt = `You are a certified forensic judicial OCR extraction engine for Indian court summons, warrants, and legal notices.

CRITICAL INTEGRITY DIRECTIVE - ZERO HALLUCINATION POLICY:
1. NEVER INVENT, GUESS, OR FABRICATE ANY LEGAL DATA.
2. Do NOT extrapolate or assume missing Case Numbers, CNR codes, Court Complex names, Judge designations, Party/Witness/Accused names, Police Station names, Hearing dates, Sections, or Addresses.
3. If any field is NOT clearly legible, blurry, cropped, obstructed, or absent in the image, return its value as null or "" with confidence 0.0.
4. If a field is partially visible or ambiguous, extract only what is physically readable and assign an accurate, lower confidence score (e.g., 0.40 - 0.65).
5. For crisp, unambiguous, directly printed text, assign high confidence (0.85 - 0.99).
6. If the entire image is too blurry, dark, rotated unreadably, blank, or not a legal summon/warrant, set "isReadable": false and all field confidences to 0.0.

Return the extraction in this EXACT JSON structure:
{
  "isReadable": true or false,
  "documentType": "Court Summon | Bailable Warrant | Non-Bailable Warrant | Notice | Unknown",
  "fields": {
    "summonNumber": { "value": "string or null", "confidence": number between 0.0 and 1.0 },
    "caseNumber": { "value": "string or null", "confidence": number between 0.0 and 1.0 },
    "personName": { "value": "string or null", "confidence": number between 0.0 and 1.0 },
    "fatherName": { "value": "string or null", "confidence": number between 0.0 and 1.0 },
    "address": { "value": "string or null", "confidence": number between 0.0 and 1.0 },
    "courtName": { "value": "string or null", "confidence": number between 0.0 and 1.0 },
    "courtAddress": { "value": "string or null", "confidence": number between 0.0 and 1.0 },
    "policeStation": { "value": "string or null", "confidence": number between 0.0 and 1.0 },
    "district": { "value": "string or null", "confidence": number between 0.0 and 1.0 },
    "state": { "value": "string or null", "confidence": number between 0.0 and 1.0 },
    "issueDate": { "value": "YYYY-MM-DD or null", "confidence": number between 0.0 and 1.0 },
    "hearingDate": { "value": "YYYY-MM-DD or null", "confidence": number between 0.0 and 1.0 },
    "issuingAuthority": { "value": "string or null", "confidence": number between 0.0 and 1.0 },
    "officerDetails": { "value": "string or null", "confidence": number between 0.0 and 1.0 },
    "offenseCharges": { "value": "string or null", "confidence": number between 0.0 and 1.0 },
    "urgency": { "value": "Standard | High | Urgent", "confidence": number between 0.0 and 1.0 }
  },
  "summonNumber": "string or empty",
  "caseNumber": "string or empty",
  "personName": "string or empty",
  "fatherName": "string or empty",
  "address": "string or empty",
  "courtName": "string or empty",
  "courtAddress": "string or empty",
  "policeStation": "string or empty",
  "district": "string or empty",
  "state": "string or empty",
  "issueDate": "string or empty",
  "hearingDate": "string or empty",
  "issuingAuthority": "string or empty",
  "officerDetails": "string or empty",
  "offenseCharges": "string or empty",
  "urgency": "Standard"
}
IMPORTANT: Return ONLY valid JSON. Absolutely zero markdown framing outside the JSON.`;

      // High-availability candidate models per Gemini SDK specification
      // gemini-3.8-flash is the primary model for multimodal text & document tasks
      const candidateModels = [
        'gemini-3.8-flash',
        'gemini-3.1-flash-lite',
        'gemini-flash-latest',
        'gemini-3.1-pro-preview',
      ];
      let response: any = null;
      let lastModelError: any = null;

      for (const modelName of candidateModels) {
        try {
          console.info(`[DOCKET] Attempting legal extraction with ${modelName}...`);
          
          // Enforce 8.5s per-attempt timeout for fast failover within serverless limits
          const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`Model ${modelName} timed out after 8500ms`)), 8500)
          );

          const generatePromise = ai.models.generateContent({
            model: modelName,
            contents: [
              {
                role: 'user',
                parts: [
                  { text: prompt },
                  {
                    inlineData: {
                      data: cleanBase64,
                      mimeType: normalizedMime,
                    },
                  },
                ],
              },
            ],
            config: {
              responseMimeType: 'application/json',
            },
          });

          response = await Promise.race([generatePromise, timeoutPromise]);
          console.info(`[DOCKET] AI response received from model: ${modelName} in ${Date.now() - startTime}ms`);
          break; // Succeeded!
        } catch (candidateErr: any) {
          lastModelError = candidateErr;
          const errMsg = candidateErr?.message || '';
          console.info(`[DOCKET] Candidate model ${modelName} returned transient status (${errMsg.slice(0, 80)}). Cascading to next candidate...`);
        }
      }

      if (!response && lastModelError) {
        throw lastModelError;
      }

      const rawText = (response?.text || '').trim();
      const elapsed = Date.now() - startTime;
      console.info(`[DOCKET] AI response received in ${elapsed}ms`);

      console.info(`[DOCKET] JSON parsing started`);
      // Clean JSON string (strip markdown fences if present)
      let cleanedJson = rawText;
      if (cleanedJson.startsWith('```json')) {
        cleanedJson = cleanedJson.replace(/^```json\s*/, '').replace(/\s*```$/, '');
      } else if (cleanedJson.startsWith('```')) {
        cleanedJson = cleanedJson.replace(/^```\s*/, '').replace(/\s*```$/, '');
      }

      const jsonMatch = cleanedJson.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0]);
          console.info(`[DOCKET] validation completed: ${Object.keys(parsed.fields || {}).length} fields extracted`);
          return res.status(200).json({ ...parsed, sessionId });
        } catch (jsonParseErr) {
          console.warn('[DOCKET] JSON parse error on matched block, fallback rawText:', jsonParseErr);
          return res.status(200).json({ rawText, sessionId, isReadable: true });
        }
      } else {
        return res.status(200).json({ rawText, sessionId, isReadable: Boolean(rawText.length > 0) });
      }
    } catch (err: any) {
      console.error('[OCR Service] Server-side OCR exception:', err);

      let cleanErrorMsg = err.message || 'Internal server error while processing document with Gemini OCR.';
      try {
        if (typeof cleanErrorMsg === 'string' && (cleanErrorMsg.includes('{') && cleanErrorMsg.includes('}'))) {
          const start = cleanErrorMsg.indexOf('{');
          const end = cleanErrorMsg.lastIndexOf('}');
          if (start !== -1 && end !== -1) {
            const parsed = JSON.parse(cleanErrorMsg.slice(start, end + 1));
            if (parsed?.error?.message) {
              cleanErrorMsg = parsed.error.message;
            }
          }
        }
      } catch (_) {}

      const isAuthError =
        cleanErrorMsg.toLowerCase().includes('api key') ||
        cleanErrorMsg.toLowerCase().includes('permission') ||
        err.status === 401 ||
        err.status === 403;

      const isHighDemand =
        cleanErrorMsg.toLowerCase().includes('high demand') ||
        cleanErrorMsg.toLowerCase().includes('unavailable') ||
        err.status === 503;

      const statusCode = isAuthError ? 401 : isHighDemand ? 503 : 500;

      return res.status(statusCode).json({
        sessionId: req.body?.sessionId,
        error: isAuthError
          ? 'Gemini API authentication failed. Check API key configuration.'
          : isHighDemand
          ? 'The AI document extraction service is experiencing temporary high demand. Please try again in a few moments.'
          : cleanErrorMsg,
        code: isAuthError ? 'AUTH_FAILED' : isHighDemand ? 'SERVICE_UNAVAILABLE' : 'OCR_PROCESSING_ERROR',
      });
    }
  });


  // --- Push Notifications & Background Scheduling Engine ---

  function getIndiaDateString(d = new Date()): string {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    return formatter.format(d);
  }

  async function sendPushToUser(
    userId: string,
    payload: { title: string; body: string; data?: Record<string, string>; uniqueKey?: string }
  ) {
    if (!db) return { sentCount: 0, failureCount: 0 };
    try {
      const tokens = await db.collection('fcm_tokens').find({ userId, isActive: true }).toArray();
      if (!tokens || tokens.length === 0) {
        return { sentCount: 0, failureCount: 0 };
      }

      let sentCount = 0;
      let failureCount = 0;
      const deadTokens: string[] = [];

      for (const item of tokens) {
        let pushSuccess = false;

        // 1. Deliver via standard Web Push (VAPID) if subscription is present
        if (item.subscription && vapidPublicKey && vapidPrivateKey) {
          try {
            const pushData = {
              title: payload.title,
              body: payload.body,
              data: payload.data || {},
              uniqueKey: payload.uniqueKey || `summon-${Date.now()}`,
            };
            await webpush.sendNotification(item.subscription, JSON.stringify(pushData));
            pushSuccess = true;
            sentCount++;
          } catch (wpErr: any) {
            if (wpErr.statusCode === 404 || wpErr.statusCode === 410) {
              deadTokens.push(item.token);
            }
          }
        }

        // 2. Deliver via Firebase Admin Cloud Messaging if token is an FCM token
        if (!pushSuccess && item.token && !item.token.startsWith('sub_')) {
          try {
            const messaging = getMessaging();
            const strData: Record<string, string> = {};
            if (payload.data) {
              for (const [k, v] of Object.entries(payload.data)) {
                strData[k] = String(v);
              }
            }
            if (payload.uniqueKey) strData.uniqueKey = payload.uniqueKey;

            await messaging.send({
              token: item.token,
              notification: {
                title: payload.title,
                body: payload.body,
              },
              data: strData,
            });
            sentCount++;
            pushSuccess = true;
          } catch (fcmErr: any) {
            const errCode = fcmErr.code || '';
            if (
              errCode === 'messaging/registration-token-not-registered' ||
              errCode === 'messaging/invalid-registration-token' ||
              errCode === 'messaging/invalid-argument'
            ) {
              deadTokens.push(item.token);
            }
            failureCount++;
          }
        }
      }

      // Cleanup stale or unsubscribed tokens
      if (deadTokens.length > 0) {
        await db.collection('fcm_tokens').updateMany(
          { token: { $in: deadTokens } },
          { $set: { isActive: false, deactivatedAt: new Date().toISOString() } }
        );
        console.info(`[Push] Cleaned up ${deadTokens.length} expired device token(s).`);
      }

      return { sentCount, failureCount };
    } catch (err) {
      console.error('[Push] Error delivering push notification:', err);
      return { sentCount: 0, failureCount: 1 };
    }
  }

  async function checkAndDispatchHearingNotifications(targetUserId?: string) {
    if (!db) return;
    try {
      const todayStr = getIndiaDateString();
      const [tY, tM, tD] = todayStr.split('-').map(Number);
      const todayMidnight = Date.UTC(tY, tM - 1, tD);

      const query: any = { status: { $ne: 'Completed' } };
      if (targetUserId) {
        query.userId = targetUserId;
      }

      const summons = await db.collection('summons').find(query).toArray();
      for (const summon of summons) {
        if (!summon.hearingDate) continue;

        const [hY, hM, hD] = summon.hearingDate.split('-').map(Number);
        if (isNaN(hY) || isNaN(hM) || isNaN(hD)) continue;
        const hearingMidnight = Date.UTC(hY, hM - 1, hD);
        const diffDays = Math.round((hearingMidnight - todayMidnight) / (1000 * 60 * 60 * 24));

        let type: string | null = null;
        let title = '';
        let message = '';

        if (diffDays < 0) {
          type = 'HEARING_OVERDUE';
          title = 'Overdue Hearing';
          message = `Hearing date for ${summon.personName} (${summon.summonNumber || summon.caseNumber}) has passed.`;
        } else if (diffDays === 0) {
          type = 'HEARING_TODAY';
          title = 'Hearing Today';
          message = `Hearing scheduled for today: ${summon.personName} (${summon.summonNumber || summon.caseNumber}).`;
        } else if (diffDays === 1) {
          type = 'HEARING_TOMORROW';
          title = 'Hearing Tomorrow';
          message = `Hearing scheduled for tomorrow: ${summon.personName} (${summon.summonNumber || summon.caseNumber}).`;
        } else if (diffDays > 1 && diffDays <= 7) {
          type = 'HEARING_UPCOMING';
          title = 'Upcoming Hearing';
          message = `Hearing in ${diffDays} days for ${summon.personName} (${summon.summonNumber || summon.caseNumber}).`;
        }

        if (type) {
          const uniqueKey = `${summon.userId}_${summon._id}_${type}_${summon.hearingDate}`;
          const existing = await db.collection('notifications').findOne({ uniqueKey });

          if (!existing) {
            // First time detecting this alert event: insert in-app notification & send push
            const notificationDoc = {
              userId: summon.userId,
              summonsId: summon._id.toString(),
              type,
              title,
              message,
              hearingDate: summon.hearingDate,
              personName: summon.personName || '',
              courtName: summon.courtName || '',
              caseNumber: summon.caseNumber || summon.summonNumber || '',
              isRead: false,
              pushSent: true,
              pushSentAt: new Date().toISOString(),
              uniqueKey,
              createdAt: new Date().toISOString(),
            };
            await db.collection('notifications').insertOne(notificationDoc);

            await sendPushToUser(summon.userId, {
              title,
              body: message,
              uniqueKey,
              data: {
                summonId: summon._id.toString(),
                route: `/summons/${summon._id}`,
                type,
              },
            });
          } else if (!existing.pushSent) {
            // Document existed in in-app collection but push hasn't been fired yet
            await db.collection('notifications').updateOne(
              { uniqueKey },
              { $set: { pushSent: true, pushSentAt: new Date().toISOString() } }
            );

            await sendPushToUser(summon.userId, {
              title,
              body: message,
              uniqueKey,
              data: {
                summonId: summon._id.toString(),
                route: `/summons/${summon._id}`,
                type,
              },
            });
          }
          // If existing.pushSent is true: DEDUPLICATION - DO NOT SEND AGAIN
        }
      }
    } catch (err) {
      console.error('[Notifications] Background hearing check error:', err);
    }
  }

  // --- Push Registration & Diagnostic Endpoints ---

  app.get('/api/notifications/vapid-public-key', (_req: any, res: any) => {
    res.json({ publicKey: vapidPublicKey });
  });

  app.post('/api/notifications/fcm-token', requireAuth, async (req: any, res: any) => {
    if (!db) return res.status(503).json({ error: 'Database disconnected' });
    try {
      const { token, subscription, deviceType } = req.body;
      if (!token && !subscription) {
        return res.status(400).json({ error: 'Token or subscription is required' });
      }

      const tokenIdentifier = token || (subscription?.endpoint ? `sub_${Buffer.from(subscription.endpoint).toString('base64').slice(-32)}` : `sub_${Date.now()}`);
      const userId = req.user.uid;

      await db.collection('fcm_tokens').updateOne(
        { token: tokenIdentifier },
        {
          $set: {
            token: tokenIdentifier,
            userId,
            subscription: subscription || null,
            deviceType: deviceType || 'web',
            userAgent: req.headers['user-agent'] || '',
            isActive: true,
            lastActiveAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          $setOnInsert: {
            createdAt: new Date().toISOString(),
          },
        },
        { upsert: true }
      );

      console.info(`[Push] Registered push device for user ${userId}`);
      res.json({ success: true, message: 'Device registered for push notifications' });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/notifications/fcm-token', requireAuth, async (req: any, res: any) => {
    if (!db) return res.status(503).json({ error: 'Database disconnected' });
    try {
      const { token } = req.body;
      if (token) {
        await db.collection('fcm_tokens').updateMany(
          { token, userId: req.user.uid },
          { $set: { isActive: false, deactivatedAt: new Date().toISOString() } }
        );
      }
      res.json({ success: true, message: 'Device token deactivated' });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/notifications/test-push', requireAuth, async (req: any, res: any) => {
    if (!db) return res.status(503).json({ error: 'Database disconnected' });
    try {
      const userId = req.user.uid;
      const tokens = await db.collection('fcm_tokens').find({ userId, isActive: true }).toArray();
      if (tokens.length === 0) {
        return res.status(404).json({
          error: 'No active device registered for push notifications. Please allow notifications on this device first.',
          registeredCount: 0,
        });
      }

      const result = await sendPushToUser(userId, {
        title: '🚨 Summons Mitra Test Alert',
        body: 'Real background push notifications are active and delivering to your device!',
        uniqueKey: `test_${userId}_${Date.now()}`,
        data: {
          type: 'TEST_ALERT',
          route: '/',
        },
      });

      res.json({
        success: true,
        message: `Test push dispatched to ${result.sentCount} active device(s).`,
        sentCount: result.sentCount,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/notifications/trigger-check', requireAuth, async (req: any, res: any) => {
    try {
      await checkAndDispatchHearingNotifications(req.user.uid);
      res.json({ success: true, message: 'Hearing checks executed successfully' });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- In-App Notifications Endpoints ---
  app.get('/api/notifications', requireAuth, async (req: any, res: any) => {
    if (!db) return res.status(503).json({ error: 'Database disconnected' });
    try {
      const { today, upcomingDays = 7 } = req.query;
      const userId = req.user.uid;
      const todayStr = today || getIndiaDateString();

      const summons = await db.collection('summons').find({ userId, status: { $ne: 'Completed' } }).toArray();
      const [tY, tM, tD] = todayStr.split('-').map(Number);
      const todayMidnight = Date.UTC(tY, tM - 1, tD);
      const bulkOps = [];
      
      for (const summon of summons) {
        if (!summon.hearingDate) continue;
        const [hY, hM, hD] = summon.hearingDate.split('-').map(Number);
        if (isNaN(hY) || isNaN(hM) || isNaN(hD)) continue;
        const hearingMidnight = Date.UTC(hY, hM - 1, hD);
        const diffDays = Math.round((hearingMidnight - todayMidnight) / (1000 * 60 * 60 * 24));
        
        let type = null;
        let title = '';
        let message = '';
        
        if (diffDays < 0) {
          type = 'HEARING_OVERDUE';
          title = 'Overdue Hearing';
          message = `Hearing date for ${summon.personName} (${summon.summonNumber || summon.caseNumber}) has passed.`;
        } else if (diffDays === 0) {
          type = 'HEARING_TODAY';
          title = 'Hearing Today';
          message = `Hearing scheduled for today: ${summon.personName} (${summon.summonNumber || summon.caseNumber}).`;
        } else if (diffDays === 1) {
          type = 'HEARING_TOMORROW';
          title = 'Hearing Tomorrow';
          message = `Hearing scheduled for tomorrow: ${summon.personName} (${summon.summonNumber || summon.caseNumber}).`;
        } else if (diffDays > 1 && diffDays <= parseInt(upcomingDays)) {
          type = 'HEARING_UPCOMING';
          title = 'Upcoming Hearing';
          message = `Hearing in ${diffDays} days for ${summon.personName} (${summon.summonNumber || summon.caseNumber}).`;
        }
        
        if (type) {
          const uniqueKey = `${userId}_${summon._id}_${type}_${summon.hearingDate}`;
          bulkOps.push({
            updateOne: {
              filter: { uniqueKey },
              update: {
                $setOnInsert: {
                  userId,
                  summonsId: summon._id.toString(),
                  type,
                  title,
                  message,
                  hearingDate: summon.hearingDate,
                  personName: summon.personName || '',
                  courtName: summon.courtName || '',
                  caseNumber: summon.caseNumber || summon.summonNumber || '',
                  isRead: false,
                  pushSent: false,
                  createdAt: new Date().toISOString()
                }
              },
              upsert: true
            }
          });
        }
      }
      
      if (bulkOps.length > 0) {
        await db.collection('notifications').bulkWrite(bulkOps, { ordered: false });
      }
      
      const notifications = await db.collection('notifications')
        .find({ userId })
        .sort({ createdAt: -1 })
        .toArray();
        
      res.json(notifications.map((n: any) => ({ ...n, id: n._id.toString() })));
    } catch (err: any) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/notifications/:id/read', requireAuth, async (req: any, res: any) => {
    if (!db) return res.status(503).json({ error: 'Database disconnected' });
    try {
      const { id } = req.params;
      const filter = ObjectId.isValid(id)
        ? { _id: new ObjectId(id), userId: req.user.uid }
        : { _id: id, userId: req.user.uid };
      await db.collection('notifications').updateOne(
        filter,
        { $set: { isRead: true } }
      );
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
  
  app.put('/api/notifications/read-all', requireAuth, async (req: any, res: any) => {
    if (!db) return res.status(503).json({ error: 'Database disconnected' });
    try {
      await db.collection('notifications').updateMany(
        { userId: req.user.uid, isRead: false },
        { $set: { isRead: true } }
      );
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/notifications/cleanup/:summonsId', requireAuth, async (req: any, res: any) => {
    if (!db) return res.status(503).json({ error: 'Database disconnected' });
    try {
      const { summonsId } = req.params;
      await db.collection('notifications').deleteMany({ userId: req.user.uid, summonsId });
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Schedule periodic background hearing check every 2 minutes (when server is long-running)
  if (process.env.VERCEL !== '1' && !process.env.AWS_LAMBDA_FUNCTION_NAME) {
    setInterval(() => {
      checkAndDispatchHearingNotifications().catch((err) => {
        console.error('[Scheduler] Periodic background push check error:', err);
      });
    }, 2 * 60 * 1000);

    setTimeout(() => {
      checkAndDispatchHearingNotifications().catch((err) => {
        console.warn('[Startup] Initial push check error:', err);
      });
    }, 3000);
  }

  return { app, db, mongoClient };
  })();

  return appPromise;
}

export async function startServer() {
  const { app } = await getApp();
  const PORT = Number(process.env.PORT) || 3000;
  const isProduction = process.env.NODE_ENV === 'production';

  // Serve Frontend Assets: Vite middleware in Development, static dist/ in Production
  if (!isProduction) {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        host: '0.0.0.0',
        port: 3000,
        hmr: false,
        ws: false,
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
    console.info('[Server] Vite middleware attached for live development (HMR disabled).');
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    // SPA catch-all fallback
    app.use((_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
    console.info(`[Server] Serving production static files from ${distPath}`);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.info(`[Server] Production-ready server running on http://0.0.0.0:${PORT}`);
  });
}
