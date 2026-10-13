const dotenv = require("dotenv");
dotenv.config();

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const os = require("os");
const http = require("http");
const bcrypt = require("bcryptjs");
const { Server } = require("socket.io");
const { GoogleGenAI } = require("@google/genai");
const admin = require("firebase-admin");

const {
  MongoClient,
  ServerApiVersion,
  ObjectId,
} = require("mongodb");

const app = express();
const server = http.createServer(app);
const port = process.env.PORT || 8000;

/* =========================================================
   FIREBASE ADMIN INITIALIZATION
========================================================= */

try {
  if (
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON &&
    !admin.apps.length
  ) {
    const serviceAccount = JSON.parse(
      process.env.FIREBASE_SERVICE_ACCOUNT_JSON
    );

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });

    console.log("✅ Firebase Admin initialized");
  } else if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    console.warn("⚠️ FIREBASE_SERVICE_ACCOUNT_JSON missing");
  }
} catch (error) {
  console.error(
    "❌ Firebase initialization failed:",
    error.message
  );
}

/* =========================================================
   MIDDLEWARE
========================================================= */

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  })
);

app.use(
  express.json({
    limit: "60mb",
  })
);

/* =========================================================
   UPLOAD FOLDER
========================================================= */

const uploadDir =
  process.env.NODE_ENV === "production"
    ? path.join(os.tmpdir(), "csthub-uploads")
    : path.join(__dirname, "uploads");

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

app.use("/uploads", express.static(uploadDir));

/* =========================================================
   HOME
========================================================= */

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "CST HUB Backend is running 🚀",
    time: new Date().toISOString(),
  });
});

/* =========================================================
   MONGODB
========================================================= */

const uri = process.env.MONGODB_URI;

let client;
let studentsCollection;
let noticesCollection;
let notesCollection;
let fcmTokensCollection;
let dbReady = false;
let dbConnectionPromise = null;

async function connectDB() {
  if (dbReady) return;
  if (dbConnectionPromise) return dbConnectionPromise;

  if (!uri) {
    throw new Error("MONGODB_URI is missing");
  }

  dbConnectionPromise = (async () => {
    client = new MongoClient(uri, {
      serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
      },
    });

    await client.connect();

    const db = client.db("CST");

    studentsCollection = db.collection("students");
    noticesCollection = db.collection("notices");
    notesCollection = db.collection("notes");
    fcmTokensCollection = db.collection("fcmTokens");

    dbReady = true;

    console.log("✅ Connected to MongoDB");
  })();

  try {
    await dbConnectionPromise;
  } catch (error) {
    dbConnectionPromise = null;
    throw error;
  }
}

const isValidObjectId = (id) => ObjectId.isValid(id);

/* =========================================================
   FIREBASE CLOUD MESSAGING (FCM)
========================================================= */

async function sendFCMNotification({
  title,
  message,
  data = {},
  group = "All",
}) {
  if (!admin.apps.length) {
    console.error("❌ Firebase Admin is not initialized");

    return {
      success: false,
      reason: "firebase_not_initialized",
    };
  }

  try {
    await connectDB();

    if (!fcmTokensCollection) {
      return {
        success: false,
        reason: "database_not_ready",
      };
    }

    const targetGroup = String(group || "All").trim();

    const tokenQuery =
      targetGroup.toLowerCase() === "all"
        ? {}
        : {
            $or: [
              { group: targetGroup },
              { group: "All" },
            ],
          };

    const records = await fcmTokensCollection
      .find(tokenQuery)
      .toArray();

    if (!records.length) {
      console.log("ℹ️ No subscribed FCM devices found");

      return {
        success: true,
        sent: 0,
        failed: 0,
      };
    }

    let sent = 0;
    let failed = 0;

    for (const record of records) {
      try {
        const stringData = {};

        for (const [key, value] of Object.entries(data || {})) {
          if (value !== undefined && value !== null) {
            stringData[key] = String(value);
          }
        }

        const response = await admin.messaging().send({
          token: record.token,

          // সব data value অবশ্যই string হতে হবে
          data: {
            ...stringData,
            title: String(title || "CST Hub Update"),
            body: String(
              message || "CST Hub-এ নতুন আপডেট এসেছে।"
            ),
            url: String(
              data.url || "https://cst-hub.vercel.app"
            ),
          },

          webpush: {
            headers: {
              Urgency: "high",
            },
          },
        });

        sent++;

        console.log("✅ FCM message sent:", response);
      } catch (error) {
        failed++;

        console.error(
          "❌ FCM send error:",
          error.code || error.message
        );

        if (
          error.code ===
            "messaging/registration-token-not-registered" ||
          error.code === "messaging/invalid-registration-token"
        ) {
          await fcmTokensCollection
            .deleteOne({ _id: record._id })
            .catch((deleteError) => {
              console.error(
                "Failed to remove invalid token:",
                deleteError.message
              );
            });
        }
      }
    }

    const result = {
      success: failed === 0,
      sent,
      failed,
    };

    console.log("📲 FCM notification result:", result);

    return result;
  } catch (error) {
    console.error(
      "❌ FCM notification error:",
      error.message
    );

    return {
      success: false,
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
      return res.status(400).json({
        success: false,
        message: "Valid FCM token is required.",
      });
    }

    const cleanToken = token.trim();
    const cleanGroup = String(group || "All").trim();

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

    return res.json({
      success: true,
      message: "Device subscribed to notifications.",
    });
  } catch (error) {
    console.error("FCM subscribe error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Failed to subscribe to notifications.",
    });
  }
});

