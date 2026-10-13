
const dotenv = require("dotenv");
dotenv.config();

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const os = require("os");
const http = require("http");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { Server } = require("socket.io");
const { GoogleGenAI } = require("@google/genai");
const admin = require("firebase-admin");

const {
  MongoClient,
  ServerApiVersion,
  ObjectId,
} = require("mongodb");

/* =========================================================
   APP CONFIGURATION
========================================================= */

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 8000;

app.disable("x-powered-by");

app.use(
  cors({
    origin: process.env.FRONTEND_URL
      ? process.env.FRONTEND_URL.split(",").map((url) => url.trim())
      : "*",
    methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

/* =========================================================
   UPLOAD DIRECTORY
========================================================= */

const uploadDir =
  process.env.UPLOAD_DIR ||
  (process.env.NODE_ENV === "production"
    ? path.join(os.tmpdir(), "csthub-uploads")
    : path.join(__dirname, "uploads"));

fs.mkdirSync(uploadDir, { recursive: true });

app.use("/uploads", express.static(uploadDir));

/* =========================================================
   FIREBASE ADMIN
========================================================= */

try {
  const serviceAccountJSON =
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

  if (serviceAccountJSON && admin.apps.length === 0) {
    const serviceAccount = JSON.parse(serviceAccountJSON);

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });

    console.log("Firebase Admin initialized.");
  } else if (!serviceAccountJSON) {
    console.warn(
      "FIREBASE_SERVICE_ACCOUNT_JSON is missing. Push notifications are disabled."
    );
  }
} catch (error) {
  console.error("Firebase initialization failed:", error.message);
}

/* =========================================================
   MONGODB
========================================================= */

const mongoURI = process.env.MONGODB_URI;

let mongoClient;
let db;
let studentsCollection;
let noticesCollection;
let notesCollection;
let fcmTokensCollection;

let dbConnectionPromise = null;

async function connectDB() {
  if (db) return db;

  if (dbConnectionPromise) {
    return dbConnectionPromise;
  }

  if (!mongoURI) {
    throw new Error("MONGODB_URI is missing in environment variables.");
  }

  dbConnectionPromise = (async () => {
    const newClient = new MongoClient(mongoURI, {
      serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
      },
    });

    await newClient.connect();

    const database = newClient.db("CST");

    mongoClient = newClient;
    db = database;

    studentsCollection = database.collection("students");
    noticesCollection = database.collection("notices");
    notesCollection = database.collection("notes");
    fcmTokensCollection = database.collection("fcmTokens");

    console.log("Connected to MongoDB.");

    return database;
  })();

  try {
    return await dbConnectionPromise;
  } catch (error) {
    dbConnectionPromise = null;

    if (mongoClient) {
      await mongoClient.close().catch(() => {});
    }

    mongoClient = null;
    db = null;

    throw error;
  }
}

function validObjectId(id) {
  return typeof id === "string" && ObjectId.isValid(id);
}

function cleanString(value, fallback = "") {
  return typeof value === "string" ? value.trim() : fallback;
}

function sendError(res, status, message) {
  return res.status(status).json({
    success: false,
    message,
  });
}

/* =========================================================
   HOME / HEALTH CHECK
========================================================= */

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "CST HUB Backend is running.",
    time: new Date().toISOString(),
  });
});

app.get("/health", async (req, res) => {
  try {
    await connectDB();

    return res.json({
      success: true,
      database: "connected",
      firebase: admin.apps.length > 0 ? "initialized" : "disabled",
    });
  } catch (error) {
    return res.status(503).json({
      success: false,
      database: "disconnected",
      message: error.message,
    });
  }
});

/* =========================================================
   FIREBASE CLOUD MESSAGING
========================================================= */

