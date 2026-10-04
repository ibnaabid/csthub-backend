const dotenv = require("dotenv");



dotenv.config();

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const os = require("os");

const http = require("http");
const { Server } = require("socket.io");

const { GoogleGenAI } = require("@google/genai");

const {
  MongoClient,
  ServerApiVersion,
  ObjectId,
} = require("mongodb");

const app = express();

const port = process.env.PORT || 8000;

// =========================================================
// MIDDLEWARE
// =========================================================

app.use(cors());

app.use(
  express.json({
    limit: "60mb",
  })
);

// =========================================================
// UPLOAD FOLDER
// =========================================================

const uploadDir = path.join(__dirname, "uploads");

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, {
    recursive: true,
  });
}

// =========================================================
// SERVE UPLOADED FILES
// =========================================================

app.use(
  "/uploads",
  express.static(uploadDir)
);

// =========================================================
// GEMINI AI
// =========================================================

const geminiClient = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

// =========================================================
// AI IMAGE MULTER
// =========================================================

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
        new Error(
          "Only JPG, PNG and WEBP images are allowed!"
        )
      );
    }

    cb(null, true);
  },
});

// =========================================================
// GEMINI AI IMAGE ASSISTANT
// =========================================================

// =========================================================
// GEMINI AI IMAGE ASSISTANT
// =========================================================

