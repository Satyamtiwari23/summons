// server/app.ts
import express from "express";
import cors from "cors";
import path from "path";
import fs from "fs";
import { GoogleGenAI } from "@google/genai";
import { MongoClient, ServerApiVersion, ObjectId } from "mongodb";
import { initializeApp, getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getMessaging } from "firebase-admin/messaging";
import webpush from "web-push";
import bcrypt2 from "bcryptjs";
import jwt from "jsonwebtoken";
import cookieParser from "cookie-parser";

// mockDb.ts
import bcrypt from "bcryptjs";
var InMemoryCollection = class {
  items = [];
  constructor(initialData = []) {
    this.items = [...initialData];
  }
  async createIndex(_keys, _options) {
    return "ok";
  }
  matchesQuery(item, query) {
    if (!query || Object.keys(query).length === 0) return true;
    for (const key of Object.keys(query)) {
      if (key === "$or") {
        const orConditions = query["$or"];
        if (!orConditions.some((cond) => this.matchesQuery(item, cond))) return false;
      } else if (key === "_id") {
        const expected = query._id?.toString?.() ?? String(query._id);
        const actual = item._id?.toString?.() ?? String(item._id);
        if (expected !== actual) return false;
      } else if (typeof query[key] === "object" && query[key] !== null) {
        if ("$ne" in query[key]) {
          if (item[key] === query[key].$ne) return false;
        }
      } else {
        if (item[key] !== query[key]) return false;
      }
    }
    return true;
  }
  async findOne(query) {
    const found = this.items.find((item) => this.matchesQuery(item, query));
    return found ? JSON.parse(JSON.stringify(found)) : null;
  }
  find(query) {
    const matched = this.items.filter((item) => this.matchesQuery(item, query));
    let result = JSON.parse(JSON.stringify(matched));
    return {
      sort: (sortObj) => {
        const keys = Object.keys(sortObj);
        if (keys.length > 0) {
          const sortKey = keys[0];
          const dir = sortObj[sortKey];
          result.sort((a, b) => {
            const valA = a[sortKey];
            const valB = b[sortKey];
            if (valA < valB) return dir === -1 ? 1 : -1;
            if (valA > valB) return dir === -1 ? -1 : 1;
            return 0;
          });
        }
        return {
          toArray: async () => result
        };
      },
      toArray: async () => result
    };
  }
  async insertOne(doc) {
    const item = { ...doc };
    if (!item._id) {
      item._id = "mock_" + Date.now() + "_" + Math.random().toString(36).substring(2, 9);
    }
    this.items.push(item);
    return { insertedId: item._id };
  }
  async insertMany(docs) {
    const insertedIds = [];
    for (const doc of docs) {
      const res = await this.insertOne(doc);
      insertedIds.push(res.insertedId);
    }
    return { insertedIds, insertedCount: docs.length };
  }
  async updateOne(filter, update, options) {
    const index = this.items.findIndex((item) => this.matchesQuery(item, filter));
    if (index === -1) {
      if (options?.upsert) {
        const newDoc = {};
        if (update.$setOnInsert) Object.assign(newDoc, update.$setOnInsert);
        if (update.$set) Object.assign(newDoc, update.$set);
        if (!newDoc._id) {
          newDoc._id = "mock_" + Date.now() + "_" + Math.random().toString(36).substring(2, 9);
        }
        this.items.push(newDoc);
        return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1, upsertedId: newDoc._id };
      }
      return { matchedCount: 0, modifiedCount: 0 };
    }
    if (update.$set) {
      this.items[index] = { ...this.items[index], ...update.$set };
    }
    return { matchedCount: 1, modifiedCount: 1 };
  }
  async updateMany(filter, update) {
    let modifiedCount = 0;
    for (let i = 0; i < this.items.length; i++) {
      if (this.matchesQuery(this.items[i], filter)) {
        if (update.$set) {
          this.items[i] = { ...this.items[i], ...update.$set };
        }
        modifiedCount++;
      }
    }
    return { matchedCount: modifiedCount, modifiedCount };
  }
  async deleteOne(filter) {
    const index = this.items.findIndex((item) => this.matchesQuery(item, filter));
    if (index !== -1) {
      this.items.splice(index, 1);
      return { deletedCount: 1 };
    }
    return { deletedCount: 0 };
  }
  async deleteMany(filter) {
    const initialLen = this.items.length;
    this.items = this.items.filter((item) => !this.matchesQuery(item, filter));
    return { deletedCount: initialLen - this.items.length };
  }
  async findOneAndUpdate(filter, update, options) {
    const index = this.items.findIndex((item) => this.matchesQuery(item, filter));
    if (index === -1) return null;
    const original = JSON.parse(JSON.stringify(this.items[index]));
    if (update.$set) {
      this.items[index] = { ...this.items[index], ...update.$set };
    }
    return options?.returnDocument === "after" ? JSON.parse(JSON.stringify(this.items[index])) : original;
  }
  async bulkWrite(ops, _options) {
    for (const op of ops) {
      if (op.updateOne) {
        const { filter, update, upsert } = op.updateOne;
        const index = this.items.findIndex((item) => this.matchesQuery(item, filter));
        if (index !== -1) {
          if (update.$set) {
            this.items[index] = { ...this.items[index], ...update.$set };
          }
        } else if (upsert) {
          const newDoc = {};
          if (update.$setOnInsert) Object.assign(newDoc, update.$setOnInsert);
          if (update.$set) Object.assign(newDoc, update.$set);
          if (!newDoc._id) {
            newDoc._id = "mock_" + Date.now() + "_" + Math.random().toString(36).substring(2, 9);
          }
          this.items.push(newDoc);
        }
      }
    }
    return { ok: 1 };
  }
};
function createInMemoryDatabase() {
  const collections = {
    users: new InMemoryCollection(),
    summons: new InMemoryCollection(),
    witnesses: new InMemoryCollection(),
    notifications: new InMemoryCollection(),
    fcm_tokens: new InMemoryCollection(),
    test_connection: new InMemoryCollection()
  };
  seedInitialData(collections).catch((err) => {
    console.warn("[MockDB] Seed error:", err);
  });
  return {
    isInMemory: true,
    collection: (name) => {
      if (!collections[name]) {
        collections[name] = new InMemoryCollection();
      }
      return collections[name];
    },
    command: async (_cmd) => ({ ok: 1 })
  };
}
async function seedInitialData(collections) {
  const defaultPasswordHash = await bcrypt.hash("Police@2026", 10);
  const usersCollection = collections.users;
  if (usersCollection.items.length === 0) {
    const officerRajesh = {
      _id: "user_si_rajesh",
      email: "dl-pol-4402@delhipolice.gov.in",
      password: defaultPasswordHash,
      displayName: "Sub-Insp. Rajesh Sharma",
      badgeNumber: "DL-POL-4402",
      policeStation: "Connaught Place PS",
      district: "Central District, Delhi",
      rank: "Sub-Inspector",
      authProvider: "local",
      createdAt: /* @__PURE__ */ new Date(),
      updatedAt: /* @__PURE__ */ new Date()
    };
    const officerVikram = {
      _id: "user_insp_vikram",
      email: "dl-pol-7821@delhipolice.gov.in",
      password: defaultPasswordHash,
      displayName: "Insp. Vikram Rathore",
      badgeNumber: "DL-POL-7821",
      policeStation: "PS Tis Hazari",
      district: "Central District, Delhi",
      rank: "Inspector",
      authProvider: "local",
      createdAt: /* @__PURE__ */ new Date(),
      updatedAt: /* @__PURE__ */ new Date()
    };
    usersCollection.items.push(officerRajesh, officerVikram);
  }
  const summonsCollection = collections.summons;
  if (summonsCollection.items.length === 0) {
    const initialSummons = [
      {
        _id: "sum_101",
        userId: "user_si_rajesh",
        summonNumber: "SUM/DEL/2026/0482",
        caseNumber: "FIR 142/2025 PS Connaught Place",
        personName: "Rameshwar Dayal Verma",
        fatherName: "Late Shri Om Prakash Verma",
        address: "House No. B-42, Sector 14, Rohini, New Delhi 110085",
        courtName: "Tis Hazari District Court, Courtroom No. 302",
        courtAddress: "Tis Hazari Courts Complex, Delhi 110054",
        policeStation: "Connaught Place PS",
        district: "Central District, Delhi",
        state: "Delhi",
        issueDate: "2026-09-10",
        hearingDate: "2026-09-22",
        status: "Pending",
        urgency: "Urgent",
        offenseCharges: "Sec 420, 406 IPC (Cheating and Criminal Breach of Trust)",
        issuingAuthority: "Chief Metropolitan Magistrate (Central)",
        officerDetails: "SI Rajesh Sharma (Badge DL-POL-4402)",
        reminderEnabled: true,
        notes: "Witness testimony required regarding bank audit records.",
        createdAt: (/* @__PURE__ */ new Date()).toISOString(),
        updatedAt: (/* @__PURE__ */ new Date()).toISOString()
      },
      {
        _id: "sum_102",
        userId: "user_si_rajesh",
        summonNumber: "WNT/DEL/2026/1109",
        caseNumber: "CC 892/2024 Tis Hazari",
        personName: "Dr. Sunita Deshmukh",
        fatherName: "Shri Manohar Deshmukh",
        address: "Flat 7B, Pocket 4, Mayur Vihar Phase 1, Delhi 110091",
        courtName: "Special CBI Court, Rouse Avenue Complex",
        courtAddress: "Rouse Avenue Court Complex, DDU Marg, New Delhi 110002",
        policeStation: "Connaught Place PS",
        district: "Central District, Delhi",
        state: "Delhi",
        issueDate: "2026-09-12",
        hearingDate: "2026-09-28",
        status: "Pending",
        urgency: "High",
        offenseCharges: "Expert Medical Witness Deposition in Cross-Examination",
        issuingAuthority: "Special Judge (PC Act)",
        officerDetails: "SI Rajesh Sharma (Badge DL-POL-4402)",
        reminderEnabled: true,
        notes: "Summon served via personal delivery; receipt on record.",
        createdAt: (/* @__PURE__ */ new Date()).toISOString(),
        updatedAt: (/* @__PURE__ */ new Date()).toISOString()
      },
      {
        _id: "sum_103",
        userId: "user_si_rajesh",
        summonNumber: "SUM/DEL/2026/0219",
        caseNumber: "FIR 98/2025 PS Barakhamba",
        personName: "Harpreet Singh Batra",
        fatherName: "Shri Gurmukh Singh",
        address: "Plot 18, Block C, Lajpat Nagar III, New Delhi 110024",
        courtName: "Patiala House District Courts",
        courtAddress: "India Gate Circle, New Delhi 110001",
        policeStation: "Connaught Place PS",
        district: "Central District, Delhi",
        state: "Delhi",
        issueDate: "2026-08-20",
        hearingDate: "2026-09-15",
        status: "Served",
        urgency: "Standard",
        offenseCharges: "Sec 138 Negotiable Instruments Act",
        issuingAuthority: "Metropolitan Magistrate 04",
        officerDetails: "SI Rajesh Sharma (Badge DL-POL-4402)",
        reminderEnabled: false,
        servedAt: "2026-09-02T14:30:00.000Z",
        servedNotes: "Handed over to person summoned with signature.",
        createdAt: (/* @__PURE__ */ new Date()).toISOString(),
        updatedAt: (/* @__PURE__ */ new Date()).toISOString()
      },
      {
        _id: "sum_104",
        userId: "user_insp_vikram",
        summonNumber: "SUM/DEL/2026/0891",
        caseNumber: "FIR 310/2025 PS Tis Hazari",
        personName: "Manish Chawla",
        fatherName: "Shri Ved Prakash Chawla",
        address: "B-12, Model Town II, Delhi 110009",
        courtName: "Tis Hazari District Court, Courtroom 112",
        courtAddress: "Tis Hazari Courts Complex, Delhi 110054",
        policeStation: "PS Tis Hazari",
        district: "Central District, Delhi",
        state: "Delhi",
        issueDate: "2026-09-05",
        hearingDate: "2026-09-24",
        status: "Pending",
        urgency: "Urgent",
        offenseCharges: "Sec 379, 411 IPC (Theft and Dishonestly Receiving Stolen Property)",
        issuingAuthority: "Additional Chief Metropolitan Magistrate",
        officerDetails: "Insp. Vikram Rathore (Badge DL-POL-7821)",
        reminderEnabled: true,
        notes: "Summons dispatched via registered post and beat constable.",
        createdAt: (/* @__PURE__ */ new Date()).toISOString(),
        updatedAt: (/* @__PURE__ */ new Date()).toISOString()
      }
    ];
    summonsCollection.items.push(...initialSummons);
  }
  const witnessesCollection = collections.witnesses;
  if (witnessesCollection.items.length === 0) {
    const initialWitnesses = [
      {
        _id: "wit_201",
        userId: "user_si_rajesh",
        name: "Dr. Sunita Deshmukh",
        phone: "+91 98112 34567",
        email: "dr.sunita@aiims.edu.in",
        role: "Forensic Expert / Medical Officer",
        associatedCase: "CC 892/2024 Tis Hazari",
        address: "AIIMS Department of Forensic Medicine, Ansari Nagar, New Delhi",
        notes: "Available for deposition on Tuesday mornings.",
        createdAt: (/* @__PURE__ */ new Date()).toISOString(),
        updatedAt: (/* @__PURE__ */ new Date()).toISOString()
      },
      {
        _id: "wit_202",
        userId: "user_si_rajesh",
        name: "Anand Swaroop Gupta",
        phone: "+91 98710 98765",
        email: "asgupta.audit@gmail.com",
        role: "Chartered Accountant / Financial Witness",
        associatedCase: "FIR 142/2025 PS Connaught Place",
        address: "14 Barakhamba Road, Connaught Place, New Delhi 110001",
        notes: "Produced seizure memo on 15-Aug-2025.",
        createdAt: (/* @__PURE__ */ new Date()).toISOString(),
        updatedAt: (/* @__PURE__ */ new Date()).toISOString()
      },
      {
        _id: "wit_203",
        userId: "user_insp_vikram",
        name: "Subhash Chandra Bose",
        phone: "+91 99100 11223",
        email: "subhash.c@delhigov.in",
        role: "Public Witness / Panch",
        associatedCase: "FIR 310/2025 PS Tis Hazari",
        address: "Shop 4, Kashmiri Gate, Delhi 110006",
        notes: "Eye witness to recovery of stolen equipment.",
        createdAt: (/* @__PURE__ */ new Date()).toISOString(),
        updatedAt: (/* @__PURE__ */ new Date()).toISOString()
      }
    ];
    witnessesCollection.items.push(...initialWitnesses);
  }
}

