const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");
require("dotenv").config();

// Check for service account credentials
let serviceAccount;
try {
  // Try to load service account from file if available
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    serviceAccount = require(process.env.GOOGLE_APPLICATION_CREDENTIALS);
  } else {
    // Otherwise, use environment variables
    serviceAccount = {
      type: "service_account",
      project_id: process.env.FIREBASE_PROJECT_ID,
      private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
      private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
      client_email: process.env.FIREBASE_CLIENT_EMAIL,
      client_id: process.env.FIREBASE_CLIENT_ID,
      auth_uri: "https://accounts.google.com/o/oauth2/auth",
      token_uri: "https://oauth2.googleapis.com/token",
      auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
      client_x509_cert_url: process.env.FIREBASE_CLIENT_CERT_URL,
    };
  }
} catch (error) {
  console.error("Error loading Firebase service account:", error);
  process.exit(1);
}

// Initialize Firebase app
console.log(
  "Initializing Firebase app with project ID:",
  serviceAccount.project_id
);
const app = initializeApp({
  credential: cert(serviceAccount),
});

// Initialize Firestore with settings
const db = getFirestore();
db.settings({
  ignoreUndefinedProperties: true,
  timestampsInSnapshots: true,
});

console.log("Firestore initialized successfully");

// Initialize Firebase Auth
const auth = getAuth(app);
console.log("Firebase Auth initialized successfully");

// Test Firestore connection
async function testFirestoreConnection() {
  try {
    const testDoc = await db.collection("_test_connection").doc("test").get();
    console.log("Firestore connection test successful");
    return true;
  } catch (error) {
    console.error("Firestore connection test failed:", error);
    return false;
  }
}

// Run the test (but don't wait for it to complete)
testFirestoreConnection();

module.exports = {
  app,
  db,
  auth,
};
