const mongoose = require('mongoose');

const mongoUri = "mongodb+srv://derderprince10:MZmsbF2YeSypSWwz@cluster0.aquqj.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0";

mongoose.connect(mongoUri, {
  useNewUrlParser: true,
  useUnifiedTopology: true
});

const db = mongoose.connection;
db.on('error', console.error.bind(console, 'connection error:'));
db.once('open', function() {
  console.log("Connected to MongoDB Atlas");
});

const userSchema = new mongoose.Schema({
  userId: String,
  name: String,
  email: String,
  credits: Number,
  picture: String,
  referralCode: String,
  referredBy: String,
  pendingReferrals: [String],
  claimedReferrals: [String],
  password: String,
  verificationToken: String,
  isVerified: Boolean,
  resetPasswordToken: String,
  resetPasswordExpires: Date
});

const User = mongoose.model('User', userSchema);

async function getUser(userId) {
  return await User.findOne({ userId });
}

function generateReferralCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

async function createUser(userId, name, email, initialCredits, picture, referralCode = null, password = null, verificationToken = null, isVerified = false) {
  const newUserReferralCode = generateReferralCode();
  const newUser = new User({ 
    userId, 
    name, 
    email, 
    credits: initialCredits, 
    picture, // This will now be the path to the uploaded image
    referralCode: newUserReferralCode, 
    referredBy: referralCode,
    password,
    verificationToken,
    isVerified
  });
  await newUser.save();

  console.log(`New user created: ${userId}, Referred by: ${referralCode}`);

  if (referralCode) {
    const result = await addPendingReferral(referralCode, userId);
    console.log(`Referral result for ${userId}: ${JSON.stringify(result)}`);
  }

  return newUser;
}

async function updateCredits(userId, newCredits) {
  await User.updateOne({ userId }, { $set: { credits: newCredits } });
}

async function claimReferralCredits(userId) {
  const user = await User.findOne({ userId });
  if (user && user.pendingReferrals.length > 0) {
    // Remove duplicates from pendingReferrals
    const uniquePendingReferrals = [...new Set(user.pendingReferrals)];
    const creditsToAdd = 30 * uniquePendingReferrals.length;
    user.credits += creditsToAdd;

    // Add unique pending referrals to claimed referrals
    user.claimedReferrals = [...new Set([...user.claimedReferrals, ...uniquePendingReferrals])];

    // Clear pending referrals
    user.pendingReferrals = [];

    await user.save();
    console.log(`User ${userId} claimed ${creditsToAdd} credits for ${uniquePendingReferrals.length} referrals`);
    return { success: true, newCredits: user.credits, claimedCredits: creditsToAdd };
  }
  return { success: false };
}

async function addPendingReferral(referrerCode, newUserId) {
  console.log(`Attempting to add pending referral. Referrer code: ${referrerCode}, New user: ${newUserId}`);
  const referrer = await User.findOne({ referralCode: referrerCode });
  if (referrer) {
    if (!referrer.pendingReferrals.includes(newUserId)) {
      referrer.pendingReferrals.push(newUserId);
      await referrer.save();
      console.log(`Added pending referral for user ${newUserId} to referrer ${referrer.userId}. Updated pending referrals:`, referrer.pendingReferrals);
    } else {
      console.log(`User ${newUserId} already in pending referrals for referrer ${referrer.userId}`);
    }
    return referrer;
  } else {
    console.log(`No referrer found for code: ${referrerCode}`);
    return null;
  }
}

async function getUserByEmail(email) {
  return await User.findOne({ email });
}

async function getUserByVerificationToken(token) {
  return await User.findOne({ verificationToken: token });
}

async function verifyUser(userId) {
  await User.updateOne({ userId }, { $set: { isVerified: true, verificationToken: null } });
}

async function getUserByResetToken(token) {
  return await User.findOne({ 
    resetPasswordToken: token,
    resetPasswordExpires: { $gt: Date.now() }
  });
}

async function updateUserPassword(userId, newPassword) {
  await User.updateOne(
    { userId }, 
    { 
      $set: { 
        password: newPassword,
        resetPasswordToken: undefined,
        resetPasswordExpires: undefined
      } 
    }
  );
}

async function updateUserProfilePicture(userId, picturePath) {
  await User.updateOne({ userId }, { $set: { picture: picturePath } });
}

module.exports = { 
  getUser, 
  createUser, 
  updateCredits, 
  claimReferralCredits, 
  User,
  addPendingReferral,
  getUserByEmail,
  getUserByVerificationToken,
  verifyUser,
  getUserByResetToken,
  updateUserPassword,
  updateUserProfilePicture
};