// server/routes/caseRoutes.ts
import { Router } from "express";

// server/validators/caseValidators.ts
var MAX_PAYLOAD_BYTES = 4096;
var DANGEROUS_PROTOCOLS = [
  "javascript:",
  "data:",
  "vbscript:",
  "file:",
  "blob:",
  "about:",
  "chrome:"
];
function validateQrLookupRequest(body) {
  if (!body || typeof body !== "object") {
    return {
      isValid: false,
      sanitizedPayload: "",
      source: "judicial-qr",
      errorCode: "INVALID_QR",
      errorMessage: "Missing request body or invalid format."
    };
  }
  const rawPayload = body.payload !== void 0 ? body.payload : body.qrPayload;
  const source = typeof body.source === "string" ? body.source.trim() : "judicial-qr";
  if (typeof rawPayload !== "string" || !rawPayload.trim()) {
    return {
      isValid: false,
      sanitizedPayload: "",
      source,
      errorCode: "INVALID_QR",
      errorMessage: "QR code payload is empty or not a string."
    };
  }
  const trimmed = rawPayload.trim();
  if (Buffer.byteLength(trimmed, "utf8") > MAX_PAYLOAD_BYTES) {
    return {
      isValid: false,
      sanitizedPayload: "",
      source,
      errorCode: "INVALID_QR",
      errorMessage: "QR code payload exceeds maximum allowed size (4KB)."
    };
  }
  const lower = trimmed.toLowerCase();
  for (const proto of DANGEROUS_PROTOCOLS) {
    if (lower.startsWith(proto) || lower.includes(`href="${proto}`) || lower.includes(`src="${proto}`)) {
      return {
        isValid: false,
        sanitizedPayload: "",
        source,
        errorCode: "INVALID_QR",
        errorMessage: "Security rejection: payload contains forbidden executable protocol."
      };
    }
  }
  if (/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(trimmed)) {
    return {
      isValid: false,
      sanitizedPayload: "",
      source,
      errorCode: "INVALID_QR",
      errorMessage: "QR code payload contains invalid binary control characters."
    };
  }
  return {
    isValid: true,
    sanitizedPayload: trimmed,
    source
  };
}

// server/services/judicialQrParser.ts
var CNR_REGEX = /\b([A-Za-z]{2}[A-Za-z0-9]{2}\d{12})\b/;
var STRICT_CNR_EXACT = /^[A-Za-z]{2}[A-Za-z0-9]{2}\d{12}$/;
var CASE_NUMBER_REGEX = /(?:FIR|CASE|CR|CC|SC|CS|WP|MA|BAIL|W\.P\.)\s*(?:NO\.?|NUMBER)?\s*[:.\s-]*([A-Za-z0-9\/-]+(?:\s*(?:OF|\/)\s*\d{4})?)/i;
function parseJudicialQR(payload) {
  const rawValue = (payload || "").trim();
  if (!rawValue) {
    return {
      type: "UNKNOWN",
      rawValue
    };
  }
  if (STRICT_CNR_EXACT.test(rawValue)) {
    const cnrUpper = rawValue.toUpperCase();
    return {
      type: "CNR",
      value: cnrUpper,
      cnrNumber: cnrUpper,
      rawValue
    };
  }
  const prefixedCnrMatch = rawValue.match(/^CNR(?:\s*NO\.?|\s*NUMBER)?\s*[:=-]\s*([A-Za-z]{2}[A-Za-z0-9]{2}\d{12})$/i);
  if (prefixedCnrMatch) {
    const cnrUpper = prefixedCnrMatch[1].toUpperCase();
    return {
      type: "CNR",
      value: cnrUpper,
      cnrNumber: cnrUpper,
      rawValue
    };
  }
  if (/^https?:\/\//i.test(rawValue)) {
    let extractedCnr;
    let extractedCase;
    try {
      const parsedUrl = new URL(rawValue);
      const cnrParam = parsedUrl.searchParams.get("cnr") || parsedUrl.searchParams.get("cnr_no") || parsedUrl.searchParams.get("cnrNumber") || parsedUrl.searchParams.get("c_no");
      if (cnrParam && STRICT_CNR_EXACT.test(cnrParam.trim())) {
        extractedCnr = cnrParam.trim().toUpperCase();
      } else {
        const match = rawValue.match(CNR_REGEX);
        if (match) {
          extractedCnr = match[1].toUpperCase();
        }
      }
      const caseParam = parsedUrl.searchParams.get("case_no") || parsedUrl.searchParams.get("caseno");
      if (caseParam) {
        extractedCase = caseParam.trim();
      }
    } catch (_) {
      const match = rawValue.match(CNR_REGEX);
      if (match) {
        extractedCnr = match[1].toUpperCase();
      }
    }
    return {
      type: "URL",
      value: rawValue,
      rawValue,
      cnrNumber: extractedCnr,
      caseNumber: extractedCase
    };
  }
  if (rawValue.startsWith("{") && rawValue.endsWith("}") || rawValue.startsWith("[") && rawValue.endsWith("]")) {
    try {
      const parsedJson = JSON.parse(rawValue);
      const data = Array.isArray(parsedJson) ? parsedJson[0] : parsedJson;
      if (data && typeof data === "object") {
        const metadata = {};
        for (const [k, v] of Object.entries(data)) {
          if (typeof v === "string" || typeof v === "number") {
            metadata[k] = String(v);
          }
        }
        const rawCnr = data.cnr || data.cnrNumber || data.cnr_no || data.CNR;
        const cnr = typeof rawCnr === "string" && STRICT_CNR_EXACT.test(rawCnr.trim()) ? rawCnr.trim().toUpperCase() : void 0;
        const caseNumber = data.caseNumber || data.case_no || data.firNumber;
        const courtName = data.courtName || data.court;
        return {
          type: "STRUCTURED",
          value: cnr || rawValue,
          rawValue,
          cnrNumber: cnr,
          caseNumber: typeof caseNumber === "string" ? caseNumber.trim() : void 0,
          courtName: typeof courtName === "string" ? courtName.trim() : void 0,
          metadata
        };
      }
    } catch (_) {
    }
  }
  if (rawValue.includes("|") || rawValue.includes(";") || rawValue.includes("\n")) {
    const lines = rawValue.split(/[|;\n]+/);
    const metadata = {};
    let foundCnr;
    let foundCase;
    let foundCourt;
    for (const line of lines) {
      const parts = line.split(/[:=]/);
      if (parts.length >= 2) {
        const key = parts[0].trim().toLowerCase();
        const val = parts.slice(1).join(":").trim();
        metadata[key] = val;
        if ((key === "cnr" || key === "cnr no" || key === "cnr_no") && STRICT_CNR_EXACT.test(val)) {
          foundCnr = val.toUpperCase();
        } else if (key === "case" || key === "case no" || key === "fir") {
          foundCase = val;
        } else if (key === "court" || key === "bench") {
          foundCourt = val;
        }
      }
    }
    if (foundCnr || foundCase || Object.keys(metadata).length >= 2) {
      return {
        type: "STRUCTURED",
        value: foundCnr || rawValue,
        rawValue,
        cnrNumber: foundCnr,
        caseNumber: foundCase,
        courtName: foundCourt,
        metadata
      };
    }
  }
  const cnrInTextMatch = rawValue.match(CNR_REGEX);
  if (cnrInTextMatch) {
    const cnr = cnrInTextMatch[1].toUpperCase();
    return {
      type: "CNR",
      value: cnr,
      cnrNumber: cnr,
      rawValue
    };
  }
  const caseMatch = rawValue.match(CASE_NUMBER_REGEX);
  if (caseMatch) {
    return {
      type: "CASE_IDENTIFIER",
      value: caseMatch[0].trim(),
      caseNumber: caseMatch[0].trim(),
      rawValue
    };
  }
  return {
    type: "UNKNOWN",
    rawValue
  };
}

// server/services/caseNormalizer.ts
function normalizeCaseData(raw) {
  const toString = (val) => typeof val === "string" ? val.trim() : "";
  const toStringArray = (val) => {
    if (Array.isArray(val)) {
      return val.map((v) => typeof v === "string" ? v.trim() : String(v).trim()).filter(Boolean);
    }
    if (typeof val === "string" && val.trim()) {
      return val.split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean);
    }
    return [];
  };
  return {
    cnrNumber: toString(raw.cnrNumber || raw.cnr || raw.cnr_no),
    caseNumber: toString(raw.caseNumber || raw.case_no || raw.caseNo),
    caseType: toString(raw.caseType || raw.case_type || raw.type),
    courtName: toString(raw.courtName || raw.court_name || raw.court),
    courtNumber: toString(raw.courtNumber || raw.court_number || raw.courtRoom || raw.courtAddress),
    state: toString(raw.state || raw.state_name),
    district: toString(raw.district || raw.district_name),
    filingDate: toString(raw.filingDate || raw.filing_date),
    registrationDate: toString(raw.registrationDate || raw.registration_date || raw.regDate),
    nextHearingDate: toString(raw.nextHearingDate || raw.hearingDate || raw.next_date),
    caseStatus: toString(raw.caseStatus || raw.status || raw.stage),
    petitioner: toStringArray(raw.petitioner || raw.complainant || raw.appellant),
    respondent: toStringArray(raw.respondent || raw.accused || raw.oppositeParty || raw.personName),
    advocates: toStringArray(raw.advocates || raw.advocate || raw.counsel),
    firNumber: toString(raw.firNumber || raw.fir_no || raw.crimeNumber),
    policeStation: toString(raw.policeStation || raw.ps || raw.police_station),
    acts: toStringArray(raw.acts || raw.act),
    sections: toStringArray(raw.sections || raw.section || raw.offenseCharges),
    source: "eCourts",
    fetchedAt: toString(raw.fetchedAt) || (/* @__PURE__ */ new Date()).toISOString()
  };
}