/* =========================================================
   GEMINI AI
========================================================= */

const geminiClient = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

const aiUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024,
  },
  fileFilter: (req, file, cb) => {
    const allowed = [
      "image/jpeg",
      "image/png",
      "image/webp",
    ];

    if (!allowed.includes(file.mimetype)) {
      return cb(
        new Error("Only JPG, PNG and WEBP images are allowed!")
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
        return res.status(400).json({
          success: false,
          message: "Please upload an image.",
        });
      }

      const question =
        req.body.question?.trim() ||
        "এই ছবিটা সহজভাবে বুঝিয়ে দাও।";

      if (process.env.MOCK_GEMINI === "true") {
        return res.json({
          success: true,
          answer:
            `🤖 CST HUB AI (Mock Mode)\n\n` +
            `প্রশ্ন: ${question}\n\n` +
            "Image successfully received.",
        });
      }

      const extension =
        req.file.mimetype === "image/png"
          ? ".png"
          : req.file.mimetype === "image/webp"
          ? ".webp"
          : ".jpg";

      tempFilePath = path.join(
        os.tmpdir(),
        `csthub-${Date.now()}${extension}`
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
          model: "gemini-3.8-flash",
          input: [
            {
              type: "text",
              text:
                "You are CST HUB AI Study Assistant. " +
                "Answer in simple Bangla.\n\n" +
                `Student's question:\n${question}`,
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
        return res.status(500).json({
          success: false,
          message: "Gemini did not return an answer.",
        });
      }

      return res.json({
        success: true,
        answer,
      });
    } catch (error) {
      console.error("❌ Gemini Error:", error);

      return res.status(500).json({
        success: false,
        message:
          error?.message || "Failed to analyze image.",
      });
    } finally {
      if (tempFilePath) {
        await fs.promises
          .unlink(tempFilePath)
          .catch(() => {});
      }
    }
  }
);

/* =========================================================
   SOCKET.IO STUDY ROOM
========================================================= */

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
  transports: ["websocket", "polling"],
});

const roomUsersMap = new Map();

io.on("connection", (socket) => {
  console.log("⚡ New user connected:", socket.id);

  socket.on("join-study-room", (roomId) => {
    if (typeof roomId !== "string" || !roomId.trim()) {
      return;
    }

    socket.join(roomId);

    const userName =
      socket.handshake.auth?.userName ||
      `Student_${socket.id.slice(0, 4)}`;

    if (!roomUsersMap.has(roomId)) {
      roomUsersMap.set(roomId, new Map());
    }

    const roomUsers = roomUsersMap.get(roomId);

    roomUsers.set(socket.id, {
      socketId: socket.id,
      userName,
    });

    io.to(roomId).emit("room-users", {
      users: Array.from(roomUsers.values()),
    });

    socket.to(roomId).emit("user-connected", {
      socketId: socket.id,
      userName,
    });
  });

  socket.on("offer", ({ target, offer, senderName } = {}) => {
    if (!target || !offer) return;

    io.to(target).emit("offer", {
      offer,
      caller: socket.id,
      callerUserName:
        senderName ||
        socket.handshake.auth?.userName ||
        "Student",
    });
  });

  socket.on("answer", ({ target, answer } = {}) => {
    if (!target || !answer) return;

    io.to(target).emit("answer", {
      answer,
      responder: socket.id,
    });
  });

  socket.on(
    "ice-candidate",
    ({ target, candidate } = {}) => {
      if (!target || !candidate) return;

      io.to(target).emit("ice-candidate", {
        candidate,
        sender: socket.id,
      });
    }
  );

  socket.on("chat-message", ({ roomId, text } = {}) => {
    if (
      typeof roomId !== "string" ||
      typeof text !== "string" ||
      !text.trim()
    ) {
      return;
    }

    const userName =
      socket.handshake.auth?.userName ||
      `Student_${socket.id.slice(0, 4)}`;

    socket.to(roomId).emit("chat-message", {
      sender: userName,
      text: text.trim(),
    });
  });

  socket.on("disconnecting", () => {
    socket.rooms.forEach((roomId) => {
      if (!roomUsersMap.has(roomId)) return;

      const roomUsers = roomUsersMap.get(roomId);
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
    });
  });
});