app.post(
  "/api/ai/explain-image",
  aiUpload.single("image"),
  async (req, res) => {
    let tempFilePath = null;

    try {
      // -----------------------------------------------------
      // CHECK IMAGE
      // -----------------------------------------------------

      if (!req.file) {
        return res.status(400).json({
          success: false,
          message: "Please upload an image.",
        });
      }

      // -----------------------------------------------------
      // STUDENT QUESTION
      // -----------------------------------------------------

      const question =
        req.body.question?.trim() ||
        "এই ছবিটা সহজভাবে বুঝিয়ে দাও।";

      console.log("📷 Image received:", req.file.originalname);
      console.log("❓ Question:", question);

      // =====================================================
      // 🧪 MOCK MODE
      // =====================================================
      // .env এ MOCK_GEMINI=true থাকলে আসল Gemini call হবে না।
      // এতে তুমি frontend + backend পুরোপুরি test করতে পারবে।
      // =====================================================

      if (process.env.MOCK_GEMINI === "true") {
        console.log(
          "🧪 MOCK GEMINI MODE: Gemini API is NOT being called."
        );

        // Gemini-এর মতো একটু delay
        await new Promise((resolve) =>
          setTimeout(resolve, 1500)
        );

        return res.status(200).json({
          success: true,
          answer: `🤖 CST HUB AI — Test Response

📌 ছবিতে কী আছে

তোমার image successfully backend-এ এসেছে।

📖 সহজ ব্যাখ্যা

এখন CST HUB MOCK mode-এ চলছে। তাই এই response টি আসল Gemini থেকে আসেনি।

🔍 বিস্তারিত

Frontend
↓
Image Upload
↓
FormData
↓
Express Backend
↓
Multer
↓
AI API Route
↓
Response
↓
Frontend

এই পুরো connection successfully কাজ করছে।

❓ তোমার প্রশ্ন:

${question}

✅ Test Result

Image upload        ✓
Question received   ✓
Backend API         ✓
Multer              ✓
Response            ✓
Frontend display    ✓

💡 মনে রাখার বিষয়

Gemini API quota reset হওয়ার পরে .env-এ

MOCK_GEMINI=false

করলেই আসল Gemini AI চালু হবে।`,
        });
      }

      // =====================================================
      // REAL GEMINI MODE
      // =====================================================

      console.log(
        "🤖 REAL GEMINI MODE: Calling Gemini API..."
      );

      // -----------------------------------------------------
      // CREATE TEMPORARY FILE
      // -----------------------------------------------------

      const extension =
        req.file.mimetype === "image/png"
          ? ".png"
          : req.file.mimetype === "image/webp"
          ? ".webp"
          : ".jpg";

      tempFilePath = path.join(
        os.tmpdir(),
        `Cst-hub-${Date.now()}${extension}`
      );

      await fs.promises.writeFile(
        tempFilePath,
        req.file.buffer
      );

      // -----------------------------------------------------
      // UPLOAD IMAGE TO GEMINI
      // -----------------------------------------------------

      const uploadedFile =
        await geminiClient.files.upload({
          file: tempFilePath,
          config: {
            mime_type: req.file.mimetype,
          },
        });

      console.log(
        "✅ Image uploaded to Gemini:",
        uploadedFile.uri
      );

      // -----------------------------------------------------
      // GEMINI INTERACTION
      // -----------------------------------------------------

      const interaction =
        await geminiClient.interactions.create({
          model: "gemini-3.8-flash",

          input: [
            {
              type: "text",

              text: `
You are the AI Study Assistant of CST HUB.

A student has uploaded an educational image.

Analyze the image carefully and answer the student's question.

Student's question:

${question}

The image may contain:

- Mathematics
- Programming code
- HTML
- CSS
- JavaScript
- React
- Node.js
- Physics
- Electrical diagrams
- Technical diagrams
- Class notes
- Tables
- Charts
- Exam questions
- Screenshots

IMPORTANT RULES:

1. Carefully read all visible information.
2. Do not guess information that cannot be clearly seen.
3. If something is blurry or unreadable, clearly say so.
4. If it is a mathematics problem, solve it step by step.
5. If it is programming code, explain what the code does.
6. If there is an error in the code, identify the error and explain how to fix it.
7. If it is a diagram, explain each important part.
8. If it is a physics problem, explain the formula and calculation.
9. If it is an electrical/technical diagram, explain the components and their purpose.
10. If it is a note, summarize it and explain the important points.
11. If it is a table or chart, explain the important information.
12. Use simple Bangla so a Bangladeshi polytechnic student can understand.
13. Keep technical terms in English when necessary.
14. Give the final answer clearly.
15. Do not make up information that is not present in the image.

Use this format when appropriate:

📌 ছবিতে কী আছে

Explain what you see in the image.

📖 সহজ ব্যাখ্যা

Explain the topic in very simple Bangla.

🔍 বিস্তারিত

Give the detailed explanation or step-by-step solution.

✅ উত্তর / Result

Give the final answer if there is a question.

💡 মনে রাখার বিষয়

Give important points the student should remember.
`,
            },

            {
              type: "image",
              uri: uploadedFile.uri,
              mime_type: uploadedFile.mimeType,
            },
          ],
        });

      // -----------------------------------------------------
      // GET GEMINI ANSWER
      // -----------------------------------------------------

      const answer = interaction.output_text;

      if (!answer) {
        return res.status(500).json({
          success: false,
          message: "Gemini did not return an answer.",
        });
      }

      // -----------------------------------------------------
      // SEND RESPONSE
      // -----------------------------------------------------

      return res.status(200).json({
        success: true,
        answer,
      });
    } catch (error) {
      console.error(
        "❌ Gemini Image Assistant Error:",
        error
      );

      // =====================================================
      // GEMINI 429 RATE LIMIT
      // =====================================================

      if (
        error?.status === 429 ||
        error?.code === 429 ||
        error?.message?.includes("429") ||
        error?.message
          ?.toLowerCase()
          .includes("rate limit")
      ) {
        return res.status(429).json({
          success: false,
          message:
            "Gemini Free Tier-এর daily limit শেষ হয়েছে। কিছুক্ষণ পরে আবার চেষ্টা করো।",
        });
      }

      // =====================================================
      // OTHER ERROR
      // =====================================================

      return res.status(500).json({
        success: false,
        message:
          error?.message ||
          "Failed to analyze image.",
      });
    } finally {
      // -----------------------------------------------------
      // DELETE TEMPORARY FILE
      // -----------------------------------------------------

      if (tempFilePath) {
        try {
          await fs.promises.unlink(
            tempFilePath
          );

          console.log(
            "🗑️ Temporary image deleted."
          );
        } catch (error) {
          console.log(
            "Temporary file cleanup skipped."
          );
        }
      }
    }
  }
);


// socekt io for room 


const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// ১. ডকস থেকে তোমার নেওয়া আইডি কম্পিউট করার ফাংশন (অথেন্টিকেশন বা ইউজার ইনফো চেক করার জন্য)
async function computeUserIdFromHeaders(headers) {
  // এখানে তুমি চাইলে ফ্রন্টএন্ড থেকে পাঠানো token বা userId হ্যান্ডশেক হেডার থেকে নিতে পারো
  // উদাহরণস্বরূপ: headers["user-id"] বা jwt verify করে userId রিটার্ন করা
  return headers["user-id"] || "guest-user-" + Math.random().toString(36).substring(7);
}

