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
const jwt = require("jsonwebtoken");

const { Server } = require("socket.io");
const { GoogleGenAI } = require("@google/genai");

const {
  MongoClient,
  ServerApiVersion,
  ObjectId,
} = require("mongodb");

const app = express();
const server = http.createServer(app);

const port = process.env.PORT || 8000;
const JWT_SECRET = process.env.JWT_SECRET || "csthub_secure_jwt_secret_key_2026";

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
   ONESIGNAL NOTIFICATION HELPER
========================================================= */

async function sendOneSignalNotification({ title, message, data = {} }) {
  try {
    const appId = process.env.ONESIGNAL_APP_ID;
    const apiKey = process.env.ONESIGNAL_API_KEY;

    if (!appId || !apiKey) {
      console.log("⚠️ OneSignal credentials missing. Notification skipped.");
      return;
    }

    const payload = {
      app_id: appId,
      included_segments: ["All"],
      headings: { en: title },
      contents: { en: message },
      data: data,
    };

    const response = await fetch("https://onesignal.com/api/v1/notifications", {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Authorization": `Basic ${apiKey}`,
      },
      body: JSON.stringify(payload),
    });

    const result = await response.json();
    console.log("🔔 OneSignal Notification Sent:", result);
  } catch (error) {
    console.error("❌ OneSignal Notification Error (Ignored):", error.message);
  }
}

/* =========================================================
   UPLOAD FOLDER
========================================================= */

const uploadDir =
  process.env.NODE_ENV === "production"
    ? path.join(os.tmpdir(), "csthub-uploads")
    : path.join(__dirname, "uploads");

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, {
    recursive: true,
  });
}

app.use(
  "/uploads",
  express.static(uploadDir)
);

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
   GEMINI
========================================================= */

const geminiClient = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

const aiUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/webp"];
    if (!allowed.includes(file.mimetype)) {
      return cb(new Error("Only JPG, PNG and WEBP images are allowed!"));
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

      const question = req.body.question?.trim() || "এই ছবিটা সহজভাবে বুঝিয়ে দাও।";

      if (process.env.MOCK_GEMINI === "true") {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        return res.json({
          success: true,
          answer: `🤖 CST HUB AI (Mock Mode)\n\nপ্রশ্ন: ${question}\n\nImage successfully received.`,
        });
      }

      const extension = req.file.mimetype === "image/png" ? ".png" : req.file.mimetype === "image/webp" ? ".webp" : ".jpg";
      tempFilePath = path.join(os.tmpdir(), `csthub-${Date.now()}${extension}`);
      await fs.promises.writeFile(tempFilePath, req.file.buffer);

      const uploadedFile = await geminiClient.files.upload({
        file: tempFilePath,
        config: { mime_type: req.file.mimetype },
      });

      const interaction = await geminiClient.interactions.create({
        model: "gemini-3.8-flash",
        input: [
          {
            type: "text",
            text: `You are CST HUB AI Study Assistant. Answer in simple Bangla.\n\nStudent's question:\n${question}`,
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
        return res.status(500).json({ success: false, message: "Gemini did not return an answer." });
      }

      return res.json({ success: true, answer });
    } catch (error) {
      console.error("❌ Gemini Error:", error);
      return res.status(500).json({ success: false, message: error?.message || "Failed to analyze image." });
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

/* =========================================================
   SOCKET.IO STUDY ROOM (UPDATED & FIXED)
========================================================= */

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  transports: ["websocket", "polling"],
});

const roomUsersMap = new Map();

io.on("connection", (socket) => {
  console.log("⚡ New user connected:", socket.id);

  // স্টাডি রুমে জয়েন করার ইভেন্ট
  socket.on("join-study-room", (roomId) => {
    socket.join(roomId);

    // ইউজার নেম বের করা
    const userName =
      socket.handshake.auth?.userName || `Student_${socket.id.slice(0, 4)}`;

    if (!roomUsersMap.has(roomId)) {
      roomUsersMap.set(roomId, new Map());
    }

    const roomUsers = roomUsersMap.get(roomId);
    roomUsers.set(socket.id, { socketId: socket.id, userName });

    const usersArray = Array.from(roomUsers.values());

    console.log(`👤 ${userName} (${socket.id}) joined room: ${roomId}`);
    console.log(`📊 Total users in room ${roomId}: ${usersArray.length}`);

    // ১. রুমে থাকা সবাইকে আপডেট ইউজার লিস্ট পাঠানো (যাতে কাউন্ট ২ জন দেখায়)
    io.to(roomId).emit("room-users", { users: usersArray });

    // ২. নতুন ইউজার ঢুকেছে বার্তা আগের মেম্বারদের পাঠানো
    socket.to(roomId).emit("user-connected", {
      socketId: socket.id,
      userName,
    });
  });

  // WebRTC Offer
  socket.on("offer", ({ target, offer, senderName }) => {
    io.to(target).emit("offer", {
      offer,
      caller: socket.id,
      callerUserName: senderName,
    });
  });

  // WebRTC Answer
  socket.on("answer", ({ target, answer }) => {
    io.to(target).emit("answer", {
      answer,
      responder: socket.id,
    });
  });

  // ICE Candidate exchange
  socket.on("ice-candidate", ({ target, candidate }) => {
    io.to(target).emit("ice-candidate", {
      candidate,
      sender: socket.id,
    });
  });

  // Real-time Chat Messaging
  socket.on("chat-message", ({ roomId, text }) => {
    const userName =
      socket.handshake.auth?.userName || `Student_${socket.id.slice(0, 4)}`;

    socket.to(roomId).emit("chat-message", {
      sender: userName,
      text,
    });
  });

  // ডিসকানেক্ট হ্যান্ডলার
  socket.on("disconnecting", () => {
    console.log("❌ User disconnecting:", socket.id);

    socket.rooms.forEach((roomId) => {
      if (roomUsersMap.has(roomId)) {
        const roomUsers = roomUsersMap.get(roomId);
        const user = roomUsers.get(socket.id);

        roomUsers.delete(socket.id);

        if (roomUsers.size === 0) {
          roomUsersMap.delete(roomId);
        } else {
          // রুমের বাকিদের আপডেট ইনফো পাঠানো
          io.to(roomId).emit("user-disconnected", {
            socketId: socket.id,
            userName: user?.userName || "User",
          });

          io.to(roomId).emit("room-users", {
            users: Array.from(roomUsers.values()),
          });
        }
      }
    });
  });
});
/* =========================================================
   MULTER PDF
========================================================= */

const storage = multer.diskStorage({
  destination: (req, file, cb) => { cb(null, uploadDir); },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const originalName = path.basename(file.originalname, ext).trim().replace(/\s+/g, "_").replace(/[^a-zA-Z0-9_-]/g, "");
    const uniqueName = `${Date.now()}-${Math.round(Math.random() * 1e9)}-${originalName}${ext}`;
    cb(null, uniqueName);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 60 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype !== "application/pdf") {
      return cb(new Error("Only PDF files are allowed!"));
    }
    cb(null, true);
  },
});

/* =========================================================
   MONGODB
========================================================= */

const uri = process.env.MONGODB_URI;
let client;
let studentsCollection;
let noticesCollection;
let notesCollection;
let dbReady = false;

async function connectDB() {
  if (dbReady) return;
  if (!uri) {
    console.error("❌ MONGODB_URI is missing");
    return;
  }

  client = new MongoClient(uri, {
    serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true },
  });

  await client.connect();
  const db = client.db("CST");

  studentsCollection = db.collection("students");
  noticesCollection = db.collection("notices");
  notesCollection = db.collection("notes");

  dbReady = true;
  console.log("✅ Connected to MongoDB");
}

const isValidObjectId = (id) => ObjectId.isValid(id);

/* =========================================================
   STUDENTS (REGISTER)
========================================================= */

