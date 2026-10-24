// Service worker do ProtoWeb: recebe notificações push (Firebase Cloud Messaging) com o aplicativo fechado.
importScripts("https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js", "https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js");
firebase.initializeApp({
  apiKey: "AIzaSyBZLo5U4JkQvzFYoig8L-wRfe2DDuLLLWg",
  authDomain: "protoweb-4f4b1.firebaseapp.com",
  projectId: "protoweb-4f4b1",
  storageBucket: "protoweb-4f4b1.firebasestorage.app",
  messagingSenderId: "18056559923",
  appId: "1:18056559923:web:649b5ce4824e7a94c51246"
});
firebase.messaging(); // exibe automaticamente as notificações recebidas em segundo plano