io.on("connection", async (socket) => {
  // ডকসের নিয়মে হ্যান্ডশেক হেডার থেকে ইউজার আইডি বের করে তার পার্সোনাল রুমে জয়েন করিয়ে দিলাম
  const userId = await computeUserIdFromHeaders(socket.handshake.headers);
  socket.join(userId);
  console.log(`User connected & joined personal room: ${userId}`);

  // ২. স্টাডি রুম বা স্পেসিফিক প্রজেক্ট রুমে জয়েন করার লজিক (ডকসের "some room" বা project ரூমের মতো)
  socket.on("join-study-room", (roomId) => {
    socket.join(roomId);
    console.log(`Socket ${socket.id} joined study room: ${roomId}`);

    // রুমে উপস্থিত অন্য মেম্বারকে জানানো যে নতুন কেউ এসেছে (WebRTC এর জন্য)
    socket.to(roomId).emit("user-connected", { userId, socketId: socket.id });
  });

  // ৩. WebRTC Signaling (Offer, Answer, ICE Candidates আদান-প্রদান)
  socket.on("offer", (payload) => {
    io.to(payload.target).emit("offer", {
      offer: payload.offer,
      caller: socket.id
    });
  });

  socket.on("answer", (payload) => {
    io.to(payload.target).emit("answer", {
      answer: payload.answer,
      receiver: socket.id
    });
  });

  socket.on("ice-candidate", (incoming) => {
    io.to(incoming.target).emit("ice-candidate", {
      candidate: incoming.candidate,
      sender: socket.id
    });
  });

  // ৪. ডকসের ডিসকানেক্টিং ও রুম ট্র্যাক করার লজিক
  socket.on("disconnecting", () => {
    console.log("Active rooms before disconnect:", socket.rooms); 
    // Set থেকে চেক করে রুমের অন্যদের জানিয়ে দেওয়া যে ইউজার চলে গেছে
    for (const room of socket.rooms) {
      if (room !== socket.id && room !== userId) {
        socket.to(room).emit("user-disconnected", socket.id);
      }
    }
  });

  socket.on("disconnect", () => {
    // ডকস অনুযায়ী এখানে socket.rooms.size === 0 হয়ে যায়
    console.log(`User fully disconnected: ${socket.id}`);
  });
});



// =========================================================
// MULTER PDF CONFIGURATION
// =========================================================

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },

  filename: (req, file, cb) => {
    const ext = path
      .extname(file.originalname)
      .toLowerCase();

    const originalName = path
      .basename(file.originalname, ext)
      .trim()
      .replace(/\s+/g, "_")
      .replace(/[^a-zA-Z0-9_-]/g, "");

    const uniqueName = `${Date.now()}-${Math.round(
      Math.random() * 1e9
    )}-${originalName}${ext}`;

    cb(null, uniqueName);
  },
});

// =========================================================
// PDF UPLOAD
// =========================================================

const upload = multer({
  storage,

  limits: {
    fileSize: 60 * 1024 * 1024,
  },

  fileFilter: (req, file, cb) => {
    if (file.mimetype !== "application/pdf") {
      return cb(
        new Error(
          "Only PDF files are allowed!"
        )
      );
    }

    cb(null, true);
  },
});

// =========================================================
// MONGODB
// =========================================================

const uri = process.env.MONGODB_URI;

if (!uri) {
  console.error(
    "❌ MONGODB_URI is missing in .env"
  );

  process.exit(1);
}

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

// =========================================================
// HELPER
// =========================================================

const isValidObjectId = (id) => {
  return ObjectId.isValid(id);
};

// =========================================================
// DATABASE + API
// =========================================================

