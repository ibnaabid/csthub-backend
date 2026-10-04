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
const server = http.createServer(app);

const port = process.env.PORT || 8000;

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
        new Error(
          "Only JPG, PNG and WEBP images are allowed!"
        )
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
        "এই ছবিটা সহজভাবে বুঝিয়ে দাও।";

      console.log(
        "📷 Image:",
        req.file.originalname
      );

      console.log(
        "❓ Question:",
        question
      );

      /* =========================
         MOCK MODE
      ========================= */

      if (
        process.env.MOCK_GEMINI === "true"
      ) {
        await new Promise((resolve) =>
          setTimeout(resolve, 1000)
        );

        return res.json({
          success: true,
          answer: `🤖 CST HUB AI (Mock Mode)

প্রশ্ন: ${question}

Image successfully received.

MOCK_GEMINI=false করলে আসল Gemini চালু হবে।`,
        });
      }

      /* =========================
         TEMP IMAGE
      ========================= */

      const extension =
        req.file.mimetype === "image/png"
          ? ".png"
          : req.file.mimetype ===
              "image/webp"
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

      /* =========================
         GEMINI UPLOAD
      ========================= */

      const uploadedFile =
        await geminiClient.files.upload({
          file: tempFilePath,

          config: {
            mime_type: req.file.mimetype,
          },
        });

      /* =========================
         GEMINI INTERACTION
      ========================= */

      const interaction =
        await geminiClient.interactions.create({
          model: "gemini-2.0-flash",

          input: [
            {
              type: "text",

              text: `You are CST HUB AI Study Assistant.

Answer in simple Bangla.

Student's question:
${question}`,
            },

            {
              type: "image",

              uri: uploadedFile.uri,

              mime_type:
                uploadedFile.mimeType,
            },
          ],
        });

      const answer =
        interaction.output_text;

      if (!answer) {
        return res.status(500).json({
          success: false,
          message:
            "Gemini did not return an answer.",
        });
      }

      return res.json({
        success: true,
        answer,
      });
    } catch (error) {
      console.error(
        "❌ Gemini Error:",
        error
      );

      if (
        error?.status === 429 ||
        error?.message?.includes("429") ||
        error?.message
          ?.toLowerCase()
          .includes("rate limit")
      ) {
        return res.status(429).json({
          success: false,
          message:
            "Gemini daily limit শেষ। পরে চেষ্টা করো।",
        });
      }

      return res.status(500).json({
        success: false,
        message:
          error?.message ||
          "Failed to analyze image.",
      });
    } finally {
      if (tempFilePath) {
        try {
          await fs.promises.unlink(
            tempFilePath
          );
        } catch (error) {
          // Ignore cleanup error
        }
      }
    }
  }
);

/* =========================================================
   SOCKET.IO
   STUDY ROOM
========================================================= */

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },

  transports: [
    "websocket",
    "polling",
  ],
});

/*
  Study room structure:

  roomId -> Set(socketId)

  Example:

  cst-oq3on9
      |
      |-- socketA
      |-- socketB

  Maximum 2 students per room.
*/

const studyRooms = new Map();

/* =========================================================
   SOCKET CONNECTION
========================================================= */