async function sendFCMNotification({
  title,
  message,
  data = {},
  group = "All",
}) {
  try {
    if (admin.apps.length === 0) {
      console.warn("FCM skipped: Firebase Admin is not initialized.");

      return {
        success: false,
        sent: 0,
        failed: 0,
        reason: "firebase_not_initialized",
      };
    }

    await connectDB();

    const targetGroup = cleanString(group, "All");

    const query =
      targetGroup.toLowerCase() === "all"
        ? {}
        : {
            $or: [
              { group: targetGroup },
              { group: "All" },
            ],
          };

    const tokens = await fcmTokensCollection
      .find(query)
      .toArray();

    if (tokens.length === 0) {
      return {
        success: true,
        sent: 0,
        failed: 0,
        message: "No subscribed devices found.",
      };
    }

    let sent = 0;
    let failed = 0;

    for (const record of tokens) {
      if (!record.token) {
        failed++;
        continue;
      }

      const messageData = {};

      for (const [key, value] of Object.entries(data || {})) {
        if (value !== undefined && value !== null) {
          messageData[key] = String(value);
        }
      }

      messageData.title = String(title || "CST Hub Update");
      messageData.body = String(
        message || "CST Hub-এ নতুন আপডেট এসেছে।"
      );
      messageData.url = String(
        data?.url || "https://cst-hub.vercel.app"
      );

      try {
        await admin.messaging().send({
          token: record.token,
          data: messageData,
          webpush: {
            headers: {
              Urgency: "high",
            },
          },
        });

        sent++;
      } catch (error) {
        failed++;

        console.error(
          "FCM send error:",
          error.code || error.message
        );

        const invalidTokenCodes = [
          "messaging/registration-token-not-registered",
          "messaging/invalid-registration-token",
        ];

        if (invalidTokenCodes.includes(error.code)) {
          await fcmTokensCollection
            .deleteOne({ _id: record._id })
            .catch(() => {});
        }
      }
    }

    const result = {
      success: failed === 0,
      sent,
      failed,
    };

    console.log("FCM result:", result);

    return result;
  } catch (error) {
    console.error("FCM notification error:", error.message);

    return {
      success: false,
      sent: 0,
      failed: 0,
      error: error.message,
    };
  }
}

/* =========================================================
   FCM DEVICE SUBSCRIPTION
========================================================= */

app.post("/notifications/subscribe", async (req, res) => {
  try {
    await connectDB();

    const { token, group = "All" } = req.body || {};

    if (typeof token !== "string" || !token.trim()) {
      return sendError(res, 400, "A valid FCM token is required.");
    }

    const cleanToken = token.trim();
    const cleanGroup = cleanString(group, "All");

    await fcmTokensCollection.updateOne(
      { token: cleanToken },
      {
        $set: {
          token: cleanToken,
          group: cleanGroup,
          updatedAt: new Date(),
        },
        $setOnInsert: {
          createdAt: new Date(),
        },
      },
      { upsert: true }
    );

    return res.status(200).json({
      success: true,
      message: "Device subscribed successfully.",
    });
  } catch (error) {
    console.error("FCM subscription error:", error);

    return sendError(
      res,
      500,
      "Failed to subscribe to notifications."
    );
  }
});

/* =========================================================
   GEMINI AI IMAGE EXPLANATION
========================================================= */

const geminiClient = process.env.GEMINI_API_KEY
  ? new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY,
    })
  : null;

const aiUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024,
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = [
      "image/jpeg",
      "image/png",
      "image/webp",
    ];

    if (!allowedTypes.includes(file.mimetype)) {
      return cb(
        new Error("Only JPG, PNG and WEBP images are allowed.")
      );
    }

    cb(null, true);
  },
});