async function run() {
  try {
    // -------------------------------------------------------
    // CONNECT MONGODB
    // -------------------------------------------------------

    await client.connect();

    console.log(
      "✅ Connected to MongoDB"
    );

    // -------------------------------------------------------
    // DATABASE
    // -------------------------------------------------------

    const db = client.db("CST");

    // -------------------------------------------------------
    // COLLECTIONS
    // -------------------------------------------------------

    const studentsCollection =
      db.collection("students");

    const noticesCollection =
      db.collection("notices");

    const notesCollection =
      db.collection("notes");

    // =======================================================
    // HOME
    // =======================================================

    app.get("/", (req, res) => {
      res.json({
        success: true,
        message:
          "CST HUB Backend is running 🚀",
      });
    });

    // =======================================================
    // STUDENTS
    // =======================================================

    // -------------------------------------------------------
    // REGISTER STUDENT
    // -------------------------------------------------------

    app.post(
      "/students",

      async (req, res) => {
        try {
          const {
            name,
            email,
            password,
            group,
            roll,
          } = req.body;

          if (
            !name ||
            !email ||
            !password ||
            !group ||
            !roll
          ) {
            return res.status(400).json({
              success: false,
              message:
                "All fields are required!",
            });
          }

          const cleanName =
            name.trim();

          const cleanEmail =
            email.toLowerCase().trim();

          const cleanRoll =
            roll.trim();

          // Check email

          const existingEmail =
            await studentsCollection.findOne({
              email: cleanEmail,
            });

          if (existingEmail) {
            return res.status(409).json({
              success: false,
              message:
                "Email already registered!",
            });
          }

          // Check roll

          const existingRoll =
            await studentsCollection.findOne({
              roll: cleanRoll,
            });

          if (existingRoll) {
            return res.status(409).json({
              success: false,
              message:
                "Roll number already registered!",
            });
          }

          const student = {
            name: cleanName,
            email: cleanEmail,
            password,
            group,
            roll: cleanRoll,
            role: "student",
            createdAt: new Date(),
          };

          const result =
            await studentsCollection.insertOne(
              student
            );

          res.status(201).json({
            success: true,

            message:
              "Student registered successfully!",

            insertedId:
              result.insertedId,
          });
        } catch (error) {
          console.error(
            "Register error:",
            error
          );

          res.status(500).json({
            success: false,
            message:
              "Failed to register student!",
          });
        }
      }
    );

    // -------------------------------------------------------
    // GET ALL STUDENTS
    // -------------------------------------------------------

    app.get(
      "/students",

      async (req, res) => {
        try {
          const students =
            await studentsCollection
              .find({})
              .sort({
                createdAt: -1,
              })
              .project({
                password: 0,
              })
              .toArray();

          res.json({
            success: true,
            students,
          });
        } catch (error) {
          console.error(
            "Get students error:",
            error
          );

          res.status(500).json({
            success: false,
            message:
              "Failed to fetch students!",
          });
        }
      }
    );

    // -------------------------------------------------------
    // GET SINGLE STUDENT
    // -------------------------------------------------------

    app.get(
      "/students/:id",

      async (req, res) => {
        try {
          const { id } = req.params;

          if (!isValidObjectId(id)) {
            return res.status(400).json({
              success: false,
              message:
                "Invalid student ID!",
            });
          }

          const student =
            await studentsCollection.findOne(
              {
                _id: new ObjectId(id),
              },
              {
                projection: {
                  password: 0,
                },
              }
            );

          if (!student) {
            return res.status(404).json({
              success: false,
              message:
                "Student not found!",
            });
          }

          res.json({
            success: true,
            student,
          });
        } catch (error) {
          console.error(error);

          res.status(500).json({
            success: false,
            message:
              "Failed to fetch student!",
          });
        }
      }
    );

    // -------------------------------------------------------
    // UPDATE STUDENT
    // -------------------------------------------------------

    app.patch(
      "/students/:id",

      async (req, res) => {
        try {
          const { id } = req.params;

          if (!isValidObjectId(id)) {
            return res.status(400).json({
              success: false,
              message:
                "Invalid student ID!",
            });
          }

          const {
            name,
            email,
            group,
            roll,
          } = req.body;

          const updateData = {};

          if (name) {
            updateData.name =
              name.trim();
          }

          if (email) {
            updateData.email =
              email
                .toLowerCase()
                .trim();
          }

          if (group) {
            updateData.group =
              group;
          }

          if (roll) {
            updateData.roll =
              roll.trim();
          }

          const result =
            await studentsCollection.updateOne(
              {
                _id: new ObjectId(id),
              },
              {
                $set: updateData,
              }
            );

          if (!result.matchedCount) {
            return res.status(404).json({
              success: false,
              message:
                "Student not found!",
            });
          }

          res.json({
            success: true,
            message:
              "Student updated successfully!",
          });
        } catch (error) {
          console.error(error);

          res.status(500).json({
            success: false,
            message:
              "Failed to update student!",
          });
        }
      }
    );

    // -------------------------------------------------------
    // DELETE STUDENT
    // -------------------------------------------------------

    app.delete(
      "/students/:id",

      async (req, res) => {
        try {
          const { id } = req.params;

          if (!isValidObjectId(id)) {
            return res.status(400).json({
              success: false,
              message:
                "Invalid student ID!",
            });
          }

          const result =
            await studentsCollection.deleteOne(
              {
                _id: new ObjectId(id),
              }
            );

          if (!result.deletedCount) {
            return res.status(404).json({
              success: false,
              message:
                "Student not found!",
            });
          }

          res.json({
            success: true,
            message:
              "Student deleted successfully!",
          });
        } catch (error) {
          console.error(error);

          res.status(500).json({
            success: false,
            message:
              "Failed to delete student!",
          });
        }
      }
    );

    // =======================================================
    // LOGIN
    // =======================================================

    app.post(
      "/login",

      async (req, res) => {
        try {
          const {
            name,
            emailOrRoll,
            password,
          } = req.body;

          if (
            !name ||
            !emailOrRoll ||
            !password
          ) {
            return res.status(400).json({
              success: false,
              message:
                "All login fields are required!",
            });
          }

          const student =
            await studentsCollection.findOne({
              name: name.trim(),

              $or: [
                {
                  email:
                    emailOrRoll
                      .toLowerCase()
                      .trim(),
                },

                {
                  roll:
                    emailOrRoll.trim(),
                },
              ],

              password,
            });

          if (!student) {
            return res.status(401).json({
              success: false,
              message:
                "Invalid name, email/roll or password!",
            });
          }

          const studentData = {
            _id: student._id,
            name: student.name,
            email: student.email,
            group: student.group,
            roll: student.roll,

            role:
              student.role ||
              "student",

            createdAt:
              student.createdAt,
          };

          res.json({
            success: true,

            message:
              `Welcome back, ${student.name}!`,

            user: studentData,
          });
        } catch (error) {
          console.error(
            "Login error:",
            error
          );

          res.status(500).json({
            success: false,
            message:
              "Login failed!",
          });
        }
      }
    );

    // =======================================================
    // NOTICES
    // =======================================================

    // -------------------------------------------------------
    // ADD NOTICE
    // -------------------------------------------------------

    app.post(
      "/notices",

      async (req, res) => {
        try {
          const {
            title,
            description,
            category,
            publisher,
            group,
          } = req.body;

          if (
            !title ||
            !description
          ) {
            return res.status(400).json({
              success: false,
              message:
                "Title and description are required!",
            });
          }

          const notice = {
            title:
              title.trim(),

            description:
              description.trim(),

            category:
              category ||
              "general",

            publisher:
              publisher?.trim() ||
              "CR Office",

            group:
              group || "All",

            createdAt:
              new Date(),
          };

          const result =
            await noticesCollection.insertOne(
              notice
            );

          res.status(201).json({
            success: true,

            message:
              "Notice published successfully!",

            insertedId:
              result.insertedId,

            notice,
          });
        } catch (error) {
          console.error(error);

          res.status(500).json({
            success: false,
            message:
              "Failed to publish notice!",
          });
        }
      }
    );

    // -------------------------------------------------------
    // GET ALL NOTICES
    // -------------------------------------------------------

    app.get(
      "/notices",

      async (req, res) => {
        try {
          const notices =
            await noticesCollection
              .find({})
              .sort({
                createdAt: -1,
              })
              .toArray();

          res.json(notices);
        } catch (error) {
          console.error(error);

          res.status(500).json({
            success: false,
            message:
              "Failed to fetch notices!",
          });
        }
      }
    );

    // -------------------------------------------------------
    // GET SINGLE NOTICE
    // -------------------------------------------------------

    app.get(
      "/notices/:id",

      async (req, res) => {
        try {
          const { id } = req.params;

          if (!isValidObjectId(id)) {
            return res.status(400).json({
              success: false,
              message:
                "Invalid notice ID!",
            });
          }

          const notice =
            await noticesCollection.findOne({
              _id: new ObjectId(id),
            });

          if (!notice) {
            return res.status(404).json({
              success: false,
              message:
                "Notice not found!",
            });
          }

          res.json({
            success: true,
            notice,
          });
        } catch (error) {
          console.error(error);

          res.status(500).json({
            success: false,
            message:
              "Failed to fetch notice!",
          });
        }
      }
    );

    // -------------------------------------------------------
    // UPDATE NOTICE
    // -------------------------------------------------------

    app.patch(
      "/notices/:id",

      async (req, res) => {
        try {
          const { id } = req.params;

          if (!isValidObjectId(id)) {
            return res.status(400).json({
              success: false,
              message:
                "Invalid notice ID!",
            });
          }

          const {
            title,
            description,
            category,
            publisher,
            group,
          } = req.body;

          const updateData = {};

          if (
            title !== undefined
          ) {
            updateData.title =
              title.trim();
          }

          if (
            description !== undefined
          ) {
            updateData.description =
              description.trim();
          }

          if (
            category !== undefined
          ) {
            updateData.category =
              category;
          }

          if (
            publisher !== undefined
          ) {
            updateData.publisher =
              publisher.trim();
          }

          if (
            group !== undefined
          ) {
            updateData.group =
              group;
          }

          const result =
            await noticesCollection.updateOne(
              {
                _id: new ObjectId(id),
              },
              {
                $set: updateData,
              }
            );

          if (!result.matchedCount) {
            return res.status(404).json({
              success: false,
              message:
                "Notice not found!",
            });
          }

          res.json({
            success: true,
            message:
              "Notice updated successfully!",
          });
        } catch (error) {
          console.error(error);

          res.status(500).json({
            success: false,
            message:
              "Failed to update notice!",
          });
        }
      }
    );

    // -------------------------------------------------------
    // DELETE NOTICE
    // -------------------------------------------------------

    app.delete(
      "/notices/:id",

      async (req, res) => {
        try {
          const { id } = req.params;

          if (!isValidObjectId(id)) {
            return res.status(400).json({
              success: false,
              message:
                "Invalid notice ID!",
            });
          }

          const result =
            await noticesCollection.deleteOne(
              {
                _id: new ObjectId(id),
              }
            );

          if (!result.deletedCount) {
            return res.status(404).json({
              success: false,
              message:
                "Notice not found!",
            });
          }

          res.json({
            success: true,
            message:
              "Notice deleted successfully!",
          });
        } catch (error) {
          console.error(error);

          res.status(500).json({
            success: false,
            message:
              "Failed to delete notice!",
          });
        }
      }
    );

    // =======================================================
    // NOTES / PDF
    // =======================================================

    // -------------------------------------------------------
    // ADD NOTE + PDF
    // -------------------------------------------------------

    app.post(
      "/notes",

      upload.single("file"),

      async (req, res) => {
        try {
          const {
            title,
            subject,
            description,
            group,
            semester,
            uploadedBy,
            uploadedByEmail,
          } = req.body;

          if (!title) {
            return res.status(400).json({
              success: false,
              message:
                "Note title is required!",
            });
          }

          if (!req.file) {
            return res.status(400).json({
              success: false,
              message:
                "PDF file is required!",
            });
          }

          // -------------------------------------------------
          // PDF URL
          // -------------------------------------------------

          const fileUrl =
            `${req.protocol}://${req.get(
              "host"
            )}/uploads/${req.file.filename}`;

          // -------------------------------------------------
          // NOTE DATA
          // -------------------------------------------------

          const note = {
            title:
              title.trim(),

            subject:
              subject ||
              "General",

            description:
              description?.trim() ||
              "",

            group:
              group || "All",

            semester:
              semester ||
              "4th Semester",

            uploadedBy:
              uploadedBy ||
              "CR",

            uploadedByEmail:
              uploadedByEmail ||
              "",

            fileName:
              req.file.originalname,

            fileUrl,

            fileType:
              req.file.mimetype,

            fileSize:
              req.file.size,

            serverFileName:
              req.file.filename,

            createdAt:
              new Date(),
          };

          // -------------------------------------------------
          // SAVE TO MONGODB
          // -------------------------------------------------

          const result =
            await notesCollection.insertOne(
              note
            );

          res.status(201).json({
            success: true,

            message:
              "Note published successfully!",

            insertedId:
              result.insertedId,

            note,
          });
        } catch (error) {
          console.error(
            "Add note error:",
            error
          );

          // Delete uploaded file

          if (req.file) {
            const filePath =
              path.join(
                uploadDir,
                req.file.filename
              );

            if (
              fs.existsSync(filePath)
            ) {
              fs.unlinkSync(
                filePath
              );
            }
          }

          res.status(500).json({
            success: false,
            message:
              "Failed to publish note!",
          });
        }
      }
    );

    // -------------------------------------------------------
    // GET ALL NOTES
    // -------------------------------------------------------

    app.get(
      "/notes",

      async (req, res) => {
        try {
          const notes =
            await notesCollection
              .find({})
              .sort({
                createdAt: -1,
              })
              .toArray();

          res.json(notes);
        } catch (error) {
          console.error(
            "Get notes error:",
            error
          );

          res.status(500).json({
            success: false,
            message:
              "Failed to fetch notes!",
          });
        }
      }
    );

    // -------------------------------------------------------
    // GET SINGLE NOTE
    // -------------------------------------------------------

    app.get(
      "/notes/:id",

      async (req, res) => {
        try {
          const { id } = req.params;

          if (!isValidObjectId(id)) {
            return res.status(400).json({
              success: false,
              message:
                "Invalid note ID!",
            });
          }

          const note =
            await notesCollection.findOne({
              _id: new ObjectId(id),
            });

          if (!note) {
            return res.status(404).json({
              success: false,
              message:
                "Note not found!",
            });
          }

          res.json({
            success: true,
            note,
          });
        } catch (error) {
          console.error(error);

          res.status(500).json({
            success: false,
            message:
              "Failed to fetch note!",
          });
        }
      }
    );

    // -------------------------------------------------------
    // UPDATE NOTE
    // -------------------------------------------------------

    app.patch(
      "/notes/:id",

      upload.single("file"),

      async (req, res) => {
        try {
          const { id } = req.params;

          if (!isValidObjectId(id)) {
            return res.status(400).json({
              success: false,
              message:
                "Invalid note ID!",
            });
          }

          // Find existing note

          const existingNote =
            await notesCollection.findOne({
              _id: new ObjectId(id),
            });

          if (!existingNote) {
            // Remove newly uploaded PDF

            if (req.file) {
              const filePath =
                path.join(
                  uploadDir,
                  req.file.filename
                );

              if (
                fs.existsSync(filePath)
              ) {
                fs.unlinkSync(
                  filePath
                );
              }
            }

            return res.status(404).json({
              success: false,
              message:
                "Note not found!",
            });
          }

          const {
            title,
            subject,
            description,
            group,
            semester,
            uploadedBy,
            uploadedByEmail,
          } = req.body;

          const updateData = {};

          // -------------------------------------------------
          // TEXT DATA
          // -------------------------------------------------

          if (
            title !== undefined
          ) {
            updateData.title =
              title.trim();
          }

          if (
            subject !== undefined
          ) {
            updateData.subject =
              subject;
          }

          if (
            description !==
            undefined
          ) {
            updateData.description =
              description.trim();
          }

          if (
            group !== undefined
          ) {
            updateData.group =
              group;
          }

          if (
            semester !== undefined
          ) {
            updateData.semester =
              semester;
          }

          if (
            uploadedBy !==
            undefined
          ) {
            updateData.uploadedBy =
              uploadedBy;
          }

          if (
            uploadedByEmail !==
            undefined
          ) {
            updateData.uploadedByEmail =
              uploadedByEmail;
          }

          // -------------------------------------------------
          // NEW PDF
          // -------------------------------------------------

          if (req.file) {
            const newFileUrl =
              `${req.protocol}://${req.get(
                "host"
              )}/uploads/${req.file.filename}`;

            updateData.fileName =
              req.file.originalname;

            updateData.fileUrl =
              newFileUrl;

            updateData.fileType =
              req.file.mimetype;

            updateData.fileSize =
              req.file.size;

            updateData.serverFileName =
              req.file.filename;

            // ------------------------------------------------
            // DELETE OLD PDF
            // ------------------------------------------------

            if (
              existingNote.serverFileName
            ) {
              const oldFilePath =
                path.join(
                  uploadDir,
                  existingNote.serverFileName
                );

              if (
                fs.existsSync(
                  oldFilePath
                )
              ) {
                fs.unlinkSync(
                  oldFilePath
                );
              }
            }
          }

          // -------------------------------------------------
          // UPDATE DATABASE
          // -------------------------------------------------

          await notesCollection.updateOne(
            {
              _id: new ObjectId(id),
            },
            {
              $set: updateData,
            }
          );

          res.json({
            success: true,
            message:
              "Note updated successfully!",
          });
        } catch (error) {
          console.error(
            "Update note error:",
            error
          );

          // Delete new PDF

          if (req.file) {
            const filePath =
              path.join(
                uploadDir,
                req.file.filename
              );

            if (
              fs.existsSync(filePath)
            ) {
              fs.unlinkSync(
                filePath
              );
            }
          }

          res.status(500).json({
            success: false,
            message:
              "Failed to update note!",
          });
        }
      }
    );

    // -------------------------------------------------------
    // DELETE NOTE
    // -------------------------------------------------------

    app.delete(
      "/notes/:id",

      async (req, res) => {
        try {
          const { id } = req.params;

          if (!isValidObjectId(id)) {
            return res.status(400).json({
              success: false,
              message:
                "Invalid note ID!",
            });
          }

          // Find note

          const note =
            await notesCollection.findOne({
              _id: new ObjectId(id),
            });

          if (!note) {
            return res.status(404).json({
              success: false,
              message:
                "Note not found!",
            });
          }

          // -------------------------------------------------
          // DELETE PDF FROM SERVER
          // -------------------------------------------------

          if (
            note.serverFileName
          ) {
            const filePath =
              path.join(
                uploadDir,
                note.serverFileName
              );

            if (
              fs.existsSync(filePath)
            ) {
              fs.unlinkSync(
                filePath
              );
            }
          }

          // -------------------------------------------------
          // DELETE DATABASE RECORD
          // -------------------------------------------------

          await notesCollection.deleteOne(
            {
              _id: new ObjectId(id),
            }
          );

          res.json({
            success: true,
            message:
              "Note deleted successfully!",
          });
        } catch (error) {
          console.error(
            "Delete note error:",
            error
          );

          res.status(500).json({
            success: false,
            message:
              "Failed to delete note!",
          });
        }
      }
    );

    // =======================================================
    // ERROR HANDLER
    // =======================================================

    app.use(
      (err, req, res, next) => {
        console.error(
          "Server Error:",
          err
        );

        // ---------------------------------------------------
        // AI IMAGE FILE SIZE
        // ---------------------------------------------------

        if (
          err instanceof
          multer.MulterError
        ) {
          if (
            err.code ===
            "LIMIT_FILE_SIZE"
          ) {
            return res.status(400).json({
              success: false,
              message:
                "File size is too large!",
            });
          }
        }

        // ---------------------------------------------------
        // PDF VALIDATION
        // ---------------------------------------------------

        if (
          err.message ===
          "Only PDF files are allowed!"
        ) {
          return res.status(400).json({
            success: false,
            message:
              "Only PDF files are allowed!",
          });
        }

        // ---------------------------------------------------
        // IMAGE VALIDATION
        // ---------------------------------------------------

        if (
          err.message ===
          "Only JPG, PNG and WEBP images are allowed!"
        ) {
          return res.status(400).json({
            success: false,
            message:
              "Only JPG, PNG and WEBP images are allowed!",
          });
        }

        // ---------------------------------------------------
        // OTHER ERRORS
        // ---------------------------------------------------

        res.status(500).json({
          success: false,

          message:
            err.message ||
            "Something went wrong!",
        });
      }
    );

    console.log(
      "🚀 All API routes are ready"
    );
  } catch (error) {
    console.error(
      "❌ MongoDB connection failed:",
      error
    );
  }
}

// =========================================================
// START DATABASE
// =========================================================

run();

// =========================================================
// START SERVER
// =========================================================

app.listen(port, () => {
  console.log(
    `🚀 CST HUB Server running on port ${port}`
  );
});