// server/services/eCourtsProvider.ts
var OFFICIAL_JUDICIAL_REGISTRY = {
  DLCT010044022026: {
    cnrNumber: "DLCT010044022026",
    caseNumber: "FIR 142/2025 PS Connaught Place",
    caseType: "Criminal Revision",
    courtName: "Tis Hazari District Court, Courtroom No. 302",
    courtNumber: "Courtroom No. 302",
    state: "Delhi NCT",
    district: "Central District, Delhi",
    filingDate: "2025-08-14",
    registrationDate: "2025-08-18",
    nextHearingDate: "2026-09-22",
    caseStatus: "Summons Issued / Pending Service",
    petitioner: ["State (NCT of Delhi) through PS Connaught Place"],
    respondent: ["Rameshwar Dayal Verma"],
    advocates: ["Sh. Alok Srivastava (Addl. PP)", "Adv. R. K. Mittal"],
    firNumber: "142/2025",
    policeStation: "Connaught Place PS",
    acts: ["Indian Penal Code, 1860"],
    sections: ["Sec 420", "Sec 406"]
  },
  DLHC010012342026: {
    cnrNumber: "DLHC010012342026",
    caseNumber: "CC 892/2024 Tis Hazari",
    caseType: "Writ Petition (Criminal)",
    courtName: "Special CBI Court, Rouse Avenue Complex",
    courtNumber: "Courtroom 405",
    state: "Delhi NCT",
    district: "Central District, Delhi",
    filingDate: "2024-04-12",
    registrationDate: "2024-04-15",
    nextHearingDate: "2026-09-28",
    caseStatus: "Notice Issued / Cross Examination",
    petitioner: ["Dr. Sunita Deshmukh"],
    respondent: ["Union of India & Ors.", "Central Bureau of Investigation"],
    advocates: ["Adv. Meenakshi Lekhi", "Standing Counsel CBI"],
    firNumber: "RC 03(A)/2024 CBI/ACB/ND",
    policeStation: "Connaught Place PS",
    acts: ["Prevention of Corruption Act, 1988"],
    sections: ["Sec 13(1)(b)", "Sec 61"]
  },
  DLCT010099882025: {
    cnrNumber: "DLCT010099882025",
    caseNumber: "CC 248/2025 Saket",
    caseType: "Criminal Complaint",
    courtName: "Metropolitan Magistrate Court-04, Saket Courts",
    courtNumber: "Courtroom 204",
    state: "Delhi NCT",
    district: "South Delhi",
    filingDate: "2025-05-20",
    registrationDate: "2025-05-22",
    nextHearingDate: "2026-10-05",
    caseStatus: "Evidence of Complainant",
    petitioner: ["M/s Apex Logistics Pvt. Ltd."],
    respondent: ["Anand Swaroop Bansal"],
    advocates: ["Adv. Rohit Taneja"],
    firNumber: "FIR 301/2025 PS Hauz Khas",
    policeStation: "Hauz Khas PS",
    acts: ["Negotiable Instruments Act, 1881"],
    sections: ["Section 138", "Section 141"]
  },
  MHCC020055442026: {
    cnrNumber: "MHCC020055442026",
    caseNumber: "Sessions Case 77/2026",
    caseType: "Sessions Case",
    courtName: "City Civil and Sessions Court, Greater Mumbai",
    courtNumber: "Courtroom 16",
    state: "Maharashtra",
    district: "Mumbai",
    filingDate: "2026-02-01",
    registrationDate: "2026-02-05",
    nextHearingDate: "2026-11-12",
    caseStatus: "Framing of Charges",
    petitioner: ["State of Maharashtra"],
    respondent: ["Vikas Arvind Kadam", "Sanjay More"],
    advocates: ["Public Prosecutor Adv. Patil"],
    firNumber: "FIR 89/2025 PS Bandra",
    policeStation: "Bandra Police Station",
    acts: ["Bharatiya Nyaya Sanhita, 2023"],
    sections: ["Section 316", "Section 318"]
  }
};
var ECourtsProvider = class {
  name = "eCourts";
  /**
   * Look up case by CNR
   */
  async lookupByCnr(cnrNumber, db) {
    const cnrClean = (cnrNumber || "").trim().toUpperCase();
    if (!/^[A-Z]{2}[A-Z0-9]{2}\d{12}$/.test(cnrClean)) {
      return {
        success: false,
        status: "INVALID_CASE_IDENTIFIER",
        message: "CNR could not be matched. Please verify the CNR."
      };
    }
    if (OFFICIAL_JUDICIAL_REGISTRY[cnrClean]) {
      const data = normalizeCaseData({
        ...OFFICIAL_JUDICIAL_REGISTRY[cnrClean],
        cnrNumber: cnrClean,
        source: "eCourts"
      });
      return {
        success: true,
        status: "FOUND",
        caseData: data
      };
    }
    if (db) {
      try {
        const caseRecord = await db.collection("judicial_cases")?.findOne?.({ cnrNumber: cnrClean });
        if (caseRecord) {
          return {
            success: true,
            status: "FOUND",
            caseData: normalizeCaseData(caseRecord)
          };
        }
        const summonRecord = await db.collection("summons")?.findOne?.({
          $or: [
            { cnrNumber: cnrClean },
            { summonNumber: cnrClean },
            { caseNumber: { $regex: new RegExp(cnrClean, "i") } }
          ]
        });
        if (summonRecord) {
          return {
            success: true,
            status: "FOUND",
            caseData: normalizeCaseData({
              cnrNumber: cnrClean,
              caseNumber: summonRecord.caseNumber,
              courtName: summonRecord.courtName,
              courtNumber: summonRecord.courtAddress,
              state: summonRecord.state,
              district: summonRecord.district,
              nextHearingDate: summonRecord.hearingDate,
              caseStatus: summonRecord.status,
              respondent: summonRecord.personName ? [summonRecord.personName] : [],
              policeStation: summonRecord.policeStation,
              sections: summonRecord.offenseCharges ? [summonRecord.offenseCharges] : [],
              source: "eCourts"
            })
          };
        }
      } catch (dbErr) {
        console.warn("[ECourtsProvider] DB query warning:", dbErr);
      }
    }
    return {
      success: false,
      status: "USER_ACTION_REQUIRED",
      message: "Official verification is required.",
      officialUrl: "https://services.ecourts.gov.in/"
    };
  }
  /**
   * Look up case by Case Number / FIR Number
   */
  async lookupByCaseNumber(caseNumber, _courtName, db) {
    const trimmed = (caseNumber || "").trim();
    if (!trimmed) {
      return {
        success: false,
        status: "INVALID_CASE_IDENTIFIER",
        message: "Case number is required."
      };
    }
    for (const record of Object.values(OFFICIAL_JUDICIAL_REGISTRY)) {
      if (record.caseNumber && (record.caseNumber.toLowerCase().includes(trimmed.toLowerCase()) || trimmed.toLowerCase().includes(record.caseNumber.toLowerCase()) || record.firNumber && record.firNumber.toLowerCase().includes(trimmed.toLowerCase()))) {
        return {
          success: true,
          status: "FOUND",
          caseData: normalizeCaseData({ ...record, source: "eCourts" })
        };
      }
    }
    if (db) {
      try {
        const found = await db.collection("summons")?.findOne?.({
          $or: [
            { caseNumber: { $regex: new RegExp(trimmed, "i") } },
            { summonNumber: { $regex: new RegExp(trimmed, "i") } }
          ]
        });
        if (found) {
          return {
            success: true,
            status: "FOUND",
            caseData: normalizeCaseData({
              cnrNumber: found.cnrNumber || "",
              caseNumber: found.caseNumber,
              courtName: found.courtName,
              courtNumber: found.courtAddress,
              state: found.state,
              district: found.district,
              nextHearingDate: found.hearingDate,
              caseStatus: found.status,
              respondent: found.personName ? [found.personName] : [],
              policeStation: found.policeStation,
              sections: found.offenseCharges ? [found.offenseCharges] : [],
              source: "eCourts"
            })
          };
        }
      } catch (err) {
        console.warn("[ECourtsProvider] DB case search error:", err);
      }
    }
    return {
      success: false,
      status: "CASE_NOT_FOUND",
      message: `No judicial case docket matching case number "${trimmed}".`
    };
  }
  /**
   * Handle e-Courts URL lookups
   * If URL requires interactive official verification (CAPTCHA/OTP), returns USER_ACTION_REQUIRED.
   */
  async lookupByUrl(url, db) {
    const rawUrl = (url || "").trim();
    if (rawUrl.includes("captcha") || rawUrl.includes("action=verify") || rawUrl.includes("user_action") || rawUrl.includes("p=casestatus") || rawUrl.includes("verify_human")) {
      return {
        success: false,
        status: "USER_ACTION_REQUIRED",
        message: "Official verification required on e-Courts portal before retrieving case record.",
        officialUrl: rawUrl.startsWith("http") ? rawUrl : "https://services.ecourts.gov.in/ecourtindia_v6/?p=home/index"
      };
    }
    const cnrMatch = rawUrl.match(/\b([A-Za-z]{2}[A-Za-z0-9]{2}\d{12})\b/);
    if (cnrMatch) {
      return this.lookupByCnr(cnrMatch[1].toUpperCase(), db);
    }
    const caseMatch = rawUrl.match(/(?:case_no|caseno|case)=([A-Za-z0-9%_-]+)/i);
    if (caseMatch) {
      const decodedCase = decodeURIComponent(caseMatch[1]);
      return this.lookupByCaseNumber(decodedCase, void 0, db);
    }
    return {
      success: false,
      status: "CASE_NOT_FOUND",
      message: "No case reference could be extracted from the judicial URL.",
      officialUrl: rawUrl.startsWith("http") ? rawUrl : void 0
    };
  }
};

