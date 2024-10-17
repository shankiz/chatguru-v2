require('dotenv').config();
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const path = require("path");
const session = require('express-session');
const { ask } = require("./gemini.service");
const db = require('./db');
const bcrypt = require('bcrypt');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const multer = require('multer');
const fs = require('fs');

const app = express();

// Add this near the top of your file, after other imports
const unverifiedUsers = new Map();

app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: 'your-secret-key',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false } // Set to true if using HTTPS
}));

// Email configuration
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  },
  tls: {
    rejectUnauthorized: false
  }
});

// Verify transporter configuration
transporter.verify(function(error, success) {
  if (error) {
    console.log(error);
  } else {
    console.log("Server is ready to take our messages");
  }
});

// Set up multer for handling file uploads
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, 'public/uploads/')
    },
    filename: function (req, file, cb) {
        cb(null, Date.now() + path.extname(file.originalname))
    }
});

const upload = multer({ storage: storage });

app.get("/", (req, res) => {
  console.log("Received request for root path");
  if (req.session.userId) {
    res.redirect('/chat');
  } else {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
});

app.get("/chat", (req, res) => {
  console.log("Received request for chat path");
  if (req.session.userId) {
    res.sendFile(path.join(__dirname, 'public', 'chat.html'));
  } else {
    res.redirect('/');
  }
});

app.get("/user", async (req, res) => {
  console.log("Received request for user data");
  if (!req.session.userId) {
    console.error("User not authenticated");
    return res.status(401).json({ error: "Not authenticated" });
  }
  try {
    const user = await db.getUser(req.session.userId);
    if (!user) {
      console.error("User not found:", req.session.userId);
      return res.status(404).json({ error: "User not found" });
    }
    console.log("Returning user data for:", user.name);
    res.json({
      name: user.name,
      email: user.email,
      credits: user.credits,
      picture: user.picture
    });
  } catch (error) {
    console.error("Error fetching user data:", error);
    res.status(500).json({ error: "Error fetching user data", details: error.message });
  }
});

app.post("/chat", async (req, res) => {
  console.log("Received chat request");
  if (!req.session.userId) {
    console.error("User not authenticated");
    return res.status(401).json({ error: "Not authenticated" });
  }
  const chatId = req.body.chat_id;
  const message = req.body.message;
  if (!chatId || !message) {
    console.error("Invalid request: missing chat_id or message");
    return res.status(400).json({ error: "Invalid request" });
  }
  try {
    const user = await db.getUser(req.session.userId);
    if (!user) {
      console.error("User not found:", req.session.userId);
      return res.status(404).json({ error: "User not found" });
    }
    if (user.credits <= 0) {
      console.log("User has no credits left:", req.session.userId);
      return res.status(403).json({ error: "No credits left" });
    }
    console.log("Processing chat request for user:", user.name);
    const response = await ask(chatId, message);
    await db.updateCredits(req.session.userId, user.credits - 1);
    console.log("Chat response sent, credits updated for user:", user.name);
    res.json({ response, creditsLeft: user.credits - 1 });
  } catch (error) {
    console.error("Error processing chat request:", error);
    res.status(500).json({ error: "Error processing request", details: error.message });
  }
});

app.post("/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error("Error during logout:", err);
      res.status(500).json({ success: false, message: "Error logging out" });
    } else {
      res.json({ success: true });
    }
  });
});

