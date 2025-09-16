require("dotenv").config(); // 👈 load .env first

const express = require("express");
const nodemailer = require("nodemailer");
const archiver = require("archiver");
const fs = require("fs");
const path = require("path");
const bodyParser = require("body-parser");
const mysql = require("mysql2/promise");
const cors = require("cors");

const app = express();

// ✅ Allow frontend
app.use(cors());
app.use(bodyParser.json({ limit: "10mb" }));

// ✅ DB connection pool
let poolConfig = {
  host: process.env.DB_HOST,
  user: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_DATABASE,
  port: process.env.DB_PORT
};
if (process.env.DB_CA) {
  poolConfig.ssl = { ca: process.env.DB_CA };
}
const pool = mysql.createPool(poolConfig);

// --- Home route ---
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "templates", "homepage.html"));
});

// --- Template preview (iframe) ---
app.get("/template/:filename", async (req, res) => {
  let { filename } = req.params;
  if (!filename.endsWith(".html")) filename += ".html";

  try {
    const [rows] = await pool.query(
      "SELECT content FROM pages WHERE filename = ? LIMIT 1",
      [filename]
    );
    if (rows.length > 0) {
      res.type("html").send(rows[0].content);
      return;
    }

    let filePath = path.join(__dirname, "templates", filename);
    if (fs.existsSync(filePath)) {
      res.sendFile(filePath);
    } else {
      res
        .type("html")
        .send(
          `<!DOCTYPE html><html><body><h3>⚠️ Template "${filename}" not found</h3></body></html>`
        );
    }
  } catch (err) {
    console.error("❌ DB Error in /template:", err);
    res
      .type("html")
      .send("<!DOCTYPE html><html><body><h3>❌ Database error</h3></body></html>");
  }
});

// --- Auto serve by name ---
app.get("/:page", async (req, res, next) => {
  let filename = req.params.page;
  if (!filename.endsWith(".html")) filename += ".html";

  try {
    const [rows] = await pool.query(
      "SELECT content FROM pages WHERE filename = ? LIMIT 1",
      [filename]
    );
    if (rows.length > 0) {
      res.type("html").send(rows[0].content);
      return;
    }

    const filePath = path.join(__dirname, "templates", filename);
    if (fs.existsSync(filePath)) {
      res.sendFile(filePath);
    } else {
      next();
    }
  } catch (err) {
    console.error("❌ DB Error in /:page:", err);
    res.status(500).send("Database error");
  }
});

// --- Save page ---
app.post("/update", async (req, res) => {
  let { filename, content } = req.body;
  if (!filename || !content) {
    return res
      .status(400)
      .json({ success: false, error: "Missing filename or content" });
  }
  if (!filename.endsWith(".html")) filename += ".html";

  try {
    await pool.query(
      "INSERT INTO pages (filename, content) VALUES (?, ?) ON DUPLICATE KEY UPDATE content = VALUES(content)",
      [filename, content]
    );
    res.json({ success: true, message: "✅ Saved successfully!" });
  } catch (err) {
    console.error("❌ DB Error in /update:", err);
    res.status(500).json({ success: false, error: "Error saving file" });
  }
});

// --- Load saved template ---
app.get("/api/load/:id", async (req, res) => {
  let websiteId = req.params.id;
  if (!websiteId.endsWith(".html")) websiteId += ".html";

  try {
    const [rows] = await pool.query(
      "SELECT content FROM pages WHERE filename = ? LIMIT 1",
      [websiteId]
    );
    if (rows.length > 0) {
      res.json({ success: true, template: rows[0].content });
    } else {
      res.json({ success: false, error: "No saved template found" });
    }
  } catch (err) {
    console.error("❌ DB Error in /api/load:", err);
    res.status(500).json({ success: false, error: "Failed to load template" });
  }
});

// --- Reset all pages ---
app.post("/reset", async (req, res) => {
  try {
    await pool.query("DELETE FROM pages");
    res.json({ success: true });
  } catch (err) {
    console.error("❌ DB Error in /reset:", err);
    res.status(500).json({ success: false, error: "Error resetting pages" });
  }
});

// --- Publish (zip + email) ---
app.get("/publish", async (req, res) => {
  try {
    const tempDir = path.join(__dirname, "temp_publish");
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);

    fs.readdirSync(tempDir).forEach((f) =>
      fs.unlinkSync(path.join(tempDir, f))
    );

    const filesToInclude = [
      "homepage.html",
      "product.html",
      "buynow.html",
      "index.js",
      "style.css"
    ];

    filesToInclude.forEach((file) => {
      const srcPath = path.join(__dirname, "templates", file);
      const destPath = path.join(tempDir, file);
      if (fs.existsSync(srcPath)) {
        fs.copyFileSync(srcPath, destPath);
      }
    });

    const zipPath = path.join(__dirname, "publish.zip");
    const output = fs.createWriteStream(zipPath);
    const archive = archiver("zip", { zlib: { level: 9 } });

    archive.pipe(output);
    archive.directory(tempDir, false);
    archive.finalize();

    output.on("close", async () => {
      try {
        let transporter = nodemailer.createTransport({
          service: "gmail",
          auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASS
          }
        });

        let mailOptions = {
          from: process.env.EMAIL_USER,
          to: process.env.RECEIVER_EMAIL,
          subject: "ONKAAN - Published Website",
          text: "Attached are your published website files.",
          attachments: [{ filename: "publish.zip", path: zipPath }]
        };

        await transporter.sendMail(mailOptions);
        res.send("✅ Published website sent to email!");
      } catch (mailErr) {
        console.error("❌ Email send error:", mailErr);
        res.status(500).send("Error sending email");
      }
    });
  } catch (err) {
    console.error("❌ Publish error:", err);
    res.status(500).send("Error publishing website");
  }
});

// --- Start server ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`✅ Server running on http://localhost:${PORT}`)
);