/* =========================================================
   PDF UPLOAD CONFIGURATION
========================================================= */

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },

  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();

    const originalName = path
      .basename(file.originalname, ext)
      .trim()
      .replace(/\s+/g, "_")
      .replace(/[^a-zA-Z0-9_-]/g, "");

    const uniqueName =
      `${Date.now()}-${Math.round(Math.random() * 1e9)}-` +
      `${originalName}${ext}`;

    cb(null, uniqueName);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: 60 * 1024 * 1024,
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype !== "application/pdf") {
      return cb(new Error("Only PDF files are allowed!"));
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
      !name ||
      !email ||
      !password ||
      !group ||
      !roll
    ) {
      return res.status(400).json({
        success: false,
        message: "All fields are required!",
      });
    }

    const cleanName = name.trim();
    const cleanEmail = email.toLowerCase().trim();
    const cleanRoll = String(roll).trim();

    const existingEmail = await studentsCollection.findOne({
      email: cleanEmail,
    });

    if (existingEmail) {
      return res.status(409).json({
        success: false,
        message: "Email already registered!",
      });
    }

    const existingRoll = await studentsCollection.findOne({
      roll: cleanRoll,
    });

    if (existingRoll) {
      return res.status(409).json({
        success: false,
        message: "Roll number already registered!",
      });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const student = {
      name: cleanName,
      email: cleanEmail,
      password: hashedPassword,
      group,
      roll: cleanRoll,
      role: role ? role.toLowerCase().trim() : "student",
      createdAt: new Date(),
    };

    const result = await studentsCollection.insertOne(student);

    return res.status(201).json({
      success: true,
      message: "Student registered successfully!",
      insertedId: result.insertedId,
    });
  } catch (error) {
    console.error("Register error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to register student!",
    });
  }
});

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
    console.error("Fetch students error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch students!",
    });
  }
});

app.get("/students/:id", async (req, res) => {
  try {
    await connectDB();

    const { id } = req.params;

    if (!isValidObjectId(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid student ID!",
      });
    }

    const student = await studentsCollection.findOne(
      { _id: new ObjectId(id) },
      { projection: { password: 0 } }
    );

    if (!student) {
      return res.status(404).json({
        success: false,
        message: "Student not found!",
      });
    }

    return res.json({
      success: true,
      student,
    });
  } catch (error) {
    console.error("Fetch student error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch student!",
    });
  }
});

app.patch("/students/:id", async (req, res) => {
  try {
    await connectDB();

    const { id } = req.params;

    if (!isValidObjectId(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid student ID!",
      });
    }

    const { name, email, group, roll, role } = req.body || {};
    const updateData = {};

    if (name) updateData.name = name.trim();
    if (email) updateData.email = email.toLowerCase().trim();
    if (group) updateData.group = group;
    if (roll) updateData.roll = String(roll).trim();
    if (role) updateData.role = role.toLowerCase().trim();

    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({
        success: false,
        message: "No fields provided to update.",
      });
    }

    const result = await studentsCollection.updateOne(
      { _id: new ObjectId(id) },
      { $set: updateData }
    );

    if (!result.matchedCount) {
      return res.status(404).json({
        success: false,
        message: "Student not found!",
      });
    }

    return res.json({
      success: true,
      message: "Student updated successfully!",
    });
  } catch (error) {
    console.error("Update student error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Failed to update student!",
    });
  }
});