io.on("connection", (socket) => {
  console.log(
    `🔌 Socket connected: ${socket.id}`
  );

  /* =======================================================
     JOIN STUDY ROOM
  ======================================================= */

  socket.on(
    "join-study-room",
    (roomId) => {
      try {
        if (!roomId) {
          return;
        }

        const cleanRoomId =
          String(roomId).trim();

        if (!cleanRoomId) {
          return;
        }

        /* =========================
           CREATE ROOM IF NEEDED
        ========================= */

        if (
          !studyRooms.has(
            cleanRoomId
          )
        ) {
          studyRooms.set(
            cleanRoomId,
            new Set()
          );
        }

        const room =
          studyRooms.get(
            cleanRoomId
          );

        /* =========================
           ALREADY IN ROOM
        ========================= */

        if (
          room.has(socket.id)
        ) {
          return;
        }

        /* =========================
           MAX 2 STUDENTS
        ========================= */

        if (room.size >= 2) {
          console.log(
            `🚫 Room full: ${cleanRoomId}`
          );

          socket.emit(
            "room-full"
          );

          return;
        }

        /*
          Existing students
          BEFORE current student joins
        */

        const existingUsers =
          Array.from(room);

        /* =========================
           JOIN SOCKET.IO ROOM
        ========================= */

        room.add(socket.id);

        socket.join(
          cleanRoomId
        );

        socket.data.roomId =
          cleanRoomId;

        console.log(
          `📥 ${socket.id} joined room: ${cleanRoomId}`
        );

        /* =========================
           SEND EXISTING USERS
           TO NEW USER
        ========================= */

        socket.emit(
          "room-users",
          {
            users: existingUsers,
          }
        );

        /* =========================
           TELL EXISTING USER
           NEW USER ARRIVED
        ========================= */

        socket
          .to(cleanRoomId)
          .emit(
            "user-connected",
            {
              socketId:
                socket.id,
            }
          );

        /* =========================
           ROOM COUNT
        ========================= */

        io.to(cleanRoomId).emit(
          "room-user-count",
          {
            count: room.size,
          }
        );

        console.log(
          `👥 Room ${cleanRoomId}: ${room.size}/2`
        );
      } catch (error) {
        console.error(
          "Join room error:",
          error
        );
      }
    }
  );

  /* =======================================================
     OFFER
  ======================================================= */

  socket.on(
    "offer",
    (payload) => {
      try {
        if (
          !payload ||
          !payload.target ||
          !payload.offer
        ) {
          return;
        }

        io.to(
          payload.target
        ).emit(
          "offer",
          {
            offer:
              payload.offer,

            caller:
              socket.id,
          }
        );
      } catch (error) {
        console.error(
          "Offer error:",
          error
        );
      }
    }
  );

  /* =======================================================
     ANSWER
  ======================================================= */

  socket.on(
    "answer",
    (payload) => {
      try {
        if (
          !payload ||
          !payload.target ||
          !payload.answer
        ) {
          return;
        }

        io.to(
          payload.target
        ).emit(
          "answer",
          {
            answer:
              payload.answer,

            caller:
              socket.id,
          }
        );
      } catch (error) {
        console.error(
          "Answer error:",
          error
        );
      }
    }
  );

  /* =======================================================
     ICE CANDIDATE
  ======================================================= */

  socket.on(
    "ice-candidate",
    (payload) => {
      try {
        if (
          !payload ||
          !payload.target ||
          !payload.candidate
        ) {
          return;
        }

        io.to(
          payload.target
        ).emit(
          "ice-candidate",
          {
            candidate:
              payload.candidate,

            sender:
              socket.id,
          }
        );
      } catch (error) {
        console.error(
          "ICE error:",
          error
        );
      }
    }
  );

  /* =======================================================
     CHAT MESSAGE
  ======================================================= */

  socket.on(
    "chat-message",
    ({
      roomId,
      text,
      sender,
    }) => {
      try {
        if (
          !roomId ||
          !text
        ) {
          return;
        }

        const cleanRoomId =
          String(roomId).trim();

        const cleanText =
          String(text).trim();

        if (!cleanText) {
          return;
        }

        socket
          .to(cleanRoomId)
          .emit(
            "chat-message",
            {
              sender:
                sender ||
                "Student",

              text:
                cleanText,
            }
          );
      } catch (error) {
        console.error(
          "Chat error:",
          error
        );
      }
    }
  );

  /* =======================================================
     MANUAL LEAVE
  ======================================================= */

  socket.on(
    "leave-study-room",
    () => {
      removeUserFromStudyRoom(
        socket
      );
    }
  );

  /* =======================================================
     DISCONNECTING
  ======================================================= */

  socket.on(
    "disconnecting",
    () => {
      removeUserFromStudyRoom(
        socket
      );
    }
  );

  /* =======================================================
     DISCONNECT
  ======================================================= */

  socket.on(
    "disconnect",
    (reason) => {
      console.log(
        `❌ Socket disconnected: ${socket.id}`
      );

      console.log(
        `Reason: ${reason}`
      );
    }
  );
});

/* =========================================================
   REMOVE USER FROM STUDY ROOM
========================================================= */

function removeUserFromStudyRoom(
  socket
) {
  const roomId =
    socket.data.roomId;

  if (!roomId) {
    return;
  }

  const room =
    studyRooms.get(
      roomId
    );

  if (!room) {
    socket.data.roomId =
      null;

    return;
  }

  /* =========================
     REMOVE USER
  ========================= */

  room.delete(
    socket.id
  );

  console.log(
    `👋 ${socket.id} left room: ${roomId}`
  );

  /* =========================
     NOTIFY OTHER STUDENT
  ========================= */

  socket
    .to(roomId)
    .emit(
      "user-disconnected",
      {
        socketId:
          socket.id,
      }
    );

  /* =========================
     ROOM COUNT
  ========================= */

  io.to(roomId).emit(
    "room-user-count",
    {
      count: room.size,
    }
  );

  /* =========================
     DELETE EMPTY ROOM
  ========================= */

  if (room.size === 0) {
    studyRooms.delete(
      roomId
    );

    console.log(
      `🗑️ Empty room deleted: ${roomId}`
    );
  }

  socket.data.roomId =
    null;
}