app.post(
  "/api/ai/explain-image",
  aiUpload.single("image"),
  async (req, res) => {
    let tempFilePath = null;

    try {
      if (!req.file) {
        return sendError(res, 400, "Please upload an image.");
      }

      const question =
        cleanString(req.body?.question) ||
        "এই ছবিটি সহজ বাংলায় বুঝিয়ে দাও।";

      if (process.env.MOCK_GEMINI === "true") {
        return res.json({
          success: true,
          answer:
            `CST HUB AI (Mock Mode)\n\nপ্রশ্ন: ${question}\n\n` +
            "Image received successfully. Mock mode is enabled.",
        });
      }

      if (!geminiClient) {
        return sendError(
          res,
          503,
          "GEMINI_API_KEY is missing in environment variables."
        );
      }

      const extension =
        req.file.mimetype === "image/png"
          ? ".png"
          : req.file.mimetype === "image/webp"
          ? ".webp"
          : ".jpg";

      tempFilePath = path.join(
        os.tmpdir(),
        `csthub-${crypto.randomUUID()}${extension}`
      );

      await fs.promises.writeFile(
        tempFilePath,
        req.file.buffer
      );

      const uploadedFile = await geminiClient.files.upload({
        file: tempFilePath,
        config: {
          mime_type: req.file.mimetype,
        },
      });

      const interaction =
        await geminiClient.interactions.create({
          model:
            process.env.GEMINI_MODEL || "gemini-3.8-flash",
          input: [
            {
              type: "text",
              text:
                "You are CST HUB AI Study Assistant. " +
                "Explain the image accurately in simple Bangla. " +
                "Use easy examples for a diploma student.\n\n" +
                `Student question: ${question}`,
            },
            {
              type: "image",
              uri: uploadedFile.uri,
              mime_type: uploadedFile.mimeType,
            },
          ],
        });

      const answer = interaction.output_text;

      if (!answer) {
        return sendError(
          res,
          502,
          "AI did not return an answer. Please try again."
        );
      }

      return res.json({
        success: true,
        answer,
      });
    } catch (error) {
      console.error("Gemini error:", error);

      return res.status(500).json({
        success: false,
        message: error.message || "Failed to explain the image.",
      });
    } finally {
      if (tempFilePath) {
        await fs.promises.unlink(tempFilePath).catch(() => {});
      }
    }
  }
);

/* =========================================================
   SOCKET.IO STUDY ROOM
========================================================= */

const io = new Server(server, {
  cors: {
    origin: process.env.FRONTEND_URL
      ? process.env.FRONTEND_URL.split(",").map((url) => url.trim())
      : "*",
    methods: ["GET", "POST"],
  },
  transports: ["websocket", "polling"],
});

const roomUsersMap = new Map();

io.on("connection", (socket) => {
  console.log("Study Room connected:", socket.id);

  socket.on("join-study-room", (roomId) => {
    if (
      typeof roomId !== "string" ||
      !roomId.trim() ||
      roomId.length > 150
    ) {
      return;
    }

    const cleanRoomId = roomId.trim();

    const userName =
      cleanString(socket.handshake.auth?.userName) ||
      `Student_${socket.id.slice(0, 4)}`;

    // Leave other study rooms before joining another one.
    for (const oldRoom of socket.rooms) {
      if (oldRoom === socket.id || oldRoom === cleanRoomId) {
        continue;
      }

      const oldUsers = roomUsersMap.get(oldRoom);

      if (oldUsers) {
        oldUsers.delete(socket.id);

        if (oldUsers.size === 0) {
          roomUsersMap.delete(oldRoom);
        } else {
          io.to(oldRoom).emit("room-users", {
            users: Array.from(oldUsers.values()),
          });
        }
      }

      socket.leave(oldRoom);
    }

    socket.join(cleanRoomId);

    if (!roomUsersMap.has(cleanRoomId)) {
      roomUsersMap.set(cleanRoomId, new Map());
    }

    const roomUsers = roomUsersMap.get(cleanRoomId);

    roomUsers.set(socket.id, {
      socketId: socket.id,
      userName,
    });

    socket.emit("room-users", {
      users: Array.from(roomUsers.values()),
    });

    socket.to(cleanRoomId).emit("user-connected", {
      socketId: socket.id,
      userName,
    });

    // Compatibility with clients that listen for room user count.
    io.to(cleanRoomId).emit("user-count", roomUsers.size);
  });

  socket.on("offer", (payload = {}) => {
    const { target, offer, senderName } = payload;

    if (!target || !offer) return;

    io.to(target).emit("offer", {
      offer,
      caller: socket.id,
      callerUserName:
        cleanString(senderName) ||
        cleanString(socket.handshake.auth?.userName) ||
        "Student",
    });
  });

  socket.on("answer", (payload = {}) => {
    const { target, answer } = payload;

    if (!target || !answer) return;

    io.to(target).emit("answer", {
      answer,
      responder: socket.id,
    });
  });

  socket.on("ice-candidate", (payload = {}) => {
    const { target, candidate } = payload;

    if (!target || !candidate) return;

    io.to(target).emit("ice-candidate", {
      candidate,
      sender: socket.id,
    });
  });

  socket.on("chat-message", (payload = {}) => {
    const { roomId, text } = payload;

    if (
      typeof roomId !== "string" ||
      typeof text !== "string" ||
      !text.trim()
    ) {
      return;
    }

    const cleanRoomId = roomId.trim();

    // Only allow chat to rooms the socket has actually joined.
    if (!socket.rooms.has(cleanRoomId)) {
      return;
    }

    const userName =
      cleanString(socket.handshake.auth?.userName) ||
      `Student_${socket.id.slice(0, 4)}`;

    io.to(cleanRoomId).emit("chat-message", {
      sender: userName,
      text: text.trim().slice(0, 2000),
      socketId: socket.id,
      createdAt: new Date().toISOString(),
    });
  });

  socket.on("disconnecting", () => {
    for (const roomId of socket.rooms) {
      if (roomId === socket.id) continue;

      const roomUsers = roomUsersMap.get(roomId);

      if (!roomUsers) continue;

      const user = roomUsers.get(socket.id);

      roomUsers.delete(socket.id);

      if (roomUsers.size === 0) {
        roomUsersMap.delete(roomId);
      } else {
        io.to(roomId).emit("user-disconnected", {
          socketId: socket.id,
          userName: user?.userName || "User",
        });

        io.to(roomId).emit("room-users", {
          users: Array.from(roomUsers.values()),
        });
      }

      io.to(roomId).emit("user-count", roomUsers.size);
    }
  });

  socket.on("disconnect", (reason) => {
    console.log("Study Room disconnected:", socket.id, reason);
  });
});