app.delete("/students/:id", async (req, res) => {
  try {
    await connectDB();

    const { id } = req.params;

    if (!isValidObjectId(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid student ID!",
      });
    }

    const result = await studentsCollection.deleteOne({
      _id: new ObjectId(id),
    });

    if (!result.deletedCount) {
      return res.status(404).json({
        success: false,
        message: "Student not found!",
      });
    }

    return res.json({
      success: true,
      message: "Student deleted successfully!",
    });
  } catch (error) {
    console.error("Delete student error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Failed to delete student!",
    });
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
      return res.status(400).json({
        success: false,
        message: "Name, email/roll and password are required.",
      });
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

    if (!student) {
      return res.status(401).json({
        success: false,
        message: "Invalid name, email/roll or password.",
      });
    }

    if (
      typeof student.password !== "string" ||
      !student.password
    ) {
      return res.status(401).json({
        success: false,
        message: "Account password is not configured.",
      });
    }

    const passwordValid = await bcrypt.compare(
      password,
      student.password
    );

    if (!passwordValid) {
      return res.status(401).json({
        success: false,
        message: "Invalid name, email/roll or password.",
      });
    }

    const role = String(student.role || "student")
      .trim()
      .toLowerCase();

    return res.status(200).json({
      success: true,
      message: `Welcome back, ${student.name}!`,
      user: {
        _id: student._id.toString(),
        name: student.name,
        email: student.email || "",
        group: student.group || "All",
        roll: student.roll || "",
        role,
        createdAt: student.createdAt || null,
      },
    });
  } catch (error) {
    console.error("Login error:", error);

    return res.status(500).json({
      success: false,
      message: "Login failed. Please try again.",
    });
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
      typeof description !== "string" ||
      !title.trim() ||
      !description.trim()
    ) {
      return res.status(400).json({
        success: false,
        message: "Title and description are required!",
      });
    }

    const notice = {
      title: title.trim(),
      description: description.trim(),
      category: category || "general",
      publisher: publisher?.trim() || "CR Office",
      group: group || "All",
      createdAt: new Date(),
    };

    const result = await noticesCollection.insertOne(notice);

    // Notification failure must not undo the saved notice.
    const notifResult = await sendFCMNotification({
      title: `📌 নতুন নোটিশ: ${notice.title}`,
      message:
        notice.description.substring(0, 100) +
        (notice.description.length > 100 ? "..." : ""),
      data: {
        type: "notice",
        id: result.insertedId.toString(),
        url: "https://cst-hub.vercel.app",
      },
      group: notice.group,
    });

    console.log("📢 Notice FCM Result:", notifResult);

    return res.status(201).json({
      success: true,
      message: "Notice published successfully!",
      insertedId: result.insertedId,
      notice,
      notification: notifResult,
    });
  } catch (error) {
    console.error("Publish notice error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to publish notice!",
    });
  }
});

app.get("/notices", async (req, res) => {
  try {
    await connectDB();

    const notices = await noticesCollection
      .find({})
      .sort({ createdAt: -1 })
      .toArray();

    return res.json(notices);
  } catch (error) {
    console.error("Fetch notices error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch notices!",
    });
  }
});

app.get("/notices/:id", async (req, res) => {
  try {
    await connectDB();

    const { id } = req.params;

    if (!isValidObjectId(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid notice ID!",
      });
    }

    const notice = await noticesCollection.findOne({
      _id: new ObjectId(id),
    });

    if (!notice) {
      return res.status(404).json({
        success: false,
        message: "Notice not found!",
      });
    }

    return res.json({
      success: true,
      notice,
    });
  } catch (error) {
    console.error("Fetch notice error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch notice!",
    });
  }
});

app.patch("/notices/:id", async (req, res) => {
  try {
    await connectDB();

    const { id } = req.params;

    if (!isValidObjectId(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid notice ID!",
      });
    }

    const {
      title,
      description,
      category,
      publisher,
      group,
    } = req.body || {};

    const updateData = {};

    if (title !== undefined) updateData.title = title.trim();
    if (description !== undefined) {
      updateData.description = description.trim();
    }
    if (category !== undefined) updateData.category = category;
    if (publisher !== undefined) {
      updateData.publisher = publisher.trim();
    }
    if (group !== undefined) updateData.group = group;

    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({
        success: false,
        message: "No fields provided to update.",
      });
    }

    const result = await noticesCollection.updateOne(
      { _id: new ObjectId(id) },
      { $set: updateData }
    );

    if (!result.matchedCount) {
      return res.status(404).json({
        success: false,
        message: "Notice not found!",
      });
    }

    return res.json({
      success: true,
      message: "Notice updated successfully!",
    });
  } catch (error) {
    console.error("Update notice error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Failed to update notice!",
    });
  }
});