/* =========================================================
   MULTER PDF
========================================================= */

const storage =
  multer.diskStorage({
    destination: (
      req,
      file,
      cb
    ) => {
      cb(
        null,
        uploadDir
      );
    },

    filename: (
      req,
      file,
      cb
    ) => {
      const ext =
        path
          .extname(
            file.originalname
          )
          .toLowerCase();

      const originalName =
        path
          .basename(
            file.originalname,
            ext
          )
          .trim()
          .replace(
            /\s+/g,
            "_"
          )
          .replace(
            /[^a-zA-Z0-9_-]/g,
            ""
          );

      const uniqueName =
        `${Date.now()}-${Math.round(
          Math.random() *
            1e9
        )}-${originalName}${ext}`;

      cb(
        null,
        uniqueName
      );
    },
  });

const upload = multer({
  storage,

  limits: {
    fileSize:
      60 * 1024 * 1024,
  },

  fileFilter: (
    req,
    file,
    cb
  ) => {
    if (
      file.mimetype !==
      "application/pdf"
    ) {
      return cb(
        new Error(
          "Only PDF files are allowed!"
        )
      );
    }

    cb(null, true);
  },
});

/* =========================================================
   MONGODB
========================================================= */

const uri =
  process.env.MONGODB_URI;

let client;

let studentsCollection;
let noticesCollection;
let notesCollection;

let dbReady = false;

async function connectDB() {
  if (dbReady) {
    return;
  }

  if (!uri) {
    console.error(
      "❌ MONGODB_URI is missing"
    );

    return;
  }

  client =
    new MongoClient(uri, {
      serverApi: {
        version:
          ServerApiVersion.v1,

        strict: true,

        deprecationErrors:
          true,
      },
    });

  await client.connect();

  const db =
    client.db("CST");

  studentsCollection =
    db.collection(
      "students"
    );

  noticesCollection =
    db.collection(
      "notices"
    );

  notesCollection =
    db.collection(
      "notes"
    );

  dbReady = true;

  console.log(
    "✅ Connected to MongoDB"
  );
}

const isValidObjectId =
  (id) =>
    ObjectId.isValid(id);

/* =========================================================
   STUDENTS
========================================================= */