/* =========================================================
   PDF UPLOAD CONFIGURATION
========================================================= */

const pdfStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },

  filename: (req, file, cb) => {
    const originalExtension = path
      .extname(file.originalname || "")
      .toLowerCase();

    const baseName = path
      .basename(file.originalname || "document", originalExtension)
      .replace(/[^a-zA-Z0-9_-]/g, "_")
      .slice(0, 80);

    const uniqueName =
      `${Date.now()}-${crypto.randomUUID()}-` +
      `${baseName || "document"}.pdf`;

    cb(null, uniqueName);
  },
});

const upload = multer({
  storage: pdfStorage,
  limits: {
    fileSize: 60 * 1024 * 1024,
    files: 1,
  },
  fileFilter: (req, file, cb) => {
    const extension = path
      .extname(file.originalname || "")
      .toLowerCase();

    if (
      file.mimetype !== "application/pdf" ||
      extension !== ".pdf"
    ) {
      return cb(new Error("Only PDF files are allowed."));
    }

    cb(null, true);
  },
});

/* =========================================================
   STUDENTS - REGISTER
========================================================= */

app.post("/students", async (req, res) => {
  try {
    await connectDB();

    const {
      name,
      email,
      password,
      group,
      roll,
      role,
    } = req.body || {};

    if (
      typeof name !== "string" ||
      typeof email !== "string" ||
      typeof password !== "string" ||
      !name.trim() ||
      !email.trim() ||
      !password ||
      !group ||
      roll === undefined ||
      roll === null ||
      !String(roll).trim()
    ) {
      return sendError(
        res,
        400,
        "Name, email, password, group and roll are required."
      );
    }

    if (password.length < 6) {
      return sendError(
        res,
        400,
        "Password must be at least 6 characters."
      );
    }

    const cleanName = name.trim();
    const cleanEmail = email.trim().toLowerCase();
    const cleanRoll = String(roll).trim();
    const cleanGroup = cleanString(group);

    const existingUser = await studentsCollection.findOne({
      $or: [
        { email: cleanEmail },
        { roll: cleanRoll },
      ],
    });

    if (existingUser) {
      if (existingUser.email === cleanEmail) {
        return sendError(res, 409, "Email already registered.");
      }

      return sendError(res, 409, "Roll number already registered.");
    }

    const hashedPassword = await bcrypt.hash(password, 12);

    const student = {
      name: cleanName,
      email: cleanEmail,
      password: hashedPassword,
      group: cleanGroup,
      roll: cleanRoll,

      // Role assignment should ideally be controlled by an admin.
      role: cleanString(role, "student").toLowerCase(),

      createdAt: new Date(),
    };

    const result = await studentsCollection.insertOne(student);

    return res.status(201).json({
      success: true,
      message: "Student registered successfully.",
      insertedId: result.insertedId,
    });
  } catch (error) {
    console.error("Student registration error:", error);

    if (error.code === 11000) {
      return sendError(
        res,
        409,
        "Email or roll number already registered."
      );
    }

    return sendError(res, 500, "Failed to register student.");
  }
});

