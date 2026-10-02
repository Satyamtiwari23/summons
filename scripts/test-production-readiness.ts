import { parseJudicialQR } from '../server/services/judicialQrParser';
import { validateQrLookupRequest } from '../server/validators/caseValidators';
import { sanitizeFileName, getImageFormatInfo } from '../src/utils/documentDownloadService';
import { getApp } from '../server';
import fs from 'fs';
import path from 'path';

async function runProductionReadinessTests() {
  console.log('====================================================');
  console.log('  SUMMONS MITRA — PRODUCTION READINESS TEST SUITE  ');
  console.log('====================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(name: string, condition: boolean, details?: string) {
    if (condition) {
      console.log(`[PASS] ${name}`);
      passed++;
    } else {
      console.error(`[FAIL] ${name} ${details ? '— ' + details : ''}`);
      failed++;
    }
  }

  // 1. Static Assets & PWA Verification
  console.log('--- 1. PWA & Static Assets Audit ---');
  const manifestPath = path.join(process.cwd(), 'public', 'manifest.json');
  assert('manifest.json exists', fs.existsSync(manifestPath));
  if (fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert('manifest has valid name and icons', !!manifest.name && Array.isArray(manifest.icons) && manifest.icons.length >= 2);
  }

  const logoPath = path.join(process.cwd(), 'public', 'summonsmitra-logo.svg');
  assert('Official SVG logo exists in public/', fs.existsSync(logoPath));

  const swPath = path.join(process.cwd(), 'public', 'firebase-messaging-sw.js');
  assert('Firebase Messaging Service Worker exists in public/', fs.existsSync(swPath));

  const iconsDir = path.join(process.cwd(), 'public', 'icons');
  assert('PWA Icons directory exists', fs.existsSync(iconsDir));
  assert('icon-192.png exists', fs.existsSync(path.join(iconsDir, 'icon-192.png')));
  assert('icon-512.png exists', fs.existsSync(path.join(iconsDir, 'icon-512.png')));

  // 2. Vercel Configuration & Serverless Entrypoint
  console.log('\n--- 2. Vercel Configuration & Routing Audit ---');
  const vercelConfigPath = path.join(process.cwd(), 'vercel.json');
  assert('vercel.json exists', fs.existsSync(vercelConfigPath));
  if (fs.existsSync(vercelConfigPath)) {
    const vercelConfig = JSON.parse(fs.readFileSync(vercelConfigPath, 'utf8'));
    assert('vercel.json has SPA rewrites', Array.isArray(vercelConfig.rewrites) && vercelConfig.rewrites.length >= 2);
    assert('vercel.json has security headers', Array.isArray(vercelConfig.headers) && vercelConfig.headers.length > 0);
  }

  const apiIndexPath = path.join(process.cwd(), 'api', 'index.ts');
  assert('api/index.ts serverless function entrypoint exists', fs.existsSync(apiIndexPath));

  // 3. QR Decoding & CNR Extraction Unit Tests
  console.log('\n--- 3. Judicial QR & CNR Parser Unit Tests ---');
  const sampleCnr = 'DLCT010001232026';
  const cnrParsed = parseJudicialQR(sampleCnr);
  assert('Raw CNR string parsed correctly', cnrParsed.type === 'CNR' && cnrParsed.cnrNumber === sampleCnr);

  const sampleUrl = `https://services.ecourts.gov.in/ecourtindia_v6/?cnr_no=${sampleCnr}`;
  const urlParsed = parseJudicialQR(sampleUrl);
  assert('eCourts URL with cnr_no parameter parsed correctly', urlParsed.type === 'URL' && urlParsed.cnrNumber === sampleCnr);

  const sampleJson = JSON.stringify({ cnr: sampleCnr, case: 'FIR 12/2026' });
  const jsonParsed = parseJudicialQR(sampleJson);
  assert('JSON formatted Judicial QR parsed correctly', (jsonParsed.type === 'STRUCTURED' || jsonParsed.type === 'CNR') && jsonParsed.cnrNumber === sampleCnr);

  const invalidQr = validateQrLookupRequest({ qrPayload: '   ' });
  assert('Empty QR payload correctly rejected', !invalidQr.isValid);

  const validQr = validateQrLookupRequest({ qrPayload: sampleCnr, source: 'camera_scanner' });
  assert('Valid QR payload accepted by validator', validQr.isValid && validQr.sanitizedPayload === sampleCnr);

  // 4. Document Download Sanitizer Unit Tests
  console.log('\n--- 4. Document Download Service Tests ---');
  const sanitized = sanitizeFileName('SUM/DEL/2026/0482: Court Order*');
  assert('Sanitizes illegal filename characters for safe OS downloads', sanitized === 'SUM_DEL_2026_0482_Court_Order_');

  const formatInfo = getImageFormatInfo('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==');
  assert('Detects PNG mime type from data URL correctly', formatInfo.ext === 'png' && formatInfo.mimeType === 'image/png');

  // 5. Express API & Database Integration Test
  console.log('\n--- 5. Express Backend & Database Integration Tests ---');
  try {
    const { app, db } = await getApp();
    assert('Express app created successfully', !!app);
    assert('Database layer initialized', !!db);

    if (db) {
      // Test basic connection
      const testCol = db.collection('test_connection');
      const testDoc = { testId: 'audit_test_' + Date.now(), timestamp: new Date() };
      const insResult = await testCol.insertOne(testDoc);
      assert('Database insert test succeeded', !!insResult.insertedId);

      const fetched = await testCol.findOne({ _id: insResult.insertedId });
      assert('Database read back test succeeded', fetched?.testId === testDoc.testId);

      await testCol.deleteOne({ _id: insResult.insertedId });
      const verifyDeleted = await testCol.findOne({ _id: insResult.insertedId });
      assert('Database cleanup test succeeded', verifyDeleted === null);

      // Test 6: Summons CRUD in MongoDB collection 'summons'
      console.log('\n--- 6. MongoDB Summons Collection CRUD Tests ---');
      const testSummonId = 'test_sum_' + Date.now();
      const testUserId = 'test_officer_uid_101';
      const testSummonDoc = {
        _id: testSummonId,
        userId: testUserId,
        ownerId: testUserId,
        summonNumber: 'TEST/SUM/2026/001',
        caseNumber: 'FIR 101/2026 PS Connaught Place',
        personName: 'Test Accused Person',
        courtName: 'Tis Hazari District Court',
        hearingDate: '2026-10-15',
        status: 'Pending',
        urgency: 'High',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      // 1. Create / Upsert
      await db.collection('summons').updateOne(
        { _id: testSummonId },
        { $set: testSummonDoc },
        { upsert: true }
      );
      const insertedSummon = await db.collection('summons').findOne({ _id: testSummonId });
      assert('MongoDB summons document created and verified', insertedSummon?.personName === 'Test Accused Person');

      // 2. Read
      const userSummons = await db.collection('summons').find({ userId: testUserId }).toArray();
      assert('MongoDB summons queried by userId successfully', Array.isArray(userSummons) && userSummons.length >= 1);

      // 3. Update
      await db.collection('summons').updateOne(
        { _id: testSummonId, userId: testUserId },
        { $set: { status: 'Completed', servedDate: '2026-10-02', updatedAt: new Date().toISOString() } }
      );
      const updatedSummon = await db.collection('summons').findOne({ _id: testSummonId });
      assert('MongoDB summons updated and status verified', updatedSummon?.status === 'Completed' && updatedSummon?.servedDate === '2026-10-02');

      // 4. Delete & Cleanup
      const delResult = await db.collection('summons').deleteOne({ _id: testSummonId, userId: testUserId });
      assert('MongoDB summons deleted successfully', delResult.deletedCount === 1);
      const afterDel = await db.collection('summons').findOne({ _id: testSummonId });
      assert('MongoDB summons confirmed removed', afterDel === null);

      // Test 7: Witnesses CRUD in MongoDB collection 'witnesses'
      console.log('\n--- 7. MongoDB Witnesses Collection CRUD Tests ---');
      const testWitnessId = 'test_wit_' + Date.now();
      const testWitnessDoc = {
        _id: testWitnessId,
        userId: testUserId,
        ownerId: testUserId,
        name: 'Dr. Expert Witness',
        phone: '9876543210',
        caseNumber: 'FIR 101/2026',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      await db.collection('witnesses').updateOne(
        { _id: testWitnessId },
        { $set: testWitnessDoc },
        { upsert: true }
      );
      const insertedWit = await db.collection('witnesses').findOne({ _id: testWitnessId });
      assert('MongoDB witness document created and verified', insertedWit?.name === 'Dr. Expert Witness');

      await db.collection('witnesses').deleteOne({ _id: testWitnessId, userId: testUserId });
      const afterDelWit = await db.collection('witnesses').findOne({ _id: testWitnessId });
      assert('MongoDB witness cleaned up successfully', afterDelWit === null);

      // Test 8: Reviews CRUD in MongoDB collection 'reviews'
      console.log('\n--- 8. MongoDB Reviews Collection CRUD Tests ---');
      const testReviewDoc = {
        _id: testUserId,
        userId: testUserId,
        officerName: 'Inspector Sharma',
        badgeNumber: 'DL-POL-101',
        rank: 'Inspector',
        rating: 5,
        feedback: 'Outstanding summons management workflow and seamless tracking.',
        appVersion: '1.0.0',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      await db.collection('reviews').updateOne(
        { _id: testUserId },
        { $set: testReviewDoc },
        { upsert: true }
      );
      const savedReview = await db.collection('reviews').findOne({ _id: testUserId });
      assert('MongoDB review document created and verified', savedReview?.rating === 5 && savedReview?.officerName === 'Inspector Sharma');

      const allReviews = await db.collection('reviews').find({}).toArray();
      assert('MongoDB reviews list query returns saved records', Array.isArray(allReviews) && allReviews.length >= 1);

      await db.collection('reviews').deleteOne({ _id: testUserId });
      const afterDelReview = await db.collection('reviews').findOne({ _id: testUserId });
      assert('MongoDB review cleaned up successfully', afterDelReview === null);

      // Test 9: Notifications CRUD in MongoDB collection 'notifications'
      console.log('\n--- 9. MongoDB Notifications Collection CRUD Tests ---');
      const testNotifId = 'test_notif_' + Date.now();
      const testNotifDoc = {
        _id: testNotifId,
        userId: testUserId,
        title: 'Court Hearing Reminder',
        message: 'Upcoming court appearance scheduled for tomorrow at Tis Hazari.',
        type: 'HEARING_REMINDER',
        read: false,
        createdAt: new Date().toISOString(),
      };

      await db.collection('notifications').updateOne(
        { _id: testNotifId },
        { $set: testNotifDoc },
        { upsert: true }
      );
      const savedNotif = await db.collection('notifications').findOne({ _id: testNotifId });
      assert('MongoDB notification created and verified', savedNotif?.title === 'Court Hearing Reminder');

      await db.collection('notifications').deleteOne({ _id: testNotifId, userId: testUserId });
      const afterDelNotif = await db.collection('notifications').findOne({ _id: testNotifId });
      assert('MongoDB notification cleaned up successfully', afterDelNotif === null);
    }
  } catch (err: any) {
    assert('Express app and DB initialize without crash', false, err.message);
  }

  console.log('\n====================================================');
  console.log(`  TOTAL PASSED: ${passed} | TOTAL FAILED: ${failed}`);
  console.log('====================================================');

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runProductionReadinessTests().catch((e) => {
  console.error('Fatal test error:', e);
  process.exit(1);
});