app.post(
  "/students",
  async (req, res) => {
    try {
      await connectDB();

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
        email
          .toLowerCase()
          .trim();

      const cleanRoll =
        roll.trim();

      const existingEmail =
        await studentsCollection.findOne(
          {
            email:
              cleanEmail,
          }
        );

      if (existingEmail) {
        return res.status(409).json({
          success: false,
          message:
            "Email already registered!",
        });
      }

      const existingRoll =
        await studentsCollection.findOne(
          {
            roll:
              cleanRoll,
          }
        );

      if (existingRoll) {
        return res.status(409).json({
          success: false,
          message:
            "Roll number already registered!",
        });
      }

      const student = {
        name:
          cleanName,

        email:
          cleanEmail,

        password,

        group,

        roll:
          cleanRoll,

        role:
          "student",

        createdAt:
          new Date(),
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

app.get(
  "/students",
  async (req, res) => {
    try {
      await connectDB();

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

app.get(
  "/students/:id",
  async (req, res) => {
    try {
      await connectDB();

      const { id } =
        req.params;

      if (
        !isValidObjectId(id)
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Invalid student ID!",
        });
      }

      const student =
        await studentsCollection.findOne(
          {
            _id: new ObjectId(
              id
            ),
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

app.patch(
  "/students/:id",
  async (req, res) => {
    try {
      await connectDB();

      const { id } =
        req.params;

      if (
        !isValidObjectId(id)
      ) {
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
            _id: new ObjectId(
              id
            ),
          },
          {
            $set:
              updateData,
          }
        );

      if (
        !result.matchedCount
      ) {
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

app.delete(
  "/students/:id",
  async (req, res) => {
    try {
      await connectDB();

      const { id } =
        req.params;

      if (
        !isValidObjectId(id)
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Invalid student ID!",
        });
      }

      const result =
        await studentsCollection.deleteOne(
          {
            _id: new ObjectId(
              id
            ),
          }
        );

      if (
        !result.deletedCount
      ) {
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

/* =========================================================
   LOGIN
========================================================= */

app.post(
  "/login",
  async (req, res) => {
    try {
      await connectDB();

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
        await studentsCollection.findOne(
          {
            name:
              name.trim(),

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
          }
        );

      if (!student) {
        return res.status(401).json({
          success: false,
          message:
            "Invalid name, email/roll or password!",
        });
      }

      res.json({
        success: true,

        message: `Welcome back, ${student.name}!`,

        user: {
          _id:
            student._id,

          name:
            student.name,

          email:
            student.email,

          group:
            student.group,

          roll:
            student.roll,

          role:
            student.role ||
            "student",

          createdAt:
            student.createdAt,
        },
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

/* =========================================================
   NOTICES
========================================================= */

app.post(
  "/notices",
  async (req, res) => {
    try {
      await connectDB();

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
          group ||
          "All",

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

app.get(
  "/notices",
  async (req, res) => {
    try {
      await connectDB();

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

app.get(
  "/notices/:id",
  async (req, res) => {
    try {
      await connectDB();

      const { id } =
        req.params;

      if (
        !isValidObjectId(id)
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Invalid notice ID!",
        });
      }

      const notice =
        await noticesCollection.findOne(
          {
            _id: new ObjectId(
              id
            ),
          }
        );

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

app.patch(
  "/notices/:id",
  async (req, res) => {
    try {
      await connectDB();

      const { id } =
        req.params;

      if (
        !isValidObjectId(id)
      ) {
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
        description !==
        undefined
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
        publisher !==
        undefined
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
            _id: new ObjectId(
              id
            ),
          },
          {
            $set:
              updateData,
          }
        );

      if (
        !result.matchedCount
      ) {
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

app.delete(
  "/notices/:id",
  async (req, res) => {
    try {
      await connectDB();

      const { id } =
        req.params;

      if (
        !isValidObjectId(id)
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Invalid notice ID!",
        });
      }

      const result =
        await noticesCollection.deleteOne(
          {
            _id: new ObjectId(
              id
            ),
          }
        );

      if (
        !result.deletedCount
      ) {
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

/* =========================================================
   NOTES
========================================================= */

app.post(
  "/notes",
  upload.single("file"),
  async (req, res) => {
    try {
      await connectDB();

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

      const fileUrl =
        `${req.protocol}://${req.get(
          "host"
        )}/uploads/${req.file.filename}`;

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
          group ||
          "All",

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

      if (req.file) {
        const filePath =
          path.join(
            uploadDir,
            req.file.filename
          );

        if (
          fs.existsSync(
            filePath
          )
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

app.get(
  "/notes",
  async (req, res) => {
    try {
      await connectDB();

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

app.get(
  "/notes/:id",
  async (req, res) => {
    try {
      await connectDB();

      const { id } =
        req.params;

      if (
        !isValidObjectId(id)
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Invalid note ID!",
        });
      }

      const note =
        await notesCollection.findOne(
          {
            _id: new ObjectId(
              id
            ),
          }
        );

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

app.delete(
  "/notes/:id",
  async (req, res) => {
    try {
      await connectDB();

      const { id } =
        req.params;

      if (
        !isValidObjectId(id)
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Invalid note ID!",
        });
      }

      const note =
        await notesCollection.findOne(
          {
            _id: new ObjectId(
              id
            ),
          }
        );

      if (!note) {
        return res.status(404).json({
          success: false,
          message:
            "Note not found!",
        });
      }

      if (
        note.serverFileName
      ) {
        const filePath =
          path.join(
            uploadDir,
            note.serverFileName
          );

        if (
          fs.existsSync(
            filePath
          )
        ) {
          fs.unlinkSync(
            filePath
          );
        }
      }

      await notesCollection.deleteOne(
        {
          _id: new ObjectId(
            id
          ),
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

/* =========================================================
   ERROR HANDLER
========================================================= */

app.use(
  (
    err,
    req,
    res,
    next
  ) => {
    console.error(
      "Server Error:",
      err
    );

    if (
      err instanceof
        multer.MulterError &&
      err.code ===
        "LIMIT_FILE_SIZE"
    ) {
      return res.status(400).json({
        success: false,
        message:
          "File size is too large!",
      });
    }

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

    res.status(500).json({
      success: false,
      message:
        err.message ||
        "Something went wrong!",
    });
  }
);

/* =========================================================
   DATABASE + SERVER
========================================================= */

connectDB()
  .then(() => {
    server.listen(
      port,
      () => {
        console.log(
          `🚀 CST HUB Server running on port ${port}`
        );

        console.log(
          `🔌 Socket.IO ready`
        );
      }
    );
  })
  .catch((error) => {
    console.error(
      "❌ Database connection failed:",
      error
    );

    /*
      DB fail হলেও server চালু রাখছি
      যাতে Socket.IO কাজ করতে পারে।
    */

    server.listen(
      port,
      () => {
        console.log(
          `🚀 CST HUB Server running on port ${port}`
        );

        console.log(
          `⚠️ MongoDB is not connected`
        );
      }
    );
  });

module.exports = app;