/* =========================================================
   STUDENTS - GET ALL
========================================================= */

app.get("/students", async (req, res) => {
  try {
    await connectDB();

    const students = await studentsCollection
      .find({})
      .sort({ createdAt: -1 })
      .project({ password: 0 })
      .toArray();

    return res.json({
      success: true,
      students,
    });
  } catch (error) {
    console.error("Fetch students error:", error);

    return sendError(res, 500, "Failed to fetch students.");
  }
});

/* =========================================================
   STUDENTS - GET ONE
========================================================= */

app.get("/students/:id", async (req, res) => {
  try {
    await connectDB();

    const { id } = req.params;

    if (!validObjectId(id)) {
      return sendError(res, 400, "Invalid student ID.");
    }

    const student = await studentsCollection.findOne(
      { _id: new ObjectId(id) },
      { projection: { password: 0 } }
    );

    if (!student) {
      return sendError(res, 404, "Student not found.");
    }

    return res.json({
      success: true,
      student,
    });
  } catch (error) {
    console.error("Fetch student error:", error);

    return sendError(res, 500, "Failed to fetch student.");
  }
});

/* =========================================================
   STUDENTS - UPDATE
========================================================= */

app.patch("/students/:id", async (req, res) => {
  try {
    await connectDB();

    const { id } = req.params;

    if (!validObjectId(id)) {
      return sendError(res, 400, "Invalid student ID.");
    }

    const { name, email, group, roll, role } = req.body || {};
    const updateData = {};

    if (name !== undefined) {
      if (typeof name !== "string" || !name.trim()) {
        return sendError(res, 400, "Invalid name.");
      }

      updateData.name = name.trim();
    }

    if (email !== undefined) {
      if (typeof email !== "string" || !email.trim()) {
        return sendError(res, 400, "Invalid email.");
      }

      updateData.email = email.trim().toLowerCase();
    }

    if (group !== undefined) {
      updateData.group = cleanString(group);
    }

    if (roll !== undefined) {
      updateData.roll = String(roll).trim();
    }

    if (role !== undefined) {
      updateData.role = cleanString(role).toLowerCase();
    }

    if (Object.keys(updateData).length === 0) {
      return sendError(res, 400, "No valid fields provided.");
    }

    const result = await studentsCollection.updateOne(
      { _id: new ObjectId(id) },
      { $set: updateData }
    );

    if (!result.matchedCount) {
      return sendError(res, 404, "Student not found.");
    }

    return res.json({
      success: true,
      message: "Student updated successfully.",
    });
  } catch (error) {
    console.error("Update student error:", error);

    if (error.code === 11000) {
      return sendError(res, 409, "Email or roll already exists.");
    }

    return sendError(res, 500, "Failed to update student.");
  }
});

/* =========================================================
   STUDENTS - DELETE
========================================================= */

app.delete("/students/:id", async (req, res) => {
  try {
    await connectDB();

    const { id } = req.params;

    if (!validObjectId(id)) {
      return sendError(res, 400, "Invalid student ID.");
    }

    const result = await studentsCollection.deleteOne({
      _id: new ObjectId(id),
    });

    if (!result.deletedCount) {
      return sendError(res, 404, "Student not found.");
    }

    return res.json({
      success: true,
      message: "Student deleted successfully.",
    });
  } catch (error) {
    console.error("Delete student error:", error);

    return sendError(res, 500, "Failed to delete student.");
  }
});