app.post("/auth/signup", async (req, res) => {
    const { name, email, password, referralCode } = req.body;
    try {
        const existingUser = await db.getUserByEmail(email);
        if (existingUser) {
            return res.status(400).json({ success: false, message: 'Email already in use' });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const verificationCode = Math.floor(100000 + Math.random() * 900000).toString(); // 6-digit code
        const userId = crypto.randomBytes(16).toString('hex');

        // Store user data temporarily
        unverifiedUsers.set(userId, {
            name,
            email,
            hashedPassword,
            verificationCode,
            referralCode,
            createdAt: Date.now()
        });

        // Send verification email
        const mailOptions = {
            from: `"Chatguru V2" <${process.env.EMAIL_USER}>`,
            to: email,
            subject: 'Verify Your Email for Chatguru V2',
            html: `<p>Your verification code is: <strong>${verificationCode}</strong></p>`
        };

        transporter.sendMail(mailOptions, (error, info) => {
            if (error) {
                console.error("Error sending verification email:", error);
                unverifiedUsers.delete(userId);
                return res.status(500).json({ success: false, message: 'Error sending verification email. Please try again.' });
            }
            console.log('Verification email sent: ' + info.response);
            res.json({ success: true, message: 'Sign up initiated. Please check your email for the verification code.', userId: userId });
        });

    } catch (error) {
        console.error("Error in /auth/signup:", error);
        res.status(500).json({ success: false, message: 'Server error during sign up', error: error.message });
    }
});

app.post("/auth/verify", async (req, res) => {
    const { userId, verificationCode } = req.body;
    try {
        const userData = unverifiedUsers.get(userId);
        if (!userData) {
            return res.status(404).json({ success: false, message: 'Verification session not found or expired' });
        }
        if (userData.verificationCode !== verificationCode) {
            return res.status(400).json({ success: false, message: 'Invalid verification code' });
        }

        // Create the user in the database
        const newUser = await db.createUser(
            userId,
            userData.name,
            userData.email,
            20, // Initial credits
            null, // No picture yet
            userData.referralCode,
            userData.hashedPassword,
            null,
            true // isVerified set to true
        );

        // Handle referral credits
        if (userData.referralCode) {
            const referrer = await db.User.findOne({ referralCode: userData.referralCode });
            if (referrer) {
                if (!referrer.pendingReferrals.includes(userId)) {
                    referrer.pendingReferrals.push(userId);
                    await referrer.save();
                    console.log(`Added pending referral for user ${userId} to referrer ${referrer.userId}`);
                }
            }
        }

        res.json({ success: true, message: 'Email verified successfully. You can now add a profile picture or skip to sign in.' });
    } catch (error) {
        console.error("Error in /auth/verify:", error);
        res.status(500).json({ success: false, message: 'Server error during verification', error: error.message });
    }
});

app.post("/auth/signin", async (req, res) => {
  const { email, password } = req.body;
  try {
    const user = await db.getUserByEmail(email);
    if (!user) {
      return res.status(400).json({ success: false, message: 'Invalid email or password' });
    }

    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      return res.status(400).json({ success: false, message: 'Invalid email or password' });
    }

    req.session.userId = user.userId;
    res.json({ success: true, name: user.name, credits: user.credits, picture: user.picture });
  } catch (error) {
    console.error("Error in /auth/signin:", error);
    res.status(500).json({ success: false, message: 'Server error during sign in', error: error.message });
  }
});

app.get("/referral-code", async (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: "Not authenticated" });
  }
  try {
    const user = await db.getUser(req.session.userId);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }
    if (!user.referralCode) {
      user.referralCode = Math.random().toString(36).substring(2, 8).toUpperCase();
      await user.save();
    }
    const referralLink = new URL(`${req.protocol}://${req.get('host')}`);
    referralLink.searchParams.append('ref', user.referralCode);
    res.json({ referralCode: user.referralCode, referralLink: referralLink.toString() });
  } catch (error) {
    res.status(500).json({ error: "Error fetching referral code", details: error.message });
  }
});

app.post("/claim-referral", async (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: "Not authenticated" });
  }
  try {
    console.log(`Attempting to claim referral credits for user ${req.session.userId}`);
    const result = await db.claimReferralCredits(req.session.userId);
    if (result.success) {
      console.log(`Successfully claimed ${result.claimedCredits} credits for user ${req.session.userId}`);
      res.json({ success: true, newCredits: result.newCredits, claimedCredits: result.claimedCredits });
    } else {
      console.log(`No pending referrals to claim for user ${req.session.userId}`);
      res.json({ success: false, message: "No pending referrals to claim" });
    }
  } catch (error) {
    console.error("Error claiming referral credits:", error);
    res.status(500).json({ error: "Error claiming referral credits", details: error.message });
  }
});

app.get("/claimable-referrals", async (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: "Not authenticated" });
  }
  try {
    const user = await db.getUser(req.session.userId);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }
    console.log(`Checking claimable referrals for user ${user.userId}. Pending referrals:`, user.pendingReferrals);
    const claimableCredits = user.pendingReferrals.length * 30;
    res.json({ 
      claimableReferrals: user.pendingReferrals.length,
      claimableCredits: claimableCredits
    });
  } catch (error) {
    console.error("Error fetching claimable referrals:", error);
    res.status(500).json({ error: "Error fetching claimable referrals", details: error.message });
  }
});

