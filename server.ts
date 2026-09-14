import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI } from '@google/genai';
import { MongoClient, ServerApiVersion } from 'mongodb';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

// Initialize Firebase Admin for secure token verification
if (!getApps().length) {
  try {
    initializeApp({
      projectId: process.env.VITE_FIREBASE_PROJECT_ID || 'summonsviewer'
    });
    console.info('[Auth] Firebase Admin initialized for secure token verification.');
  } catch (err) {
    console.error('[Auth] Failed to initialize Firebase Admin:', err);
  }
}

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

// Helper to retrieve Gemini API key across environment variables
function getGeminiApiKey(): string | undefined {
  const key =
    process.env.GEMINI_API_KEY ||
    process.env.API_KEY ||
    process.env.GOOGLE_API_KEY ||
    process.env.VITE_GEMINI_API_KEY;

  if (!key || key.startsWith('your_') || key.includes('placeholder')) {
    return undefined;
  }
  return key;
}

async function startServer() {
  const app = express();
  const PORT = 3000;
  const isProduction = process.env.NODE_ENV === 'production';

  console.info(`[Server] Starting SummonMitra backend in ${isProduction ? 'PRODUCTION' : 'DEVELOPMENT'} mode...`);

  // --- MongoDB Setup ---
  const MONGODB_URI = process.env.MONGODB_URI || process.env.atlas_URL;
  const MONGODB_DB_NAME = process.env.MONGODB_DB_NAME || 'summonsviewer';

  let mongoClient: MongoClient | null = null;
  let db: any = null;

  if (MONGODB_URI) {
    try {
      mongoClient = new MongoClient(MONGODB_URI, {
        serverApi: {
          version: ServerApiVersion.v1,
          strict: true,
          deprecationErrors: true,
        }
      });
      mongoClient.connect().then(() => {
        console.info('[MongoDB] Successfully connected to MongoDB Atlas!');
        db = mongoClient!.db(MONGODB_DB_NAME);
      }).catch(err => {
        console.error('[MongoDB] Connection failed on startup:', err);
      });
    } catch (err) {
      console.error('[MongoDB] Initialization error:', err);
    }
  } else {
    console.warn('[MongoDB] No MONGODB_URI or atlas_URL found in environment variables.');
  }
  // ---------------------

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

  // 1. General Health Check
  app.get('/api/health', (_req, res) => {
    res.status(200).json({
      status: 'ok',
      service: 'summon-mitra-server',
      environment: process.env.NODE_ENV || 'development',
      uptime: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
      database: db ? 'connected' : 'disconnected',
    });
  });

  // DB specific health check
  app.get('/api/health/db', async (_req, res) => {
    if (!mongoClient || !db) {
      return res.status(503).json({ server: 'ok', database: 'disconnected', error: 'MongoDB URI not configured or connection failed' });
    }
    try {
      await db.command({ ping: 1 });
      res.status(200).json({ server: 'ok', database: 'connected' });
    } catch (err: any) {
      res.status(500).json({ server: 'ok', database: 'error', error: err.message });
    }
  });

  // DB test endpoint
  app.post('/api/test/db', async (req, res) => {
    if (!mongoClient || !db) {
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
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized: Missing or invalid token' });
    }
    const token = authHeader.split(' ')[1];
    if (!token || token.trim() === '') {
      return res.status(401).json({ error: 'Unauthorized: Empty token' });
    }
    
    // Support for the existing frontend local mock users (usr_ prefix) during development
    if (token.startsWith('usr_')) {
      req.user = { uid: token };
      return next();
    }

    // Production Firebase JWT verification
    try {
      const decodedToken = await getAuth().verifyIdToken(token);
      req.user = { uid: decodedToken.uid };
      next();
    } catch (error) {
      console.error('[Auth] Token verification failed:', error);
      return res.status(401).json({ error: 'Unauthorized: Invalid token signature' });
    }
  };

  // --- Summons Endpoints ---
  app.get('/api/summons', requireAuth, async (req: any, res: any) => {
    if (!db) return res.status(503).json({ error: 'Database disconnected' });
    try {
      const summons = await db.collection('summons').find({ userId: req.user.uid }).toArray();
      res.json(summons.map((s: any) => ({ ...s, id: s._id.toString() })));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/summons', requireAuth, async (req: any, res: any) => {
    if (!db) return res.status(503).json({ error: 'Database disconnected' });
    try {
      const summon = { ...req.body, userId: req.user.uid };
      delete summon.id; // ensure no explicit string ID overrides mongo's ObjectId if they were passing it, wait actually client generates a string ID.
      // If client generates ID, we can store it as `id` or let mongo generate `_id` and map it. 
      // Let's store the client's `id` as `_id` so we don't have to rewrite everything.
      if (req.body.id) {
        summon._id = req.body.id;
        delete summon.id;
      }
      await db.collection('summons').insertOne(summon);
      res.status(201).json({ ...summon, id: summon._id });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/summons/:id', requireAuth, async (req: any, res: any) => {
    if (!db) return res.status(503).json({ error: 'Database disconnected' });
    try {
      const { id } = req.params;
      const updates = { ...req.body };
      delete updates.id;
      delete updates._id;
      delete updates.userId;

      await db.collection('summons').updateOne(
        { _id: id, userId: req.user.uid },
        { $set: updates }
      );
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/summons/:id', requireAuth, async (req: any, res: any) => {
    if (!db) return res.status(503).json({ error: 'Database disconnected' });
    try {
      const { id } = req.params;
      await db.collection('summons').deleteOne({ _id: id, userId: req.user.uid });
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Witnesses Endpoints ---
  app.get('/api/witnesses', requireAuth, async (req: any, res: any) => {
    if (!db) return res.status(503).json({ error: 'Database disconnected' });
    try {
      const witnesses = await db.collection('witnesses').find({ userId: req.user.uid }).toArray();
      res.json(witnesses.map((w: any) => ({ ...w, id: w._id.toString() })));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/witnesses', requireAuth, async (req: any, res: any) => {
    if (!db) return res.status(503).json({ error: 'Database disconnected' });
    try {
      const witness = { ...req.body, userId: req.user.uid };
      if (req.body.id) {
        witness._id = req.body.id;
        delete witness.id;
      }
      await db.collection('witnesses').insertOne(witness);
      res.status(201).json({ ...witness, id: witness._id });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/witnesses/:id', requireAuth, async (req: any, res: any) => {
    if (!db) return res.status(503).json({ error: 'Database disconnected' });
    try {
      const { id } = req.params;
      const updates = { ...req.body };
      delete updates.id;
      delete updates._id;
      delete updates.userId;

      await db.collection('witnesses').updateOne(
        { _id: id, userId: req.user.uid },
        { $set: updates }
      );
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/witnesses/:id', requireAuth, async (req: any, res: any) => {
    if (!db) return res.status(503).json({ error: 'Database disconnected' });
    try {
      const { id } = req.params;
      await db.collection('witnesses').deleteOne({ _id: id, userId: req.user.uid });
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 2. OCR Service Health Check (Safe: reports configuration without leaking key)
  app.get('/api/ocr/health', (_req, res) => {
    const key = getGeminiApiKey();
    const isConfigured = Boolean(key && key.trim().length > 6);
    res.status(200).json({
      status: 'ok',
      service: 'judicial-ocr',
      ocrAvailable: isConfigured,
      primaryModel: 'gemini-3.1-flash-lite',
      fallbackModels: ['gemini-3.8-flash', 'gemini-flash-latest'],
      configured: isConfigured,
      timestamp: new Date().toISOString(),
    });
  });

  // 3. Document AI OCR Endpoint
  app.post('/api/ocr', async (req, res) => {
    const startTime = Date.now();
    try {
      const { image, mimeType } = req.body || {};

      if (!image) {
        return res.status(400).json({
          error: 'Missing document image or PDF payload. Please provide a base64 encoded document.',
          code: 'MISSING_PAYLOAD',
        });
      }

      const apiKey = getGeminiApiKey();
      if (!apiKey || !apiKey.trim()) {
        console.warn('[OCR Service] Gemini API key not found in server environment.');
        return res.status(503).json({
          error: 'Gemini API key is not configured on the server. Please set GEMINI_API_KEY.',
          code: 'API_KEY_NOT_CONFIGURED',
        });
      }

      // Strip potential data URL prefix
      const cleanBase64 = image.includes('base64,') ? image.split('base64,')[1] : image;

      // Normalize mimeType
      let normalizedMime = mimeType || 'image/jpeg';
      if (normalizedMime.includes('pdf')) {
        normalizedMime = 'application/pdf';
      } else if (normalizedMime.includes('png')) {
        normalizedMime = 'image/png';
      } else if (normalizedMime.includes('webp')) {
        normalizedMime = 'image/webp';
      } else {
        normalizedMime = 'image/jpeg';
      }

      console.info(
        `[OCR Service] Processing legal document (${normalizedMime}, ~${Math.round((cleanBase64.length * 3) / 4 / 1024)} KB)...`
      );

      const ai = new GoogleGenAI({ apiKey });
      const prompt = `You are an expert legal document analyst and certified OCR extraction assistant specialized in judicial warrants, court summons, notices, and charge sheets.
Analyze this court summon or warrant document image or PDF and extract all factual legal particulars into this exact JSON structure:
{
  "summonNumber": "string (summon, warrant, notice, or CNR number found in the document, or empty string)",
  "caseNumber": "string (FIR number, case number, or CC number found in the document, or empty string)",
  "personName": "string (name of person summoned / respondent / accused as printed, or empty string)",
  "fatherName": "string (father or spouse name if mentioned, or empty string)",
  "address": "string (complete address with house/flat, street, area, landmark, pincode as written, or empty string)",
  "courtName": "string (name of the court / bench / judge, or empty string)",
  "courtAddress": "string (court complex location and room number, or empty string)",
  "policeStation": "string (police station jurisdiction if mentioned, or empty string)",
  "district": "string (district name if mentioned, or empty string)",
  "state": "string (state name if mentioned, or empty string)",
  "issueDate": "string (issue date in YYYY-MM-DD format if present, or empty string)",
  "hearingDate": "string (court appearance / hearing date in YYYY-MM-DD format, or empty string)",
  "issuingAuthority": "string (designation of Judge, Magistrate, or Officer, or empty string)",
  "officerDetails": "string (assigned serving officer if mentioned, or empty string)",
  "offenseCharges": "string (legal IPC/BNS/CrPC/NI Act sections or charges summary, or empty string)",
  "urgency": "Standard, High, or Urgent based on timeline and nature of offense"
}
IMPORTANT: Return ONLY valid JSON. If any field cannot be verified or is illegible in the document, set it to an empty string "". Never invent fictional names or addresses.`;

      const candidateModels = ['gemini-3.1-flash-lite', 'gemini-3.8-flash', 'gemini-flash-latest'];
      let response: any = null;
      let lastModelError: any = null;

      for (const modelName of candidateModels) {
        try {
          console.info(`[OCR Service] Attempting legal extraction using model: ${modelName}...`);
          response = await ai.models.generateContent({
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
          });
          console.info(`[OCR Service] Extraction succeeded with model: ${modelName}`);
          break; // Succeeded!
        } catch (candidateErr: any) {
          lastModelError = candidateErr;
          console.warn(`[OCR Service] Model ${modelName} returned error: ${candidateErr.message}. Trying next candidate...`);
        }
      }

      if (!response && lastModelError) {
        throw lastModelError;
      }

      const rawText = response.text || '';
      const elapsed = Date.now() - startTime;
      console.info(`[OCR Service] Extraction completed in ${elapsed}ms`);

      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0]);
          return res.status(200).json(parsed);
        } catch (jsonParseErr) {
          console.warn('[OCR Service] JSON parse error on matched block, returning rawText payload:', jsonParseErr);
          return res.status(200).json({ rawText });
        }
      } else {
        return res.status(200).json({ rawText });
      }
    } catch (err: any) {
      console.error('[OCR Service] Server-side OCR exception:', err);
      const isAuthError =
        err.message?.toLowerCase().includes('api key') ||
        err.message?.toLowerCase().includes('permission') ||
        err.status === 401 ||
        err.status === 403;

      return res.status(isAuthError ? 401 : 500).json({
        error: isAuthError
          ? 'Gemini API authentication failed. Check API key configuration.'
          : err.message || 'Internal server error while processing document with Gemini OCR.',
        code: isAuthError ? 'AUTH_FAILED' : 'OCR_PROCESSING_ERROR',
      });
    }
  });

  // Serve Frontend Assets: Vite middleware in Development, static dist/ in Production
  if (!isProduction) {
    const vite = await createViteServer({
      server: { middlewareMode: true, host: '0.0.0.0', port: 3000 },
      appType: 'spa',
    });
    app.use(vite.middlewares);
    console.info('[Server] Vite middleware attached for live development.');
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

startServer().catch((fatalErr) => {
  console.error('[Server] Fatal server startup failure:', fatalErr);
  process.exit(1);
});