/* =========================================================
   LOGIN
========================================================= */

app.post("/login", async (req, res) => {
  try {
    await connectDB();

    const {
      name,
      emailOrRoll,
      password,
    } = req.body || {};

    if (
      typeof name !== "string" ||
      typeof emailOrRoll !== "string" ||
      typeof password !== "string" ||
      !name.trim() ||
      !emailOrRoll.trim() ||
      !password
    ) {
      return sendError(
        res,
        400,
        "Name, email/roll and password are required."
      );
    }

    const cleanName = name.trim();
    const identifier = emailOrRoll.trim();

    const student = await studentsCollection.findOne({
      name: cleanName,
      $or: [
        { email: identifier.toLowerCase() },
        { roll: identifier },
      ],
    });

    if (!student || typeof student.password !== "string") {
      return sendError(
        res,
        401,
        "Invalid name, email/roll or password."
      );
    }

    const passwordValid = await bcrypt.compare(
      password,
      student.password
    );

    if (!passwordValid) {
      return sendError(
        res,
        401,
        "Invalid name, email/roll or password."
      );
    }

    return res.json({
      success: true,
      message: `Welcome back, ${student.name}!`,
      user: {
        _id: student._id.toString(),
        name: student.name,
        email: student.email || "",
        group: student.group || "All",
        roll: student.roll || "",
        role: cleanString(student.role, "student").toLowerCase(),
        createdAt: student.createdAt || null,
      },
    });
  } catch (error) {
    console.error("Login error:", error);

    return sendError(res, 500, "Login failed. Please try again.");
  }
});

/* =========================================================
   NOTICES - CREATE
========================================================= */

app.post("/notices", async (req, res) => {
  try {
    await connectDB();

    const {
      title,
      description,
      category,
      publisher,
      group,
    } = req.body || {};

    if (
      typeof title !== "string" ||
      !title.trim() ||
      typeof description !== "string" ||
      !description.trim()
    ) {
      return sendError(
        res,
        400,
        "Notice title and description are required."
      );
    }

    const notice = {
      title: title.trim(),
      description: description.trim(),
      category: cleanString(category, "general"),
      publisher: cleanString(publisher, "CR Office"),
      group: cleanString(group, "All"),
      createdAt: new Date(),
    };

    const result = await noticesCollection.insertOne(notice);

    // Notification errors are caught by sendFCMNotification.
    const notification = await sendFCMNotification({
      title: `📌 নতুন নোটিশ: ${notice.title}`,
      message:
        notice.description.length > 100
          ? `${notice.description.slice(0, 100)}...`
          : notice.description,
      data: {
        type: "notice",
        id: result.insertedId.toString(),
        url: "https://cst-hub.vercel.app",
      },
      group: notice.group,
    });

    return res.status(201).json({
      success: true,
      message: "Notice published successfully.",
      insertedId: result.insertedId,
      notice: {
        ...notice,
        _id: result.insertedId,
      },
      notification,
    });
  } catch (error) {
    console.error("Create notice error:", error);

    return sendError(res, 500, "Failed to publish notice.");
  }
});

/* =========================================================
   NOTICES - GET ALL
========================================================= */

app.get("/notices", async (req, res) => {
  try {
    await connectDB();

    const notices = await noticesCollection
      .find({})
      .sort({ createdAt: -1 })
      .toArray();

    // Keep this endpoint as an array for compatibility
    // with the existing frontend.
    return res.json(notices);
  } catch (error) {
    console.error("Fetch notices error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch notices.",
      notices: [],
    });
  }
});

/* =========================================================
   NOTICES - GET ONE
========================================================= */

app.get("/notices/:id", async (req, res) => {
  try {
    await connectDB();

    const { id } = req.params;

    if (!validObjectId(id)) {
      return sendError(res, 400, "Invalid notice ID.");
    }

    const notice = await noticesCollection.findOne({
      _id: new ObjectId(id),
    });

    if (!notice) {
      return sendError(res, 404, "Notice not found.");
    }

    return res.json({
      success: true,
      notice,
    });
  } catch (error) {
    console.error("Fetch notice error:", error);

    return sendError(res, 500, "Failed to fetch notice.");
  }
});