app.delete("/notices/:id", async (req, res) => {
  try {
    await connectDB();

    const { id } = req.params;

    if (!isValidObjectId(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid notice ID!",
      });
    }

    const result = await noticesCollection.deleteOne({
      _id: new ObjectId(id),
    });

    if (!result.deletedCount) {
      return res.status(404).json({
        success: false,
        message: "Notice not found!",
      });
    }

    return res.json({
      success: true,
      message: "Notice deleted successfully!",
    });
  } catch (error) {
    console.error("Delete notice error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Failed to delete notice!",
    });
  }
});

/* =========================================================
   NOTES - PDF UPLOAD
========================================================= */

app.post("/notes", upload.single("file"), async (req, res) => {
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

    if (!title || !title.trim()) {
      if (req.file) {
        await fs.promises
          .unlink(req.file.path)
          .catch(() => {});
      }

      return res.status(400).json({
        success: false,
        message: "Note title is required!",
      });
    }

    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "PDF file is required!",
      });
    }

    const note = {
      title: title.trim(),
      subject: subject?.trim() || "General",
      description: description?.trim() || "",
      group: group || "All",
      semester: semester || "All",
      fileName: req.file.filename,
      originalName: req.file.originalname,
      filePath: `/uploads/${req.file.filename}`,
      fileSize: req.file.size,
      uploadedBy: uploadedBy?.trim() || "Anonymous",
      uploadedByEmail: "",
      createdAt: new Date(),
    };

    const result = await notesCollection.insertOne(note);

    // Notification failure must not undo the saved PDF.
    const notifResult = await sendFCMNotification({
      title: `📚 নতুন নোট আপলোড হয়েছে: ${note.title}`,
      message:
        `Subject: ${note.subject} | Semester: ${note.semester}`,
      data: {
        type: "note",
        id: result.insertedId.toString(),
        url: "https://cst-hub.vercel.app",
      },
      group: note.group,
    });

    console.log("📚 Note FCM Result:", notifResult);

    return res.status(201).json({
      success: true,
      message: "Note uploaded successfully!",
      insertedId: result.insertedId,
      note,
      notification: notifResult,
    });
  } catch (error) {
    console.error("Notes upload error:", error);

    if (req.file) {
      await fs.promises
        .unlink(req.file.path)
        .catch(() => {});
    }

    return res.status(500).json({
      success: false,
      message: error?.message || "Failed to upload note!",
    });
  }
});

app.get("/notes", async (req, res) => {
  try {
    await connectDB();

    const notes = await notesCollection
      .find({})
      .sort({ createdAt: -1 })
      .toArray();

    return res.json({
      success: true,
      notes,
    });
  } catch (error) {
    console.error("Fetch notes error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch notes!",
    });
  }
});

app.delete("/notes/:id", async (req, res) => {
  try {
    await connectDB();

    const { id } = req.params;

    if (!isValidObjectId(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid note ID!",
      });
    }

    const note = await notesCollection.findOne({
      _id: new ObjectId(id),
    });

    if (!note) {
      return res.status(404).json({
        success: false,
        message: "Note not found!",
      });
    }

    if (note.fileName) {
      const filePath = path.join(uploadDir, note.fileName);

      if (fs.existsSync(filePath)) {
        await fs.promises
          .unlink(filePath)
          .catch(() => {});
      }
    }

    await notesCollection.deleteOne({
      _id: new ObjectId(id),
    });

    return res.json({
      success: true,
      message: "Note deleted successfully!",
    });
  } catch (error) {
    console.error("Delete note error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Failed to delete note!",
    });
  }
});

/* =========================================================
   MULTER ERROR HANDLER
========================================================= */

app.use((error, req, res, next) => {
  if (res.headersSent) {
    return next(error);
  }

  if (error instanceof multer.MulterError) {
    return res.status(400).json({
      success: false,
      message:
        error.code === "LIMIT_FILE_SIZE"
          ? "Uploaded file is too large."
          : error.message,
    });
  }

  if (
    error.message === "Only PDF files are allowed!" ||
    error.message ===
      "Only JPG, PNG and WEBP images are allowed!"
  ) {
    return res.status(400).json({
      success: false,
      message: error.message,
    });
  }

  console.error("Unhandled error:", error);

  return res.status(500).json({
    success: false,
    message: "Internal server error.",
  });
});

/* =========================================================
   SERVER START
========================================================= */

server.listen(port, () => {
  console.log(`🚀 CST HUB backend running on port ${port}`);
});