// Add this new route for password reset
app.post("/auth/forgot-password", async (req, res) => {
  const { email } = req.body;
  console.log('Received forgot password request for email:', email);
  try {
    const user = await db.getUserByEmail(email);
    if (!user) {
      console.log('No user found with email:', email);
      return res.status(404).json({ success: false, message: 'No user found with this email address' });
    }

    const resetToken = crypto.randomBytes(20).toString('hex');
    user.resetPasswordToken = resetToken;
    user.resetPasswordExpires = Date.now() + 1800000; // 30 minutes
    await user.save();

    const resetUrl = `http://${req.headers.host}/reset-password/${resetToken}`;

    const mailOptions = {
      from: `"Chatguru V2" <${process.env.EMAIL_USER}>`,
      to: user.email,
      subject: 'Password Reset Link',
      html: `
        <p>You requested a password reset. Please click on the following link to reset your password:</p>
        <a href="${resetUrl}">${resetUrl}</a>
        <p>This link will expire in 30 minutes.</p>
        <p>If you didn't request this, please ignore this email.</p>
      `
    };

    console.log('Attempting to send password reset email to:', user.email);
    console.log('Email content:', mailOptions);

    transporter.sendMail(mailOptions, (error, info) => {
      if (error) {
        console.error('Error sending password reset email:', error);
        return res.status(500).json({ success: false, message: 'Error sending password reset email', error: error.message });
      }
      console.log('Password reset email sent successfully. Response:', info.response);
      res.json({ success: true, message: 'Password reset email sent' });
    });
  } catch (error) {
    console.error("Error in /auth/forgot-password:", error);
    res.status(500).json({ success: false, message: 'Server error during password reset process', error: error.message });
  }
});

app.get("/reset-password/:token", (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'reset-password.html'));
});

app.post("/auth/reset-password", async (req, res) => {
  const { token, newPassword } = req.body;
  try {
    const user = await db.getUserByResetToken(token);

    if (!user) {
      return res.status(400).json({ success: false, message: 'Password reset token is invalid or has expired' });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await db.updateUserPassword(user.userId, hashedPassword);

    res.json({ success: true, message: 'Password has been reset successfully' });
  } catch (error) {
    console.error("Error in /auth/reset-password:", error);
    res.status(500).json({ success: false, message: 'Error resetting password', error: error.message });
  }
});

app.post("/upload-profile-picture", upload.single('picture'), async (req, res) => {
    const { userId } = req.body;
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, message: 'No file uploaded' });
        }

        const user = await db.getUser(userId);
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        const picturePath = '/uploads/' + req.file.filename;
        await db.updateUserProfilePicture(userId, picturePath);

        res.json({ success: true, message: 'Profile picture uploaded successfully' });
    } catch (error) {
        console.error("Error uploading profile picture:", error);
        res.status(500).json({ success: false, message: 'Error uploading profile picture', error: error.message });
    }
});

app.post("/auth/auto-login", async (req, res) => {
    const { userId } = req.body;
    console.log('Received auto-login request for userId:', userId);
    try {
        const user = await db.getUser(userId);
        console.log('User found:', user ? 'Yes' : 'No');
        if (!user) {
            console.log('User not found for userId:', userId);
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        console.log('User verification status:', user.isVerified);
        if (!user.isVerified) {
            console.log('User is not verified:', userId);
            return res.status(403).json({ success: false, message: 'User is not verified' });
        }

        req.session.userId = user.userId;
        console.log('Auto-login successful for userId:', userId);
        res.json({ 
            success: true, 
            message: 'Auto-login successful',
            name: user.name, 
            credits: user.credits, 
            picture: user.picture 
        });
    } catch (error) {
        console.error("Error in /auth/auto-login:", error);
        res.status(500).json({ success: false, message: 'Server error during auto-login', error: error.message });
    }
});

// Add this error handling middleware at the end of your file, just before app.listen()
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({
    success: false,
    message: 'An unexpected error occurred',
    error: process.env.NODE_ENV === 'production' ? {} : err
  });
});

function cleanupUnverifiedUsers() {
  const now = Date.now();
  for (const [userId, userData] of unverifiedUsers.entries()) {
    if (now - userData.createdAt > 24 * 60 * 60 * 1000) { // 24 hours expiration
      unverifiedUsers.delete(userId);
    }
  }
}

// Call this function periodically, e.g., every hour
setInterval(cleanupUnverifiedUsers, 60 * 60 * 1000);

// Start the server
app.listen(8080, () => {
  console.log("Server running on port 8080");
});