/* =========================================================
   NOTICES - UPDATE
========================================================= */

app.patch("/notices/:id", async (req, res) => {
  try {
    await connectDB();

    const { id } = req.params;

    if (!validObjectId(id)) {
      return sendError(res, 400, "Invalid notice ID.");
    }

    const {
      title,
      description,
      category,
      publisher,
      group,
    } = req.body || {};

    const updateData = {};

    if (title !== undefined) {
      if (typeof title !== "string" || !title.trim()) {
        return sendError(res, 400, "Invalid notice title.");
      }

      updateData.title = title.trim();
    }

    if (description !== undefined) {
      if (
        typeof description !== "string" ||
        !description.trim()
      ) {
        return sendError(res, 400, "Invalid description.");
      }

      updateData.description = description.trim();
    }

    if (category !== undefined) {
      updateData.category = cleanString(category, "general");
    }

    if (publisher !== undefined) {
      updateData.publisher = cleanString(publisher, "CR Office");
    }

    if (group !== undefined) {
      updateData.group = cleanString(group, "All");
    }

    if (Object.keys(updateData).length === 0) {
      return sendError(res, 400, "No valid fields provided.");
    }

    updateData.updatedAt = new Date();

    const result = await noticesCollection.updateOne(
      { _id: new ObjectId(id) },
      { $set: updateData }
    );

    if (!result.matchedCount) {
      return sendError(res, 404, "Notice not found.");
    }

    return res.json({
      success: true,
      message: "Notice updated successfully.",
    });
  } catch (error) {
    console.error("Update notice error:", error);

    return sendError(res, 500, "Failed to update notice.");
  }
});

/* =========================================================
   NOTICES - DELETE
========================================================= */

app.delete("/notices/:id", async (req, res) => {
  try {
    await connectDB();

    const { id } = req.params;

    if (!validObjectId(id)) {
      return sendError(res, 400, "Invalid notice ID.");
    }

    const result = await noticesCollection.deleteOne({
      _id: new ObjectId(id),
    });

    if (!result.deletedCount) {
      return sendError(res, 404, "Notice not found.");
    }

    return res.json({
      success: true,
      message: "Notice deleted successfully.",
    });
  } catch (error) {
    console.error("Delete notice error:", error);

    return sendError(res, 500, "Failed to delete notice.");
  }
});

/* =========================================================
   NOTES - CREATE / PDF UPLOAD
========================================================= */

app.post("/notes", upload.single("file"), async (req, res) => {
  let savedInDatabase = false;

  try {
    await connectDB();

    const {
      title,
      subject,
      description,
      group,
      semester,
      uploadedBy,
    } = req.body || {};

    if (typeof title !== "string" || !title.trim()) {
      if (req.file) {
        await fs.promises.unlink(req.file.path).catch(() => {});
      }

      return sendError(res, 400, "Note title is required.");
    }

    if (!req.file) {
      return sendError(
        res,
        400,
        "PDF file is required. Use FormData field name 'file'."
      );
    }

    const note = {
      title: title.trim(),
      subject: cleanString(subject, "General"),
      description: cleanString(description),
      group: cleanString(group, "All"),
      semester: cleanString(semester, "All"),
      fileName: req.file.filename,
      originalName: req.file.originalname,
      filePath: `/uploads/${req.file.filename}`,
      fileSize: req.file.size,
      uploadedBy: cleanString(uploadedBy, "Anonymous"),
      uploadedByEmail: "",
      createdAt: new Date(),
    };

    const result = await notesCollection.insertOne(note);
    savedInDatabase = true;

    const notification = await sendFCMNotification({
      title: `📚 নতুন নোট: ${note.title}`,
      message:
        `Subject: ${note.subject} | Semester: ${note.semester}`,
      data: {
        type: "note",
        id: result.insertedId.toString(),
        url: "https://cst-hub.vercel.app",
      },
      group: note.group,
    });

    return res.status(201).json({
      success: true,
      message: "Note uploaded successfully.",
      insertedId: result.insertedId,
      note: {
        ...note,
        _id: result.insertedId,
      },
      notification,
    });
  } catch (error) {
    console.error("Upload note error:", error);

    if (req.file && !savedInDatabase) {
      await fs.promises.unlink(req.file.path).catch(() => {});
    }

    return res.status(500).json({
      success: false,
      message: error.message || "Failed to upload note.",
    });
  }
});

