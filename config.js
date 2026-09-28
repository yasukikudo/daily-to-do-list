// 1) Firebase project settings (from the Firebase console).
//    (These values are safe to publish. Your data is protected by Firebase Authentication and firestore.rules.)
export const firebaseConfig = {
  apiKey: "AIzaSyC_EArORgdWRrMv_ErhvoYj5UcYSXi_DGk",
  authDomain: "daily-to-do-list-a64c4.firebaseapp.com",
  projectId: "daily-to-do-list-a64c4",
  storageBucket: "daily-to-do-list-a64c4.firebasestorage.app",
  messagingSenderId: "557727577726",
  appId: "1:557727577726:web:cad86d4f2580c3be610a2f",
  measurementId: "G-YCGYZWEV2B"
};

// 2) PIN = the password of each Firebase account (6 digits, because Firebase requires at least 6 characters).
//    Each person types their email once per device (kept only in that browser).
//    Names, columns and routines are registered inside the app and saved privately in Firestore.
export const PIN_LENGTH = 6;

// 3) true: ask for the PIN every time the app window is opened again.
//    false: stay signed in on this device until you press "Sign out".
export const ASK_PIN_EVERY_TIME = true;

// 4) Stamps you can pick instead of ✅ (each one counts as "done"). Add or remove freely.
export const STICKERS = [
  "💕", "❤️", "🧡", "💚", "💙", "💟", "🫶", "🥰", "😘", "🫂",
  "👩‍❤️‍💋‍👨", "❤️‍🩹", "🩹", "🎉", "✨", "💪", "😭"
];