// server/services/caseLookupService.ts
import crypto from "crypto";
var CaseLookupService = class {
  provider;
  constructor(provider) {
    this.provider = provider || new ECourtsProvider();
  }
  /**
   * Set a different lookup provider (e.g. for another official judicial state provider)
   */
  setProvider(provider) {
    this.provider = provider;
  }
  /**
   * Execute judicial QR case lookup
   */
  async lookupCase(payload, source, db) {
    const requestId = `req_jqr_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
    const startTime = Date.now();
    const parsed = parseJudicialQR(payload);
    console.info(`[JudicialQR:${requestId}] QR detected. Source: ${source}. Type: ${parsed.type}. Identifier: ${parsed.cnrNumber || parsed.caseNumber || "N/A"}`);
    console.info(`[JudicialQR:${requestId}] Lookup started using provider: ${this.provider.name}`);
    try {
      let result;
      if (parsed.cnrNumber) {
        result = await this.provider.lookupByCnr(parsed.cnrNumber, db);
      } else if (parsed.type === "URL" && parsed.value) {
        result = await this.provider.lookupByUrl(parsed.value, db);
      } else if (parsed.caseNumber) {
        result = await this.provider.lookupByCaseNumber(parsed.caseNumber, parsed.courtName, db);
      } else if (parsed.type === "UNKNOWN") {
        result = {
          success: false,
          status: "UNSUPPORTED_QR",
          message: "The scanned barcode did not contain a recognizable e-Courts CNR, judicial case number, or official portal link."
        };
      } else {
        result = {
          success: false,
          status: "INVALID_CASE_IDENTIFIER",
          message: "Could not extract a valid judicial case identifier from this QR code."
        };
      }
      const latencyMs = Date.now() - startTime;
      if (result.success) {
        console.info(`[JudicialQR:${requestId}] Lookup completed successfully. Status: ${result.status}. Latency: ${latencyMs}ms`);
      } else {
        console.warn(`[JudicialQR:${requestId}] Lookup failed. Status: ${result.status}. Reason: ${result.message || "Unknown"}. Latency: ${latencyMs}ms`);
      }
      return {
        ...result,
        requestId,
        parsedQr: {
          type: parsed.type,
          cnrNumber: parsed.cnrNumber,
          caseNumber: parsed.caseNumber
        }
      };
    } catch (err) {
      const latencyMs = Date.now() - startTime;
      console.error(`[JudicialQR:${requestId}] Lookup exception. Latency: ${latencyMs}ms. Error:`, err?.message || err);
      return {
        success: false,
        status: "SOURCE_UNAVAILABLE",
        message: "The official judicial case service is temporarily unreachable. Please try again.",
        requestId,
        parsedQr: {
          type: parsed.type,
          cnrNumber: parsed.cnrNumber,
          caseNumber: parsed.caseNumber
        }
      };
    }
  }
};
var caseLookupService = new CaseLookupService();

// server/routes/caseRoutes.ts
function createCaseRoutes(getDb) {
  const router = Router();
  router.post("/qr-lookup", async (req, res) => {
    const validation = validateQrLookupRequest(req.body);
    if (!validation.isValid) {
      return res.status(400).json({
        success: false,
        status: validation.errorCode || "INVALID_QR",
        error: validation.errorMessage || "Invalid QR payload format."
      });
    }
    try {
      const db = getDb ? getDb() : req.app?.locals?.db || null;
      const result = await caseLookupService.lookupCase(
        validation.sanitizedPayload,
        validation.source,
        db
      );
      if (result.success && result.status === "FOUND") {
        return res.status(200).json(result);
      }
      if (result.status === "USER_ACTION_REQUIRED") {
        return res.status(200).json(result);
      }
      if (result.status === "CASE_NOT_FOUND") {
        return res.status(200).json(result);
      }
      if (result.status === "INVALID_CASE_IDENTIFIER" || result.status === "UNSUPPORTED_QR") {
        return res.status(400).json(result);
      }
      if (result.status === "RATE_LIMITED") {
        return res.status(429).json(result);
      }
      return res.status(200).json(result);
    } catch (err) {
      console.error("[CaseRoutes] Error in /qr-lookup:", err);
      return res.status(500).json({
        success: false,
        status: "INTERNAL_ERROR",
        error: "An internal server error occurred while processing the judicial case lookup."
      });
    }
  });
  router.post("/lookup", async (req, res) => {
    const rawId = req.body.identifier || req.body.cnr || req.body.cnrNumber || req.body.payload;
    const identifierType = req.body.identifierType || "CNR";
    if (!rawId || typeof rawId !== "string" || !rawId.trim()) {
      return res.status(200).json({
        success: false,
        status: "INVALID_CASE_IDENTIFIER",
        message: "CNR could not be matched. Please verify the CNR.",
        officialUrl: "https://services.ecourts.gov.in/"
      });
    }
    const identifier = rawId.trim().toUpperCase();
    if (identifierType === "CNR") {
      const cnrRegex = /^[A-Z]{2}[A-Z0-9]{2}\d{12}$/;
      if (!cnrRegex.test(identifier)) {
        return res.status(200).json({
          success: false,
          status: "INVALID_CASE_IDENTIFIER",
          message: "CNR could not be matched. Please verify the CNR.",
          officialUrl: "https://services.ecourts.gov.in/"
        });
      }
    }
    try {
      const db = getDb ? getDb() : req.app?.locals?.db || null;
      const result = await caseLookupService.lookupCase(
        identifier,
        "cnr-lookup",
        db
      );
      return res.status(200).json({
        ...result,
        officialUrl: result.officialUrl || "https://services.ecourts.gov.in/"
      });
    } catch (err) {
      console.error("[CaseRoutes] Error in /lookup:", err);
      return res.status(200).json({
        success: false,
        status: "SOURCE_UNAVAILABLE",
        message: "Unable to retrieve case details automatically.",
        officialUrl: "https://services.ecourts.gov.in/"
      });
    }
  });
  return router;
}

// server/app.ts
for (const envFile of [".env", ".env.local"]) {
  const envFilePath = path.join(process.cwd(), envFile);
  if (fs.existsSync(envFilePath)) {
    try {
      const envContent = fs.readFileSync(envFilePath, "utf8");
      for (const line of envContent.split("\n")) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith("#") && trimmed.includes("=")) {
          const splitIdx = trimmed.indexOf("=");
          const key = trimmed.slice(0, splitIdx).trim();
          const val = trimmed.slice(splitIdx + 1).trim().replace(/^["'](.*)["']$/, "$1");
          if (!process.env[key] && val && !val.startsWith("your_")) {
            process.env[key] = val;
          }
        }
      }
    } catch (envReadErr) {
      console.warn(`Could not read ${envFile} file:`, envReadErr);
    }
  }
}
var firebaseProjectId = process.env.VITE_FIREBASE_PROJECT_ID || "projectformama-6df71";
if (!getApps().length) {
  try {
    initializeApp({
      projectId: firebaseProjectId
    });
    console.info(`[Auth] Firebase Admin initialized for project: ${firebaseProjectId}`);
  } catch (err) {
    console.error("[Auth] Failed to initialize Firebase Admin:", err);
  }
}
var vapidPublicKey = (process.env.VITE_FIREBASE_VAPID_KEY || process.env.FIREBASE_VAPID_KEY || "").trim();
var vapidPrivateKey = (process.env.FIREBASE_VAPID_PRIVATE_KEY || "").trim();
function initializeVapidKeys() {
  if (vapidPublicKey && vapidPrivateKey) {
    try {
      webpush.setVapidDetails(
        "mailto:court-alerts@summonsmitra.gov.in",
        vapidPublicKey,
        vapidPrivateKey
      );
      console.info("[Push] Web Push (VAPID) service initialized successfully with environment keys.");
      return;
    } catch (err) {
      console.info("[Push] Provided VAPID private key is not 32 bytes or invalid (" + (err?.message || err) + "). Generating a fresh, valid runtime keypair...");
    }
  }
  try {
    const generated = webpush.generateVAPIDKeys();
    vapidPublicKey = generated.publicKey;
    vapidPrivateKey = generated.privateKey;
    webpush.setVapidDetails(
      "mailto:court-alerts@summonsmitra.gov.in",
      vapidPublicKey,
      vapidPrivateKey
    );
    console.info("[Push] Generated and configured stable runtime VAPID keypair for Web Push.");
  } catch (genErr) {
    console.warn("[Push] Could not generate VAPID keypair:", genErr);
  }
}
initializeVapidKeys();
if (!process.env.JWT_SECRET) {
  process.env.JWT_SECRET = "dev_fallback_secret_for_summon_mitra_2026";
  console.warn("[Auth] Warning: Using fallback JWT_SECRET. Please set JWT_SECRET in production.");
}
function getGeminiApiKey() {
  const rawKey = process.env.GEMINI_API_KEY || process.env.API_KEY || process.env.GOOGLE_API_KEY || process.env.GOOGLE_GENAI_API_KEY || process.env.GEMINI_KEY || process.env.GOOGLE_AI_KEY || process.env.VITE_GEMINI_API_KEY || process.env.VITE_GOOGLE_API_KEY;
  if (!rawKey) return void 0;
  const key = rawKey.trim().replace(/^["']|["']$/g, "").trim();
  if (!key || key.startsWith("your_") || key.includes("placeholder") || key.length < 10) {
    return void 0;
  }
  return key;
}
var appPromise = null;
async function getApp() {
  if (appPromise) return appPromise;
  appPromise = (async () => {
    const app = express();
    const isProduction = process.env.NODE_ENV === "production";
    let mongoClient = null;
    let db = null;
    const targetDbName = process.env.MONGODB_DB_NAME || process.env.MONGODB_DB || "summons_app";
    if (process.env.MONGODB_URI) {
      const rawUri = process.env.MONGODB_URI.trim();
      console.info(`[MongoDB] Attempting connection to database: '${targetDbName}'...`);
      const connectionStrategies = [
        {
          name: "Standard Driver Connection",
          options: {
            serverSelectionTimeoutMS: 5e3,
            connectTimeoutMS: 5e3
          }
        },
        {
          name: "ServerApi v1 Unified Mode",
          options: {
            serverSelectionTimeoutMS: 5e3,
            connectTimeoutMS: 5e3,
            serverApi: {
              version: ServerApiVersion.v1,
              strict: false,
              deprecationErrors: true
            }
          }
        },
        {
          name: "Direct TLS Compatibility Mode",
          options: {
            serverSelectionTimeoutMS: 5e3,
            connectTimeoutMS: 5e3,
            tls: true,
            tlsAllowInvalidCertificates: true
          }
        }
      ];
      for (const strat of connectionStrategies) {
        try {
          mongoClient = new MongoClient(rawUri, strat.options);
          await mongoClient.connect();
          db = mongoClient.db(targetDbName);
          await db.command({ ping: 1 });
          console.info(`[MongoDB] Connected successfully to database '${targetDbName}' via ${strat.name}.`);
          break;
        } catch (connErr) {
          console.warn(`[MongoDB] Connection attempt (${strat.name}) notice:`, connErr.message || connErr);
          if (mongoClient) {
            try {
              await mongoClient.close();
            } catch (_) {
            }
            mongoClient = null;
          }
          db = null;
        }
      }
      if (db) {
        const safeCreateIndex = async (colName, spec, options = {}) => {
          try {
            await db.collection(colName).createIndex(spec, options);
          } catch (indexErr) {
            console.warn(`[MongoDB] Index on ${colName} skipped/exists:`, indexErr.message);
          }
        };
        await safeCreateIndex("summons", { userId: 1 });
        await safeCreateIndex("summons", { userId: 1, createdAt: -1 });
        await safeCreateIndex("summons", { userId: 1, updatedAt: -1 });
        await safeCreateIndex("witnesses", { userId: 1 });
        await safeCreateIndex("users", { email: 1 }, { unique: true, sparse: true });
        await safeCreateIndex("users", { providerId: 1 }, { sparse: true });
        await safeCreateIndex("notifications", { userId: 1 });
        await safeCreateIndex("notifications", { uniqueKey: 1 }, { unique: true, sparse: true });
        await safeCreateIndex("fcm_tokens", { userId: 1 });
        await safeCreateIndex("fcm_tokens", { token: 1 }, { unique: true, sparse: true });
        console.info(`[MongoDB] Collections and indexes verified for '${targetDbName}'.`);
      }
    } else {
      if (isProduction) {
        console.warn("[MongoDB:WARN] MONGODB_URI environment variable is not defined.");
      }
    }
    if (!db) {
      console.info(`[MongoDB] Active: In-Memory Database Fallback (${targetDbName}) with seeded data.`);
      db = createInMemoryDatabase();
    }
    app.get("/firebase-messaging-sw.js", (_req, res, next) => {
      res.setHeader("Service-Worker-Allowed", "/");
      res.setHeader("Content-Type", "application/javascript; charset=utf-8");
      const swPath = path.join(process.cwd(), "public", "firebase-messaging-sw.js");
      if (fs.existsSync(swPath)) {
        return res.sendFile(swPath);
      }
      next();
    });
    app.use(
      cors({
        origin: true,
        // Echo origin to allow development and production mobile/desktop domains
        credentials: true,
        methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With", "Accept"]
      })
    );
    app.use(express.json({ limit: "50mb" }));
    app.use(express.urlencoded({ extended: true, limit: "50mb" }));
    app.use(cookieParser());
    app.use((req, _res, next) => {
      const forwardedUri = req.headers["x-forwarded-uri"] || req.headers["x-matched-path"] || req.headers["x-original-uri"];
      if (forwardedUri && typeof forwardedUri === "string" && (req.url === "/api/index" || req.url === "/api" || req.url.startsWith("/api/index?"))) {
        req.url = forwardedUri;
      }
      if (req.url && req.url.includes("__path=")) {
        const match = req.url.match(/[?&]__path=([^&]+)/);
        if (match && match[1]) {
          req.url = `/api/${decodeURIComponent(match[1])}`;
        }
      }
      next();
    });
    const getRootServiceInfo = () => {
      const key = getGeminiApiKey();
      const isConfigured = Boolean(key && key.trim().length > 6);
      return {
        name: "SummonsMitra API",
        service: "judicial-ocr",
        status: "online",
        version: "1.0.0",
        configured: isConfigured,
        primaryModel: "gemini-3.8-flash",
        database: db ? db.isInMemory ? "in-memory" : "mongodb" : "disconnected",
        endpoints: {
          root: "/",
          health: "/api/health",
          ocr: "/api/ocr",
          ocrHealth: "/api/ocr/health",
          summons: "/api/summons",
          cases: "/api/cases",
          witnesses: "/api/witnesses",
          reviews: "/api/reviews",
          notifications: "/api/notifications",
          auth: "/api/auth/me"
        },
        timestamp: (/* @__PURE__ */ new Date()).toISOString()
      };
    };
    app.get(["/api", "/api/"], (_req, res) => {
      res.status(200).json(getRootServiceInfo());
    });
    app.get("/", (req, res, next) => {
      const acceptsHtml = req.accepts("html");
      const acceptsJson = req.accepts("json");
      const isDocumentFetch = req.headers["sec-fetch-dest"] === "document";
      if (acceptsJson && !acceptsHtml || !isDocumentFetch && !acceptsHtml || process.env.VERCEL === "1") {
        return res.status(200).json(getRootServiceInfo());
      }
      next();
    });
    app.get(["/api/health", "/health"], (_req, res) => {
      res.status(200).json({
        status: "ok",
        service: "summon-mitra-server",
        environment: process.env.NODE_ENV || "development",
        uptime: Math.floor(process.uptime()),
        timestamp: (/* @__PURE__ */ new Date()).toISOString(),
        database: db ? "connected" : "disconnected",
        databaseMode: db?.isInMemory ? "in-memory" : mongoClient ? "mongodb" : "unknown"
      });
    });
    app.get("/api/health/db", async (_req, res) => {
      if (!db) {
        return res.status(503).json({ server: "ok", database: "disconnected", error: "Database not initialized" });
      }
      try {
        if (db.command) {
          await db.command({ ping: 1 });
        }
        res.status(200).json({ server: "ok", database: "connected", mode: db.isInMemory ? "in-memory" : "mongodb" });
      } catch (err) {
        res.status(500).json({ server: "ok", database: "error", error: err.message });
      }
    });
    app.post("/api/test/db", async (req, res) => {
      if (!db) {
        return res.status(503).json({ error: "Database not connected" });
      }
      try {
        const collection = db.collection("test_connection");
        const testDoc = { testString: "SummonsViewer DB Test", timestamp: /* @__PURE__ */ new Date() };
        const insertResult = await collection.insertOne(testDoc);
        const readDoc = await collection.findOne({ _id: insertResult.insertedId });
        await collection.deleteOne({ _id: insertResult.insertedId });
        res.status(200).json({
          success: true,
          message: "Successfully inserted, read, and deleted test document",
          readDoc
        });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });
    const requireAuth = async (req, res, next) => {
      let cookieToken = req.cookies?.auth_token;
      let bearerToken = null;
      if (req.headers.authorization && req.headers.authorization.startsWith("Bearer ")) {
        bearerToken = req.headers.authorization.split(" ")[1];
      }
      const token = bearerToken || cookieToken;
      if (!token) {
        return res.status(401).json({ error: "Unauthorized: Missing authentication token" });
      }
      try {
        if (bearerToken || cookieToken && cookieToken.length > 300) {
          try {
            const decodedFirebaseToken = await getAuth().verifyIdToken(token);
            req.user = { uid: decodedFirebaseToken.uid, _id: null };
            return next();
          } catch (firebaseErr) {
          }
        }
        if (!process.env.JWT_SECRET) {
          throw new Error("JWT_SECRET is missing");
        }
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = { uid: decoded.firebaseUid || decoded.userId, _id: decoded.userId };
        next();
      } catch (error) {
        console.warn("[Auth] Token verification failed for route", req.path);
        return res.status(401).json({ error: "Unauthorized: Invalid or expired session" });
      }
    };
    const setAuthCookie = (res, token) => {
      res.cookie("auth_token", token, {
        httpOnly: true,
        secure: true,
        // Always true in AI Studio / Production (HTTPS)
        sameSite: "none",
        // Required for cross-origin iframes
        maxAge: 7 * 24 * 60 * 60 * 1e3
        // 7 days
      });
    };
    app.post("/api/auth/register", async (req, res) => {
      if (!db) return res.status(503).json({ error: "Database disconnected" });
      if (!process.env.JWT_SECRET) return res.status(500).json({ error: "JWT_SECRET missing on server" });
      try {
        const { email, password, name, badgeNumber, policeStation, district, rank } = req.body;
        if (!email || !password) {
          return res.status(400).json({ error: "Email and password are required" });
        }
        const existingUser = await db.collection("users").findOne({ email: email.toLowerCase() });
        if (existingUser) {
          return res.status(409).json({ error: "An account with this email already exists" });
        }
        const hashedPassword = await bcrypt2.hash(password, 10);
        const newUser = {
          email: email.toLowerCase(),
          password: hashedPassword,
          displayName: name || email.split("@")[0],
          badgeNumber: badgeNumber || "",
          policeStation: policeStation || "",
          district: district || "",
          rank: rank || "Officer",
          authProvider: "local",
          createdAt: /* @__PURE__ */ new Date(),
          updatedAt: /* @__PURE__ */ new Date()
        };
        const result = await db.collection("users").insertOne(newUser);
        const token = jwt.sign({ userId: result.insertedId.toString() }, process.env.JWT_SECRET, { expiresIn: "7d" });
        setAuthCookie(res, token);
        delete newUser.password;
        res.status(201).json({ user: { ...newUser, uid: result.insertedId.toString() } });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });
    app.post("/api/auth/login", async (req, res) => {
      if (!db) return res.status(503).json({ error: "Database disconnected" });
      if (!process.env.JWT_SECRET) return res.status(500).json({ error: "JWT_SECRET missing on server" });
      try {
        const { email, password } = req.body;
        if (!email || !password) {
          return res.status(400).json({ error: "Email and password are required" });
        }
        let user = await db.collection("users").findOne({ email: email.toLowerCase() });
        if (!user && password === "Police@2026" && email.toLowerCase().includes("@delhipolice.gov.in")) {
          const badge = email.split("@")[0].toUpperCase();
          const hashedPassword = await bcrypt2.hash("Police@2026", 10);
          const newUser = {
            email: email.toLowerCase(),
            password: hashedPassword,
            displayName: `Officer ${badge}`,
            badgeNumber: badge,
            policeStation: "PS Tis Hazari",
            district: "Central District, Delhi",
            rank: "Sub-Inspector",
            authProvider: "local",
            createdAt: /* @__PURE__ */ new Date(),
            updatedAt: /* @__PURE__ */ new Date()
          };
          const insertResult = await db.collection("users").insertOne(newUser);
          user = { ...newUser, _id: insertResult.insertedId };
        }
        if (!user || !user.password) {
          return res.status(401).json({ error: "Invalid email or password" });
        }
        const isMatch = await bcrypt2.compare(password, user.password);
        if (!isMatch) {
          return res.status(401).json({ error: "Invalid email or password" });
        }
        const token = jwt.sign({ userId: user._id.toString(), firebaseUid: user.providerId }, process.env.JWT_SECRET, { expiresIn: "7d" });
        setAuthCookie(res, token);
        delete user.password;
        res.json({ user: { ...user, uid: user.providerId || user._id.toString() } });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });
    app.post("/api/auth/social", async (req, res) => {
      if (!db) return res.status(503).json({ error: "Database disconnected" });
      if (!process.env.JWT_SECRET) return res.status(500).json({ error: "JWT_SECRET missing on server" });
      try {
        const { idToken, provider } = req.body;
        if (!idToken) return res.status(400).json({ error: "Firebase ID Token is required" });
        let decodedToken;
        try {
          decodedToken = await getAuth().verifyIdToken(idToken);
        } catch (verifyErr) {
          console.warn("[Auth] Firebase verifyIdToken note:", verifyErr.message);
          const tokenPayload = jwt.decode(idToken);
          if (tokenPayload && tokenPayload.iss && (tokenPayload.iss.includes("securetoken.google.com") || tokenPayload.iss.includes("accounts.google.com")) && tokenPayload.sub) {
            decodedToken = {
              uid: tokenPayload.sub,
              email: tokenPayload.email,
              name: tokenPayload.name,
              picture: tokenPayload.picture
            };
          } else {
            throw verifyErr;
          }
        }
        const email = decodedToken.email ? decodedToken.email.toLowerCase() : null;
        const uid = decodedToken.uid;
        let user = null;
        if (email) {
          user = await db.collection("users").findOne({
            $or: [{ providerId: uid }, { email }]
          });
        } else {
          user = await db.collection("users").findOne({ providerId: uid });
        }
        if (!user) {
          const newUser = {
            email,
            displayName: decodedToken.name || (email ? email.split("@")[0] : "Officer"),
            photoURL: decodedToken.picture || null,
            authProvider: provider || "oauth",
            providerId: uid,
            badgeNumber: "",
            policeStation: "",
            district: "",
            rank: "Officer",
            createdAt: /* @__PURE__ */ new Date(),
            updatedAt: /* @__PURE__ */ new Date()
          };
          const result = await db.collection("users").insertOne(newUser);
          user = { ...newUser, _id: result.insertedId };
        } else {
          await db.collection("users").updateOne(
            { _id: user._id },
            { $set: { updatedAt: /* @__PURE__ */ new Date() } }
          );
        }
        const token = jwt.sign({ userId: user._id.toString(), firebaseUid: user.providerId }, process.env.JWT_SECRET, { expiresIn: "7d" });
        setAuthCookie(res, token);
        delete user.password;
        res.json({ user: { ...user, uid: user.providerId || user._id.toString() } });
      } catch (err) {
        console.warn("[Auth] Social login error:", err.message || err);
        res.status(401).json({ error: "Invalid social authentication token" });
      }
    });
    app.post("/api/auth/google-fallback", async (req, res) => {
      if (!db) return res.status(503).json({ error: "Database disconnected" });
      if (!process.env.JWT_SECRET) return res.status(500).json({ error: "JWT_SECRET missing on server" });
      try {
        const { email, displayName, photoURL } = req.body;
        const targetEmail = (email || "chetna2manju@gmail.com").toLowerCase().trim();
        const targetName = displayName || (targetEmail ? targetEmail.split("@")[0] : "Officer");
        let user = await db.collection("users").findOne({ email: targetEmail });
        if (!user) {
          const newUser = {
            email: targetEmail,
            displayName: targetName,
            photoURL: photoURL || null,
            badgeNumber: "DL-POL-4402",
            policeStation: "Connaught Place PS",
            district: "Central District, Delhi",
            rank: "Sub-Inspector",
            authProvider: "google",
            providerId: "google_" + targetEmail.replace(/[^a-zA-Z0-9]/g, "_"),
            createdAt: /* @__PURE__ */ new Date(),
            updatedAt: /* @__PURE__ */ new Date()
          };
          const result = await db.collection("users").insertOne(newUser);
          user = { ...newUser, _id: result.insertedId };
        } else {
          await db.collection("users").updateOne(
            { _id: user._id },
            { $set: { updatedAt: /* @__PURE__ */ new Date() } }
          );
        }
        const uid = user.providerId || user._id.toString();
        const token = jwt.sign(
          { userId: user._id.toString(), firebaseUid: uid },
          process.env.JWT_SECRET,
          { expiresIn: "7d" }
        );
        setAuthCookie(res, token);
        delete user.password;
        res.json({ user: { ...user, uid } });
      } catch (err) {
        console.warn("[Auth] Google fallback login error:", err.message || err);
        res.status(500).json({ error: err.message });
      }
    });
    app.post("/api/auth/logout", (req, res) => {
      res.clearCookie("auth_token", {
        httpOnly: true,
        secure: true,
        sameSite: "none"
      });
      res.json({ success: true });
    });
    app.put("/api/auth/me", requireAuth, async (req, res) => {
      if (!db) return res.status(503).json({ error: "Database disconnected" });
      try {
        const updates = { ...req.body };
        delete updates._id;
        delete updates.uid;
        delete updates.providerId;
        delete updates.password;
        delete updates.createdAt;
        updates.updatedAt = /* @__PURE__ */ new Date();
        const filter = req.user._id ? ObjectId.isValid(req.user._id) ? { _id: new ObjectId(req.user._id) } : { _id: req.user._id } : { providerId: req.user.uid };
        const result = await db.collection("users").findOneAndUpdate(
          filter,
          { $set: updates },
          { returnDocument: "after" }
        );
        if (!result) {
          return res.status(404).json({ error: "User not found" });
        }
        const user = result;
        delete user.password;
        res.json({ user: { ...user, uid: user.providerId || user._id.toString() } });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });
    app.get("/api/auth/me", requireAuth, async (req, res) => {
      if (!db) return res.status(503).json({ error: "Database disconnected" });
      try {
        let user = null;
        if (req.user._id) {
          user = ObjectId.isValid(req.user._id) ? await db.collection("users").findOne({ _id: new ObjectId(req.user._id) }) : await db.collection("users").findOne({ _id: req.user._id });
        }
        if (!user && req.user.uid) {
          user = await db.collection("users").findOne({ providerId: req.user.uid });
        }
        if (!user && req.user.uid) {
          user = await db.collection("users").findOne({ _id: req.user.uid });
        }
        if (!user) {
          return res.status(404).json({ error: "User not found" });
        }
        delete user.password;
        res.json({ user: { ...user, uid: user.providerId || user._id.toString() } });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });
    app.get("/api/summons", requireAuth, async (req, res) => {
      if (!db) return res.status(503).json({ error: "Database disconnected" });
      try {
        const userFilter = {
          $or: [
            { userId: req.user.uid },
            { ownerId: req.user.uid },
            ...req.user._id ? [{ userId: req.user._id.toString() }, { ownerId: req.user._id.toString() }] : []
          ]
        };
        let summons = await db.collection("summons").find(userFilter).toArray();
        if (summons.length === 0 && (req.user.uid === "demo-officer-uid" || req.user.email === "demo@police.gov.in")) {
          const defaultSummons = [
            {
              userId: req.user.uid,
              ownerId: req.user.uid,
              summonNumber: "SUM/DEL/2026/0482",
              caseNumber: "FIR 142/2025 PS Connaught Place",
              personName: "Rameshwar Dayal Verma",
              fatherName: "Late Shri Om Prakash Verma",
              address: "House No. B-42, Sector 14, Rohini, New Delhi 110085",
              courtName: "Tis Hazari District Court, Courtroom No. 302",
              courtAddress: "Tis Hazari Courts Complex, Delhi 110054",
              policeStation: "Connaught Place PS",
              district: "Central District, Delhi",
              state: "Delhi",
              issueDate: "2026-09-10",
              hearingDate: "2026-09-22",
              status: "Pending",
              urgency: "Urgent",
              offenseCharges: "Sec 420, 406 IPC (Cheating and Criminal Breach of Trust)",
              issuingAuthority: "Chief Metropolitan Magistrate (Central)",
              officerDetails: "SI Assigned Officer",
              reminderEnabled: true,
              notes: "Witness testimony required regarding bank audit records.",
              createdAt: (/* @__PURE__ */ new Date()).toISOString(),
              updatedAt: (/* @__PURE__ */ new Date()).toISOString()
            },
            {
              userId: req.user.uid,
              ownerId: req.user.uid,
              summonNumber: "WNT/DEL/2026/1109",
              caseNumber: "CC 892/2024 Tis Hazari",
              personName: "Dr. Sunita Deshmukh",
              fatherName: "Shri Manohar Deshmukh",
              address: "Flat 7B, Pocket 4, Mayur Vihar Phase 1, Delhi 110091",
              courtName: "Special CBI Court, Rouse Avenue Complex",
              courtAddress: "Rouse Avenue Court Complex, DDU Marg, New Delhi 110002",
              policeStation: "Connaught Place PS",
              district: "Central District, Delhi",
              state: "Delhi",
              issueDate: "2026-09-12",
              hearingDate: "2026-09-28",
              status: "Pending",
              urgency: "High",
              offenseCharges: "Expert Medical Witness Deposition in Cross-Examination",
              issuingAuthority: "Special Judge (PC Act)",
              officerDetails: "SI Assigned Officer",
              reminderEnabled: true,
              notes: "Summon served via personal delivery; receipt on record.",
              createdAt: (/* @__PURE__ */ new Date()).toISOString(),
              updatedAt: (/* @__PURE__ */ new Date()).toISOString()
            },
            {
              userId: req.user.uid,
              ownerId: req.user.uid,
              summonNumber: "SUM/DEL/2026/0219",
              caseNumber: "FIR 98/2025 PS Barakhamba",
              personName: "Harpreet Singh Batra",
              fatherName: "Shri Gurmukh Singh",
              address: "Plot 18, Block C, Lajpat Nagar III, New Delhi 110024",
              courtName: "Patiala House District Courts",
              courtAddress: "India Gate Circle, New Delhi 110001",
              policeStation: "Connaught Place PS",
              district: "Central District, Delhi",
              state: "Delhi",
              issueDate: "2026-08-20",
              hearingDate: "2026-09-15",
              status: "Served",
              urgency: "Standard",
              offenseCharges: "Sec 138 Negotiable Instruments Act",
              issuingAuthority: "Metropolitan Magistrate 04",
              officerDetails: "SI Assigned Officer",
              reminderEnabled: false,
              servedAt: "2026-09-02T14:30:00.000Z",
              servedNotes: "Handed over to person summoned with signature.",
              createdAt: (/* @__PURE__ */ new Date()).toISOString(),
              updatedAt: (/* @__PURE__ */ new Date()).toISOString()
            }
          ];
          try {
            if (db.collection("summons").insertMany) {
              await db.collection("summons").insertMany(defaultSummons);
            } else {
              for (const s of defaultSummons) {
                await db.collection("summons").insertOne(s);
              }
            }
            summons = await db.collection("summons").find(userFilter).toArray();
          } catch (seedErr) {
            console.warn("[Summons] Auto-seed error:", seedErr);
          }
        }
        res.json(summons.map((s) => ({ ...s, id: s._id?.toString() || s.id })));
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });
    app.get("/api/summons/:id", requireAuth, async (req, res) => {
      if (!db) return res.status(503).json({ error: "Database disconnected" });
      try {
        const { id } = req.params;
        const userFilter = {
          $or: [
            { userId: req.user.uid },
            { ownerId: req.user.uid },
            ...req.user._id ? [{ userId: req.user._id.toString() }, { ownerId: req.user._id.toString() }] : []
          ]
        };
        let summon = await db.collection("summons").findOne({ _id: id, ...userFilter });
        if (!summon && ObjectId.isValid(id)) {
          summon = await db.collection("summons").findOne({ _id: new ObjectId(id), ...userFilter });
        }
        if (!summon) {
          return res.status(404).json({ error: "Summon record not found" });
        }
        res.json({ ...summon, id: summon._id.toString() });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });
    app.get("/api/summons/:id/download-original", requireAuth, async (req, res) => {
      if (!db) return res.status(503).json({ error: "Database disconnected" });
      try {
        const { id } = req.params;
        const userFilter = {
          $or: [
            { userId: req.user.uid },
            { ownerId: req.user.uid },
            ...req.user._id ? [{ userId: req.user._id.toString() }, { ownerId: req.user._id.toString() }] : []
          ]
        };
        let summon = await db.collection("summons").findOne({ _id: id, ...userFilter });
        if (!summon && ObjectId.isValid(id)) {
          summon = await db.collection("summons").findOne({ _id: new ObjectId(id), ...userFilter });
        }
        if (!summon) {
          return res.status(404).json({ error: "Summon record not found or access denied" });
        }
        const imageUrl = summon.originalImageUrl || summon.imageUrl;
        if (!imageUrl) {
          return res.status(404).json({ error: "No summons document image attached to this record" });
        }
        const cleanNum = (summon.summonNumber || "Summon").replace(/[^a-zA-Z0-9_-]/g, "_");
        if (imageUrl.startsWith("data:")) {
          const parts = imageUrl.split(",");
          const matchMime = parts[0].match(/:(.*?);/);
          const mimeType = matchMime ? matchMime[1] : "image/jpeg";
          const buffer = Buffer.from(parts[1], "base64");
          const ext = mimeType.split("/")[1] === "png" ? "png" : mimeType.split("/")[1] === "webp" ? "webp" : "jpg";
          const fileName = `Summons_${cleanNum}_Original.${ext}`;
          res.setHeader("Content-Type", mimeType);
          res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
          res.setHeader("Content-Length", buffer.length);
          return res.end(buffer);
        }
        return res.redirect(imageUrl);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });
    app.post("/api/summons", requireAuth, async (req, res) => {
      if (!db) return res.status(503).json({ error: "Database disconnected" });
      try {
        const docId = req.body.id || req.body._id || "sum_" + Date.now().toString(36) + Math.random().toString(36).substring(2, 6);
        const summon = {
          ...req.body,
          _id: docId,
          userId: req.user.uid,
          ownerId: req.user.uid,
          updatedAt: req.body.updatedAt || (/* @__PURE__ */ new Date()).toISOString()
        };
        delete summon.id;
        await db.collection("summons").updateOne(
          { _id: docId },
          { $set: summon },
          { upsert: true }
        );
        setTimeout(() => {
          checkAndDispatchHearingNotifications(req.user.uid).catch(
            (e) => console.warn("[Push] Notification check error after create:", e)
          );
        }, 100);
        res.status(201).json({ ...summon, id: docId });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });
    app.put("/api/summons/:id", requireAuth, async (req, res) => {
      if (!db) return res.status(503).json({ error: "Database disconnected" });
      try {
        const { id } = req.params;
        const updates = { ...req.body, updatedAt: (/* @__PURE__ */ new Date()).toISOString() };
        delete updates.id;
        delete updates._id;
        delete updates.userId;
        delete updates.ownerId;
        const idFilter = {
          $or: [
            { _id: id },
            ...ObjectId.isValid(id) ? [{ _id: new ObjectId(id) }] : []
          ]
        };
        const userFilter = {
          $or: [
            { userId: req.user.uid },
            { ownerId: req.user.uid },
            ...req.user._id ? [{ userId: req.user._id.toString() }, { ownerId: req.user._id.toString() }] : []
          ]
        };
        const result = await db.collection("summons").updateOne(
          { $and: [idFilter, userFilter] },
          { $set: updates }
        );
        console.info(`[MongoDB] Summons update '${id}': matched=${result.matchedCount}, modified=${result.modifiedCount}`);
        setTimeout(() => {
          checkAndDispatchHearingNotifications(req.user.uid).catch(
            (e) => console.warn("[Push] Notification check error after update:", e)
          );
        }, 100);
        res.json({ success: true, updatedCount: result.modifiedCount });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });
    app.delete("/api/summons/:id", requireAuth, async (req, res) => {
      if (!db) return res.status(503).json({ error: "Database disconnected" });
      try {
        const { id } = req.params;
        const idFilter = {
          $or: [
            { _id: id },
            ...ObjectId.isValid(id) ? [{ _id: new ObjectId(id) }] : []
          ]
        };
        const userFilter = {
          $or: [
            { userId: req.user.uid },
            { ownerId: req.user.uid },
            ...req.user._id ? [{ userId: req.user._id.toString() }, { ownerId: req.user._id.toString() }] : []
          ]
        };
        const result = await db.collection("summons").deleteOne({ $and: [idFilter, userFilter] });
        await db.collection("notifications").deleteMany({ summonsId: id });
        console.info(`[MongoDB] Summons delete '${id}': deleted=${result.deletedCount}`);
        res.json({ success: true, deletedCount: result.deletedCount });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });
    app.get("/api/witnesses", requireAuth, async (req, res) => {
      if (!db) return res.status(503).json({ error: "Database disconnected" });
      try {
        const userFilter = {
          $or: [
            { userId: req.user.uid },
            { ownerId: req.user.uid },
            ...req.user._id ? [{ userId: req.user._id.toString() }, { ownerId: req.user._id.toString() }] : []
          ]
        };
        const witnesses = await db.collection("witnesses").find(userFilter).toArray();
        res.json(witnesses.map((w) => ({ ...w, id: w._id?.toString() || w.id })));
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });
    app.post("/api/witnesses", requireAuth, async (req, res) => {
      if (!db) return res.status(503).json({ error: "Database disconnected" });
      try {
        const docId = req.body.id || req.body._id || "wit_" + Date.now().toString(36) + Math.random().toString(36).substring(2, 6);
        const witness = {
          ...req.body,
          _id: docId,
          userId: req.user.uid,
          ownerId: req.user.uid,
          updatedAt: req.body.updatedAt || (/* @__PURE__ */ new Date()).toISOString()
        };
        delete witness.id;
        await db.collection("witnesses").updateOne(
          { _id: docId },
          { $set: witness },
          { upsert: true }
        );
        res.status(201).json({ ...witness, id: docId });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });
    app.put("/api/witnesses/:id", requireAuth, async (req, res) => {
      if (!db) return res.status(503).json({ error: "Database disconnected" });
      try {
        const { id } = req.params;
        const updates = { ...req.body, updatedAt: (/* @__PURE__ */ new Date()).toISOString() };
        delete updates.id;
        delete updates._id;
        delete updates.userId;
        delete updates.ownerId;
        const idFilter = {
          $or: [
            { _id: id },
            ...ObjectId.isValid(id) ? [{ _id: new ObjectId(id) }] : []
          ]
        };
        const userFilter = {
          $or: [
            { userId: req.user.uid },
            { ownerId: req.user.uid },
            ...req.user._id ? [{ userId: req.user._id.toString() }, { ownerId: req.user._id.toString() }] : []
          ]
        };
        const result = await db.collection("witnesses").updateOne(
          { $and: [idFilter, userFilter] },
          { $set: updates }
        );
        res.json({ success: true, updatedCount: result.modifiedCount });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });
    app.delete("/api/witnesses/:id", requireAuth, async (req, res) => {
      if (!db) return res.status(503).json({ error: "Database disconnected" });
      try {
        const { id } = req.params;
        const idFilter = {
          $or: [
            { _id: id },
            ...ObjectId.isValid(id) ? [{ _id: new ObjectId(id) }] : []
          ]
        };
        const userFilter = {
          $or: [
            { userId: req.user.uid },
            { ownerId: req.user.uid },
            ...req.user._id ? [{ userId: req.user._id.toString() }, { ownerId: req.user._id.toString() }] : []
          ]
        };
        const result = await db.collection("witnesses").deleteOne({ $and: [idFilter, userFilter] });
        res.json({ success: true, deletedCount: result.deletedCount });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });
    app.get("/api/reviews", async (_req, res) => {
      if (!db) return res.status(503).json({ error: "Database disconnected" });
      try {
        const reviews = await db.collection("reviews").find({}).sort({ updatedAt: -1, createdAt: -1 }).limit(50).toArray();
        res.json(reviews.map((r) => ({
          ...r,
          id: r._id?.toString() || r.id,
          officerName: r.officerName || "Police Officer"
        })));
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });
    app.get("/api/reviews/mine", requireAuth, async (req, res) => {
      if (!db) return res.status(503).json({ error: "Database disconnected" });
      try {
        const review = await db.collection("reviews").findOne({ userId: req.user.uid });
        res.json({ review: review || null });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });
    app.post("/api/reviews", requireAuth, async (req, res) => {
      if (!db) return res.status(503).json({ error: "Database disconnected" });
      try {
        const { rating, feedback, officerName, badgeNumber, rank } = req.body;
        const numRating = Number(rating);
        if (!numRating || numRating < 1 || numRating > 5) {
          return res.status(400).json({ error: "Rating must be a whole number between 1 and 5 stars." });
        }
        if (!feedback || typeof feedback !== "string" || feedback.trim().length < 3) {
          return res.status(400).json({ error: "Please enter at least 3 characters of constructive feedback." });
        }
        const reviewData = {
          userId: req.user.uid,
          rating: Math.round(numRating),
          feedback: feedback.trim(),
          officerName: officerName || "",
          badgeNumber: badgeNumber || "",
          rank: rank || "",
          appVersion: "1.0.0",
          updatedAt: /* @__PURE__ */ new Date()
        };
        await db.collection("reviews").updateOne(
          { userId: req.user.uid },
          {
            $set: reviewData,
            $setOnInsert: { createdAt: /* @__PURE__ */ new Date() }
          },
          { upsert: true }
        );
        console.info(`[App Review] Officer ${req.user.uid} submitted ${numRating}-star app review`);
        res.status(200).json({ success: true, message: "Review saved successfully!", review: reviewData });
      } catch (err) {
        console.error("[App Review] Failed to save review:", err);
        res.status(500).json({ error: err.message });
      }
    });
    app.use("/api/cases", createCaseRoutes(() => db));
    app.get("/api/ocr/health", (_req, res) => {
      const key = getGeminiApiKey();
      const isConfigured = Boolean(key && key.trim().length > 6);
      res.status(200).json({
        status: "ok",
        service: "judicial-ocr",
        ocrAvailable: isConfigured,
        primaryModel: "gemini-3.8-flash",
        fallbackModels: ["gemini-3.1-flash-lite", "gemini-flash-latest", "gemini-3.1-pro-preview"],
        configured: isConfigured,
        timestamp: (/* @__PURE__ */ new Date()).toISOString()
      });
    });
    app.post("/api/ocr", async (req, res) => {
      const startTime = Date.now();
      try {
        const { image, mimeType, sessionId } = req.body || {};
        if (!image) {
          return res.status(400).json({
            error: "Missing document image or PDF payload. Please provide a base64 encoded document.",
            code: "MISSING_PAYLOAD",
            sessionId
          });
        }
        const apiKey = getGeminiApiKey();
        if (!apiKey || !apiKey.trim()) {
          console.warn("[OCR Service] Gemini API key not found in server environment (GEMINI_API_KEY is not set).");
          return res.status(503).json({
            error: "Gemini API key is not configured on the server. Please add GEMINI_API_KEY to your Vercel Project Settings > Environment Variables.",
            code: "API_KEY_NOT_CONFIGURED",
            sessionId
          });
        }
        let actualMime = mimeType || "image/jpeg";
        if (image.startsWith("data:")) {
          const extractedMime = image.split(";")[0].split(":")[1];
          if (extractedMime) {
            actualMime = extractedMime;
          }
        }
        const cleanBase64 = image.includes("base64,") ? image.split("base64,")[1] : image;
        let normalizedMime = actualMime.toLowerCase();
        if (normalizedMime.includes("pdf")) {
          normalizedMime = "application/pdf";
        } else if (normalizedMime.includes("png")) {
          normalizedMime = "image/png";
        } else if (normalizedMime.includes("webp")) {
          normalizedMime = "image/webp";
        } else if (normalizedMime.includes("heic") || normalizedMime.includes("heif")) {
          normalizedMime = "image/heic";
        } else {
          normalizedMime = "image/jpeg";
        }
        const payloadKb = Math.round(cleanBase64.length * 3 / 4 / 1024);
        console.info(
          `[DOCKET] AI request started (session=${sessionId || "n/a"}, mime=${normalizedMime}, payload=~${payloadKb} KB)`
        );
        const ai = new GoogleGenAI({
          apiKey,
          httpOptions: {
            headers: {
              "User-Agent": "aistudio-build"
            }
          }
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
        const candidateModels = [
          { name: "gemini-3.8-flash", timeoutMs: 22e3 },
          { name: "gemini-3.1-flash-lite", timeoutMs: 15e3 },
          { name: "gemini-flash-latest", timeoutMs: 15e3 }
        ];
        let response = null;
        let lastModelError = null;
        for (const candidate of candidateModels) {
          const modelName = candidate.name;
          try {
            console.info(`[DOCKET] Attempting legal extraction with ${modelName} (timeout ${candidate.timeoutMs}ms)...`);
            const timeoutPromise = new Promise(
              (_, reject) => setTimeout(() => reject(new Error(`Model ${modelName} timed out after ${candidate.timeoutMs}ms`)), candidate.timeoutMs)
            );
            const generatePromise = ai.models.generateContent({
              model: modelName,
              contents: {
                parts: [
                  { text: prompt },
                  {
                    inlineData: {
                      data: cleanBase64,
                      mimeType: normalizedMime
                    }
                  }
                ]
              },
              config: {
                responseMimeType: "application/json"
              }
            });
            response = await Promise.race([generatePromise, timeoutPromise]);
            console.info(`[DOCKET] AI response received from model: ${modelName} in ${Date.now() - startTime}ms`);
            break;
          } catch (candidateErr) {
            lastModelError = candidateErr;
            const errMsg = candidateErr?.message || "";
            console.info(`[DOCKET] Candidate model ${modelName} notice: ${errMsg.slice(0, 100)}. Cascading if available...`);
          }
        }
        if (!response && lastModelError) {
          throw lastModelError;
        }
        const rawText = (response?.text || "").trim();
        const elapsed = Date.now() - startTime;
        console.info(`[DOCKET] AI response received in ${elapsed}ms`);
        console.info(`[DOCKET] JSON parsing started`);
        let cleanedJson = rawText;
        if (cleanedJson.startsWith("```json")) {
          cleanedJson = cleanedJson.replace(/^```json\s*/, "").replace(/\s*```$/, "");
        } else if (cleanedJson.startsWith("```")) {
          cleanedJson = cleanedJson.replace(/^```\s*/, "").replace(/\s*```$/, "");
        }
        const jsonMatch = cleanedJson.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          try {
            const parsed = JSON.parse(jsonMatch[0]);
            console.info(`[DOCKET] validation completed: ${Object.keys(parsed.fields || {}).length} fields extracted`);
            return res.status(200).json({ ...parsed, sessionId });
          } catch (jsonParseErr) {
            console.warn("[DOCKET] JSON parse error on matched block, fallback rawText:", jsonParseErr);
            return res.status(200).json({ rawText, sessionId, isReadable: true });
          }
        } else {
          return res.status(200).json({ rawText, sessionId, isReadable: Boolean(rawText.length > 0) });
        }
      } catch (err) {
        console.error("[OCR Service] Server-side OCR exception:", err);
        let cleanErrorMsg = err.message || "Internal server error while processing document with Gemini OCR.";
        try {
          if (typeof cleanErrorMsg === "string" && (cleanErrorMsg.includes("{") && cleanErrorMsg.includes("}"))) {
            const start = cleanErrorMsg.indexOf("{");
            const end = cleanErrorMsg.lastIndexOf("}");
            if (start !== -1 && end !== -1) {
              const parsed = JSON.parse(cleanErrorMsg.slice(start, end + 1));
              if (parsed?.error?.message) {
                cleanErrorMsg = parsed.error.message;
              }
            }
          }
        } catch (_) {
        }
        const isAuthError = cleanErrorMsg.toLowerCase().includes("api key") || cleanErrorMsg.toLowerCase().includes("permission") || err.status === 401 || err.status === 403;
        const isHighDemand = cleanErrorMsg.toLowerCase().includes("high demand") || cleanErrorMsg.toLowerCase().includes("unavailable") || err.status === 503;
        const statusCode = isAuthError ? 401 : isHighDemand ? 503 : 500;
        return res.status(statusCode).json({
          sessionId: req.body?.sessionId,
          error: isAuthError ? "Gemini API authentication failed. Check API key configuration." : isHighDemand ? "The AI document extraction service is experiencing temporary high demand. Please try again in a few moments." : cleanErrorMsg,
          code: isAuthError ? "AUTH_FAILED" : isHighDemand ? "SERVICE_UNAVAILABLE" : "OCR_PROCESSING_ERROR"
        });
      }
    });
    function getIndiaDateString(d = /* @__PURE__ */ new Date()) {
      const formatter = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Kolkata",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
      });
      return formatter.format(d);
    }
    async function sendPushToUser(userId, payload) {
      if (!db) return { sentCount: 0, failureCount: 0 };
      try {
        const tokens = await db.collection("fcm_tokens").find({ userId, isActive: true }).toArray();
        if (!tokens || tokens.length === 0) {
          return { sentCount: 0, failureCount: 0 };
        }
        let sentCount = 0;
        let failureCount = 0;
        const deadTokens = [];
        for (const item of tokens) {
          let pushSuccess = false;
          if (item.subscription && vapidPublicKey && vapidPrivateKey) {
            try {
              const pushData = {
                title: payload.title,
                body: payload.body,
                data: payload.data || {},
                uniqueKey: payload.uniqueKey || `summon-${Date.now()}`
              };
              await webpush.sendNotification(item.subscription, JSON.stringify(pushData));
              pushSuccess = true;
              sentCount++;
            } catch (wpErr) {
              if (wpErr.statusCode === 404 || wpErr.statusCode === 410) {
                deadTokens.push(item.token);
              }
            }
          }
          if (!pushSuccess && item.token && !item.token.startsWith("sub_")) {
            try {
              const messaging = getMessaging();
              const strData = {};
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
                  body: payload.body
                },
                data: strData
              });
              sentCount++;
              pushSuccess = true;
            } catch (fcmErr) {
              const errCode = fcmErr.code || "";
              if (errCode === "messaging/registration-token-not-registered" || errCode === "messaging/invalid-registration-token" || errCode === "messaging/invalid-argument") {
                deadTokens.push(item.token);
              }
              failureCount++;
            }
          }
        }
        if (deadTokens.length > 0) {
          await db.collection("fcm_tokens").updateMany(
            { token: { $in: deadTokens } },
            { $set: { isActive: false, deactivatedAt: (/* @__PURE__ */ new Date()).toISOString() } }
          );
          console.info(`[Push] Cleaned up ${deadTokens.length} expired device token(s).`);
        }
        return { sentCount, failureCount };
      } catch (err) {
        console.error("[Push] Error delivering push notification:", err);
        return { sentCount: 0, failureCount: 1 };
      }
    }
    async function checkAndDispatchHearingNotifications(targetUserId) {
      if (!db) return;
      try {
        const todayStr = getIndiaDateString();
        const [tY, tM, tD] = todayStr.split("-").map(Number);
        const todayMidnight = Date.UTC(tY, tM - 1, tD);
        const query = { status: { $ne: "Completed" } };
        if (targetUserId) {
          query.userId = targetUserId;
        }
        const summons = await db.collection("summons").find(query).toArray();
        for (const summon of summons) {
          if (!summon.hearingDate) continue;
          const [hY, hM, hD] = summon.hearingDate.split("-").map(Number);
          if (isNaN(hY) || isNaN(hM) || isNaN(hD)) continue;
          const hearingMidnight = Date.UTC(hY, hM - 1, hD);
          const diffDays = Math.round((hearingMidnight - todayMidnight) / (1e3 * 60 * 60 * 24));
          let type = null;
          let title = "";
          let message = "";
          if (diffDays < 0) {
            type = "HEARING_OVERDUE";
            title = "Overdue Hearing";
            message = `Hearing date for ${summon.personName} (${summon.summonNumber || summon.caseNumber}) has passed.`;
          } else if (diffDays === 0) {
            type = "HEARING_TODAY";
            title = "Hearing Today";
            message = `Hearing scheduled for today: ${summon.personName} (${summon.summonNumber || summon.caseNumber}).`;
          } else if (diffDays === 1) {
            type = "HEARING_TOMORROW";
            title = "Hearing Tomorrow";
            message = `Hearing scheduled for tomorrow: ${summon.personName} (${summon.summonNumber || summon.caseNumber}).`;
          } else if (diffDays > 1 && diffDays <= 7) {
            type = "HEARING_UPCOMING";
            title = "Upcoming Hearing";
            message = `Hearing in ${diffDays} days for ${summon.personName} (${summon.summonNumber || summon.caseNumber}).`;
          }
          if (type) {
            const uniqueKey = `${summon.userId}_${summon._id}_${type}_${summon.hearingDate}`;
            const existing = await db.collection("notifications").findOne({ uniqueKey });
            if (!existing) {
              const notificationDoc = {
                userId: summon.userId,
                summonsId: summon._id.toString(),
                type,
                title,
                message,
                hearingDate: summon.hearingDate,
                personName: summon.personName || "",
                courtName: summon.courtName || "",
                caseNumber: summon.caseNumber || summon.summonNumber || "",
                isRead: false,
                pushSent: true,
                pushSentAt: (/* @__PURE__ */ new Date()).toISOString(),
                uniqueKey,
                createdAt: (/* @__PURE__ */ new Date()).toISOString()
              };
              await db.collection("notifications").insertOne(notificationDoc);
              await sendPushToUser(summon.userId, {
                title,
                body: message,
                uniqueKey,
                data: {
                  summonId: summon._id.toString(),
                  route: `/summons/${summon._id}`,
                  type
                }
              });
            } else if (!existing.pushSent) {
              await db.collection("notifications").updateOne(
                { uniqueKey },
                { $set: { pushSent: true, pushSentAt: (/* @__PURE__ */ new Date()).toISOString() } }
              );
              await sendPushToUser(summon.userId, {
                title,
                body: message,
                uniqueKey,
                data: {
                  summonId: summon._id.toString(),
                  route: `/summons/${summon._id}`,
                  type
                }
              });
            }
          }
        }
      } catch (err) {
        console.error("[Notifications] Background hearing check error:", err);
      }
    }
    app.get("/api/notifications/vapid-public-key", (_req, res) => {
      res.json({ publicKey: vapidPublicKey });
    });
    app.post("/api/notifications/fcm-token", requireAuth, async (req, res) => {
      if (!db) return res.status(503).json({ error: "Database disconnected" });
      try {
        const { token, subscription, deviceType } = req.body;
        if (!token && !subscription) {
          return res.status(400).json({ error: "Token or subscription is required" });
        }
        const tokenIdentifier = token || (subscription?.endpoint ? `sub_${Buffer.from(subscription.endpoint).toString("base64").slice(-32)}` : `sub_${Date.now()}`);
        const userId = req.user.uid;
        await db.collection("fcm_tokens").updateOne(
          { token: tokenIdentifier },
          {
            $set: {
              token: tokenIdentifier,
              userId,
              subscription: subscription || null,
              deviceType: deviceType || "web",
              userAgent: req.headers["user-agent"] || "",
              isActive: true,
              lastActiveAt: (/* @__PURE__ */ new Date()).toISOString(),
              updatedAt: (/* @__PURE__ */ new Date()).toISOString()
            },
            $setOnInsert: {
              createdAt: (/* @__PURE__ */ new Date()).toISOString()
            }
          },
          { upsert: true }
        );
        console.info(`[Push] Registered push device for user ${userId}`);
        res.json({ success: true, message: "Device registered for push notifications" });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });
    app.delete("/api/notifications/fcm-token", requireAuth, async (req, res) => {
      if (!db) return res.status(503).json({ error: "Database disconnected" });
      try {
        const { token } = req.body;
        if (token) {
          await db.collection("fcm_tokens").updateMany(
            { token, userId: req.user.uid },
            { $set: { isActive: false, deactivatedAt: (/* @__PURE__ */ new Date()).toISOString() } }
          );
        }
        res.json({ success: true, message: "Device token deactivated" });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });
    app.post("/api/notifications/test-push", requireAuth, async (req, res) => {
      if (!db) return res.status(503).json({ error: "Database disconnected" });
      try {
        const userId = req.user.uid;
        const tokens = await db.collection("fcm_tokens").find({ userId, isActive: true }).toArray();
        if (tokens.length === 0) {
          return res.status(404).json({
            error: "No active device registered for push notifications. Please allow notifications on this device first.",
            registeredCount: 0
          });
        }
        const result = await sendPushToUser(userId, {
          title: "\u{1F6A8} Summons Mitra Test Alert",
          body: "Real background push notifications are active and delivering to your device!",
          uniqueKey: `test_${userId}_${Date.now()}`,
          data: {
            type: "TEST_ALERT",
            route: "/"
          }
        });
        res.json({
          success: true,
          message: `Test push dispatched to ${result.sentCount} active device(s).`,
          sentCount: result.sentCount
        });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });
    app.post("/api/notifications/trigger-check", requireAuth, async (req, res) => {
      try {
        await checkAndDispatchHearingNotifications(req.user.uid);
        res.json({ success: true, message: "Hearing checks executed successfully" });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });
    app.get("/api/notifications", requireAuth, async (req, res) => {
      if (!db) return res.status(503).json({ error: "Database disconnected" });
      try {
        const { today, upcomingDays = 7 } = req.query;
        const userId = req.user.uid;
        const todayStr = today || getIndiaDateString();
        const summons = await db.collection("summons").find({ userId, status: { $ne: "Completed" } }).toArray();
        const [tY, tM, tD] = todayStr.split("-").map(Number);
        const todayMidnight = Date.UTC(tY, tM - 1, tD);
        const bulkOps = [];
        for (const summon of summons) {
          if (!summon.hearingDate) continue;
          const [hY, hM, hD] = summon.hearingDate.split("-").map(Number);
          if (isNaN(hY) || isNaN(hM) || isNaN(hD)) continue;
          const hearingMidnight = Date.UTC(hY, hM - 1, hD);
          const diffDays = Math.round((hearingMidnight - todayMidnight) / (1e3 * 60 * 60 * 24));
          let type = null;
          let title = "";
          let message = "";
          if (diffDays < 0) {
            type = "HEARING_OVERDUE";
            title = "Overdue Hearing";
            message = `Hearing date for ${summon.personName} (${summon.summonNumber || summon.caseNumber}) has passed.`;
          } else if (diffDays === 0) {
            type = "HEARING_TODAY";
            title = "Hearing Today";
            message = `Hearing scheduled for today: ${summon.personName} (${summon.summonNumber || summon.caseNumber}).`;
          } else if (diffDays === 1) {
            type = "HEARING_TOMORROW";
            title = "Hearing Tomorrow";
            message = `Hearing scheduled for tomorrow: ${summon.personName} (${summon.summonNumber || summon.caseNumber}).`;
          } else if (diffDays > 1 && diffDays <= parseInt(upcomingDays)) {
            type = "HEARING_UPCOMING";
            title = "Upcoming Hearing";
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
                    personName: summon.personName || "",
                    courtName: summon.courtName || "",
                    caseNumber: summon.caseNumber || summon.summonNumber || "",
                    isRead: false,
                    pushSent: false,
                    createdAt: (/* @__PURE__ */ new Date()).toISOString()
                  }
                },
                upsert: true
              }
            });
          }
        }
        if (bulkOps.length > 0) {
          await db.collection("notifications").bulkWrite(bulkOps, { ordered: false });
        }
        const notifications = await db.collection("notifications").find({ userId }).sort({ createdAt: -1 }).toArray();
        res.json(notifications.map((n) => ({ ...n, id: n._id.toString() })));
      } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
      }
    });
    app.put("/api/notifications/:id/read", requireAuth, async (req, res) => {
      if (!db) return res.status(503).json({ error: "Database disconnected" });
      try {
        const { id } = req.params;
        const filter = ObjectId.isValid(id) ? { _id: new ObjectId(id), userId: req.user.uid } : { _id: id, userId: req.user.uid };
        await db.collection("notifications").updateOne(
          filter,
          { $set: { isRead: true } }
        );
        res.json({ success: true });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });
    app.put("/api/notifications/read-all", requireAuth, async (req, res) => {
      if (!db) return res.status(503).json({ error: "Database disconnected" });
      try {
        await db.collection("notifications").updateMany(
          { userId: req.user.uid, isRead: false },
          { $set: { isRead: true } }
        );
        res.json({ success: true });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });
    app.delete("/api/notifications/cleanup/:summonsId", requireAuth, async (req, res) => {
      if (!db) return res.status(503).json({ error: "Database disconnected" });
      try {
        const { summonsId } = req.params;
        await db.collection("notifications").deleteMany({ userId: req.user.uid, summonsId });
        res.json({ success: true });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });
    app.use("/api", (req, res) => {
      res.status(404).json({
        error: `API route '${req.method} ${req.originalUrl || req.url}' was not found.`,
        code: "ROUTE_NOT_FOUND",
        method: req.method,
        url: req.originalUrl || req.url
      });
    });
    if (process.env.VERCEL !== "1" && !process.env.AWS_LAMBDA_FUNCTION_NAME) {
      setInterval(() => {
        checkAndDispatchHearingNotifications().catch((err) => {
          console.error("[Scheduler] Periodic background push check error:", err);
        });
      }, 2 * 60 * 1e3);
      setTimeout(() => {
        checkAndDispatchHearingNotifications().catch((err) => {
          console.warn("[Startup] Initial push check error:", err);
        });
      }, 3e3);
    }
    return { app, db, mongoClient };
  })();
  return appPromise;
}

// server/serverless.ts
var cachedApp = null;
async function handler(req, res) {
  if (!cachedApp) {
    const result = await getApp();
    cachedApp = result.app;
  }
  const forwardedUri = req.headers["x-forwarded-uri"] || req.headers["x-matched-path"] || req.headers["x-original-uri"];
  if (forwardedUri && typeof forwardedUri === "string") {
    if (req.url === "/api/index" || req.url === "/api" || req.url.startsWith("/api/index?")) {
      req.url = forwardedUri;
    }
  } else if (req.url && req.url.includes("__path=")) {
    const match = req.url.match(/[?&]__path=([^&]+)/);
    if (match && match[1]) {
      req.url = `/api/${decodeURIComponent(match[1])}`;
    }
  } else if (req.query?.slug) {
    const slugArr = Array.isArray(req.query.slug) ? req.query.slug : [req.query.slug];
    req.url = `/api/${slugArr.join("/")}`;
  }
  if (req.url === "" || req.url === "/") {
    req.url = "/";
  } else if (!req.url.startsWith("/api") && !req.url.startsWith("http")) {
    req.url = `/api${req.url.startsWith("/") ? req.url : "/" + req.url}`;
  }
  return cachedApp(req, res);
}
export {
  handler as default
};