/* =========================================================
   NOTES - GET ALL
========================================================= */

app.get("/notes", async (req, res) => {
  try {
    await connectDB();

    const notes = await notesCollection
      .find({})
      .sort({ createdAt: -1 })
      .toArray();

    return res.status(200).json({
      success: true,
      notes: Array.isArray(notes) ? notes : [],
    });
  } catch (error) {
    console.error("Fetch notes error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch notes.",
      notes: [],
    });
  }
});

/* =========================================================
   NOTES - GET ONE
========================================================= */

app.get("/notes/:id", async (req, res) => {
  try {
    await connectDB();

    const { id } = req.params;

    if (!validObjectId(id)) {
      return sendError(res, 400, "Invalid note ID.");
    }

    const note = await notesCollection.findOne({
      _id: new ObjectId(id),
    });

    if (!note) {
      return sendError(res, 404, "Note not found.");
    }

    return res.json({
      success: true,
      note,
    });
  } catch (error) {
    console.error("Fetch note error:", error);

    return sendError(res, 500, "Failed to fetch note.");
  }
});

/* =========================================================
   NOTES - DELETE
========================================================= */

app.delete("/notes/:id", async (req, res) => {
  try {
    await connectDB();

    const { id } = req.params;

    if (!validObjectId(id)) {
      return sendError(res, 400, "Invalid note ID.");
    }

    const note = await notesCollection.findOne({
      _id: new ObjectId(id),
    });

    if (!note) {
      return sendError(res, 404, "Note not found.");
    }

    const result = await notesCollection.deleteOne({
      _id: new ObjectId(id),
    });

    if (!result.deletedCount) {
      return sendError(res, 404, "Note not found.");
    }

    if (note.fileName) {
      const filePath = path.join(uploadDir, path.basename(note.fileName));

      await fs.promises.unlink(filePath).catch((error) => {
        if (error.code !== "ENOENT") {
          console.error("Could not remove PDF:", error.message);
        }
      });
    }

    return res.json({
      success: true,
      message: "Note deleted successfully.",
    });
  } catch (error) {
    console.error("Delete note error:", error);

    return sendError(res, 500, "Failed to delete note.");
  }
});

/* =========================================================
   MULTER AND GLOBAL ERROR HANDLER
========================================================= */

app.use((error, req, res, next) => {
  if (res.headersSent) {
    return next(error);
  }

  if (error instanceof multer.MulterError) {
    if (error.code === "LIMIT_FILE_SIZE") {
      return sendError(
        res,
        413,
        "File is too large. Maximum size is 60 MB for PDFs and 10 MB for images."
      );
    }

    return sendError(res, 400, error.message);
  }

  const allowedFileErrors = [
    "Only PDF files are allowed.",
    "Only JPG, PNG and WEBP images are allowed.",
  ];

  if (allowedFileErrors.includes(error.message)) {
    return sendError(res, 400, error.message);
  }

  console.error("Unhandled server error:", error);

  return sendError(res, 500, "Internal server error.");
});

/* =========================================================
   START SERVER
========================================================= */

async function startServer() {
  try {
    await connectDB();

    server.listen(PORT, () => {
      console.log(`CST HUB backend running on port ${PORT}`);
    });
  } catch (error) {
    console.error("Initial MongoDB connection failed:", error.message);

    // Keep the server alive so health checks and error responses
    // remain available while MongoDB is temporarily unreachable.
    server.listen(PORT, () => {
      console.log(
        `CST HUB backend listening on port ${PORT}; database is unavailable.`
      );
    });
  }
}

startServer();

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection:", reason);
});