app.post("/students", async (req, res) => {
  try {
    await connectDB();
    const { name, email, password, group, roll } = req.body;

    if (!name || !email || !password || !group || !roll) {
      return res.status(400).json({ success: false, message: "All fields are required!" });
    }

    const cleanName = name.trim();
    const cleanEmail = email.toLowerCase().trim();
    const cleanRoll = roll.trim();

    const existingEmail = await studentsCollection.findOne({ email: cleanEmail });
    if (existingEmail) {
      return res.status(409).json({ success: false, message: "Email already registered!" });
    }

    const existingRoll = await studentsCollection.findOne({ roll: cleanRoll });
    if (existingRoll) {
      return res.status(409).json({ success: false, message: "Roll number already registered!" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const student = {
      name: cleanName,
      email: cleanEmail,
      password: hashedPassword,
      group,
      roll: cleanRoll,
      role: "student",
      createdAt: new Date(),
    };

    const result = await studentsCollection.insertOne(student);

    res.status(201).json({
      success: true,
      message: "Student registered successfully!",
      insertedId: result.insertedId,
    });
  } catch (error) {
    console.error("Register error:", error);
    res.status(500).json({ success: false, message: "Failed to register student!" });
  }
});

app.get("/students", async (req, res) => {
  try {
    await connectDB();
    const students = await studentsCollection.find({}).sort({ createdAt: -1 }).project({ password: 0 }).toArray();
    res.json({ success: true, students });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to fetch students!" });
  }
});

app.get("/students/:id", async (req, res) => {
  try {
    await connectDB();
    const { id } = req.params;
    if (!isValidObjectId(id)) return res.status(400).json({ success: false, message: "Invalid student ID!" });

    const student = await studentsCollection.findOne({ _id: new ObjectId(id) }, { projection: { password: 0 } });
    if (!student) return res.status(404).json({ success: false, message: "Student not found!" });

    res.json({ success: true, student });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to fetch student!" });
  }
});

app.patch("/students/:id", async (req, res) => {
  try {
    await connectDB();
    const { id } = req.params;
    if (!isValidObjectId(id)) return res.status(400).json({ success: false, message: "Invalid student ID!" });

    const { name, email, group, roll } = req.body;
    const updateData = {};
    if (name) updateData.name = name.trim();
    if (email) updateData.email = email.toLowerCase().trim();
    if (group) updateData.group = group;
    if (roll) updateData.roll = roll.trim();

    const result = await studentsCollection.updateOne({ _id: new ObjectId(id) }, { $set: updateData });
    if (!result.matchedCount) return res.status(404).json({ success: false, message: "Student not found!" });

    res.json({ success: true, message: "Student updated successfully!" });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to update student!" });
  }
});

app.delete("/students/:id", async (req, res) => {
  try {
    await connectDB();
    const { id } = req.params;
    if (!isValidObjectId(id)) return res.status(400).json({ success: false, message: "Invalid student ID!" });

    const result = await studentsCollection.deleteOne({ _id: new ObjectId(id) });
    if (!result.deletedCount) return res.status(404).json({ success: false, message: "Student not found!" });

    res.json({ success: true, message: "Student deleted successfully!" });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to delete student!" });
  }
});

/* =========================================================
   LOGIN
========================================================= */


/* =========================================================
   LOGIN — FIXED
========================================================= */

app.post("/login", async (req, res) => {
  try {
    await connectDB();

    if (!studentsCollection) {
      return res.status(503).json({
        success: false,
        message: "Database is not connected.",
      });
    }

    const { name, emailOrRoll, password } = req.body || {};

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

    const token = jwt.sign(
      {
        userId: student._id.toString(),
        name: student.name,
        email: student.email || "",
        role,
      },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    return res.status(200).json({
      success: true,
      message: `Welcome back, ${student.name}!`,
      token,
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
   NOTICES
========================================================= */

app.post("/notices", async (req, res) => {
  try {
    await connectDB();
    const { title, description, category, publisher, group } = req.body;

    if (!title || !description) {
      return res.status(400).json({ success: false, message: "Title and description are required!" });
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

    sendOneSignalNotification({
      title: `📌 নতুন নোটিশ: ${notice.title}`,
      message: notice.description.substring(0, 100) + "...",
      data: { type: "notice", id: result.insertedId.toString() },
    });

    res.status(201).json({
      success: true,
      message: "Notice published successfully!",
      insertedId: result.insertedId,
      notice,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: "Failed to publish notice!" });
  }
});

app.get("/notices", async (req, res) => {
  try {
    await connectDB();
    const notices = await noticesCollection.find({}).sort({ createdAt: -1 }).toArray();
    res.json(notices);
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to fetch notices!" });
  }
});

app.get("/notices/:id", async (req, res) => {
  try {
    await connectDB();
    const { id } = req.params;
    if (!isValidObjectId(id)) return res.status(400).json({ success: false, message: "Invalid notice ID!" });

    const notice = await noticesCollection.findOne({ _id: new ObjectId(id) });
    if (!notice) return res.status(404).json({ success: false, message: "Notice not found!" });

    res.json({ success: true, notice });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to fetch notice!" });
  }
});

app.patch("/notices/:id", async (req, res) => {
  try {
    await connectDB();
    const { id } = req.params;
    if (!isValidObjectId(id)) return res.status(400).json({ success: false, message: "Invalid notice ID!" });

    const { title, description, category, publisher, group } = req.body;
    const updateData = {};

    if (title !== undefined) updateData.title = title.trim();
    if (description !== undefined) updateData.description = description.trim();
    if (category !== undefined) updateData.category = category;
    if (publisher !== undefined) updateData.publisher = publisher.trim();
    if (group !== undefined) updateData.group = group;

    const result = await noticesCollection.updateOne({ _id: new ObjectId(id) }, { $set: updateData });
    if (!result.matchedCount) return res.status(404).json({ success: false, message: "Notice not found!" });

    res.json({ success: true, message: "Notice updated successfully!" });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to update notice!" });
  }
});

app.delete("/notices/:id", async (req, res) => {
  try {
    await connectDB();
    const { id } = req.params;
    if (!isValidObjectId(id)) return res.status(400).json({ success: false, message: "Invalid notice ID!" });

    const result = await noticesCollection.deleteOne({ _id: new ObjectId(id) });
    if (!result.deletedCount) return res.status(404).json({ success: false, message: "Notice not found!" });

    res.json({ success: true, message: "Notice deleted successfully!" });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to delete notice!" });
  }
});

/* =========================================================
   NOTES (PDF UPLOAD)
========================================================= */

app.post(
  "/notes",
  upload.single("file"),
  async (req, res) => {
    try {
      await connectDB();

      const { title, subject, description, group, semester, uploadedBy } = req.body;

      if (!title) {
        if (req.file) await fs.promises.unlink(req.file.path).catch(() => {});
        return res.status(400).json({ success: false, message: "Note title is required!" });
      }

      if (!req.file) {
        return res.status(400).json({ success: false, message: "PDF file is required!" });
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

      sendOneSignalNotification({
        title: `📚 নতুন নোট আপলোড হয়েছে: ${note.title}`,
        message: `विषय (Subject): ${note.subject} | সেমিস্টার: ${note.semester}`,
        data: { type: "note", id: result.insertedId.toString() },
      });

      res.status(201).json({
        success: true,
        message: "Note uploaded successfully!",
        insertedId: result.insertedId,
        note,
      });
    } catch (error) {
      console.error("Notes upload error:", error);
      if (req.file) await fs.promises.unlink(req.file.path).catch(() => {});
      res.status(500).json({ success: false, message: error?.message || "Failed to upload note!" });
    }
  }
);

app.get("/notes", async (req, res) => {
  try {
    await connectDB();
    const notes = await notesCollection.find({}).sort({ createdAt: -1 }).toArray();
    res.json({ success: true, notes });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to fetch notes!" });
  }
});

app.delete("/notes/:id", async (req, res) => {
  try {
    await connectDB();
    const { id } = req.params;
    if (!isValidObjectId(id)) return res.status(400).json({ success: false, message: "Invalid note ID!" });

    const note = await notesCollection.findOne({ _id: new ObjectId(id) });
    if (!note) return res.status(404).json({ success: false, message: "Note not found!" });

    if (note.fileName) {
      const filePath = path.join(uploadDir, note.fileName);
      if (fs.existsSync(filePath)) {
        await fs.promises.unlink(filePath).catch(() => {});
      }
    }

    await notesCollection.deleteOne({ _id: new ObjectId(id) });

    res.json({ success: true, message: "Note deleted successfully!" });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to delete note!" });
  }
});

/* =========================================================
   SERVER LISTENING
========================================================= */

server.listen(port, () => {
  console.log(`🚀 Server is running on port ${port}`);
});