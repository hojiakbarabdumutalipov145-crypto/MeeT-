// MeeT sozlamalari.
// firebaseConfig — Firebase konsolidan (Project settings → Your apps → SDK setup and configuration).
// Bu kalitlar maxfiy emas: himoya Firestore qoidalari (firestore.rules) orqali amalga oshiriladi.
export const firebaseConfig = {
  apiKey: 'AIzaSyCsdlDTDoDBx72poLpAA9oyHyQG7qS2HM0',
  authDomain: 'meet-app-60b00.firebaseapp.com',
  projectId: 'meet-app-60b00',
  storageBucket: 'meet-app-60b00.firebasestorage.app',
  messagingSenderId: '82065228143',
  appId: '1:82065228143:web:64dd4f8b671f80791ee89a',
};

// Video qo'ng'iroq uchun. STUN bepul, lekin ba'zi tarmoqlarda (mobil internet, korporativ) TURN ham kerak bo'ladi.
// TURN qo'shish uchun masalan: { urls: 'turn:turn.example.com:3478', username: '...', credential: '...' }
export const iceServers = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

// Fayllar hozircha Firestore'da saqlanadi (Storage kerak emas). Katta fayllar (APK) uchun keyinroq Storage ulanadi.
export const maxFileMb = 10;

export const SDK_VERSION = '10.14.1';
