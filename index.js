
const dotenv = require("dotenv");
dotenv.config();

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

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
// MULTER CONFIGURATION
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
// MULTER UPLOAD
// =========================================================

const upload = multer({
  storage,

  limits: {
    fileSize: 60 * 1024 * 1024,
  },

  fileFilter: (req, file, cb) => {
    if (file.mimetype !== "application/pdf") {
      return cb(
        new Error("Only PDF files are allowed!")
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

    console.log("✅ Connected to MongoDB");

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

          // Required fields
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
            await studentsCollection.findOne(
              {
                email: cleanEmail,
              }
            );

          if (existingEmail) {
            return res.status(409).json({
              success: false,
              message:
                "Email already registered!",
            });
          }

          // Check roll
          const existingRoll =
            await studentsCollection.findOne(
              {
                roll: cleanRoll,
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
          const { id } =
            req.params;

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
          const { id } =
            req.params;

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
          const { id } =
            req.params;

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
            await studentsCollection.findOne(
              {
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
              }
            );

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
          const { id } =
            req.params;

          if (!isValidObjectId(id)) {
            return res.status(400).json({
              success: false,
              message:
                "Invalid notice ID!",
            });
          }

          const notice =
            await noticesCollection.findOne(
              {
                _id: new ObjectId(id),
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

    // -------------------------------------------------------
    // UPDATE NOTICE
    // -------------------------------------------------------

    app.patch(
      "/notices/:id",
      async (req, res) => {
        try {
          const { id } =
            req.params;

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
          const { id } =
            req.params;

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

          // Check title
          if (!title) {
            return res.status(400).json({
              success: false,
              message:
                "Note title is required!",
            });
          }

          // Check PDF
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
            `${req.protocol}://${req.get("host")}/uploads/${req.file.filename}`;

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

            // Original file name
            fileName:
              req.file.originalname,

            // Public PDF URL
            fileUrl,

            // application/pdf
            fileType:
              req.file.mimetype,

            // bytes
            fileSize:
              req.file.size,

            // Actual filename in uploads/
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
          // if database operation fails
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
          const { id } =
            req.params;

          if (!isValidObjectId(id)) {
            return res.status(400).json({
              success: false,
              message:
                "Invalid note ID!",
            });
          }

          const note =
            await notesCollection.findOne(
              {
                _id: new ObjectId(id),
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

    // -------------------------------------------------------
    // UPDATE NOTE
    // -------------------------------------------------------
    //
    // New PDF is optional.
    //
    // -------------------------------------------------------

    app.patch(
      "/notes/:id",
      upload.single("file"),
      async (req, res) => {
        try {
          const { id } =
            req.params;

          if (!isValidObjectId(id)) {
            return res.status(400).json({
              success: false,
              message:
                "Invalid note ID!",
            });
          }

          // Find existing note
          const existingNote =
            await notesCollection.findOne(
              {
                _id: new ObjectId(id),
              }
            );

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
              `${req.protocol}://${req.get("host")}/uploads/${req.file.filename}`;

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
          // if update fails
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
          const { id } =
            req.params;

          if (!isValidObjectId(id)) {
            return res.status(400).json({
              success: false,
              message:
                "Invalid note ID!",
            });
          }

          // Find note
          const note =
            await notesCollection.findOne(
              {
                _id: new ObjectId(id),
              }
            );

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

        // Multer error
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
                "PDF size cannot exceed 60MB!",
            });
          }
        }

        // PDF validation error
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

        // Other errors
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

