// --- Dependencies ---
const TelegramBot = require("node-telegram-bot-api");
const admin = require("firebase-admin");
const { format } = require("date-fns");
require("dotenv").config(); // For loading env variables

// --- Firebase Setup ---
const serviceAccount = require("/app/nfc.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://acelinks-chatbot-default-rtdb.firebaseio.com/",
});

const db = admin.database();

// --- Bot Setup ---
const token = process.env.BOT_TOKEN;
const bot = new TelegramBot(token, { polling: true });

// --- Admin Chat ID ---
const adminChatId = process.env.ADMIN_CHAT_ID;

// --- In-Memory States ---
const userStates = {};
const adminChatSessions = {};

// --- Firebase Functions ---
async function saveOrder(orderId, data) {
  await db.ref(`orders/${orderId}`).set(data);
}

async function getOrder(orderId) {
  const snapshot = await db.ref(`orders/${orderId}`).once("value");
  return snapshot.exists() ? snapshot.val() : null;
}

async function saveChatMessage(chatId, message, sender) {
  const chatRef = db.ref(`chats/${chatId}`).push();
  await chatRef.set({ message, sender, timestamp: Date.now() });
}

// --- Helper: Show Main Menu ---
function showMainMenu(chatId) {
  const menu = {
    reply_markup: {
      keyboard: [["📦 Order NFC Card"], ["📍 Track Order"], ["💬 Live Chat"]],
      resize_keyboard: true,
    },
  };
  bot.sendMessage(chatId, "Choose an option:", menu);
  userStates[chatId] = { state: "main_menu" };
}

// --- Handle Order Placement ---
async function handleOrder(chatId, text) {
  const userState = userStates[chatId];

  if (userState.state === "awaiting_name") {
    userState.name = text;
    userState.state = "awaiting_phone";
    return bot.sendMessage(chatId, "📞 Enter your phone number:");
  }

  if (userState.state === "awaiting_phone") {
    userState.phone = text;
    userState.state = "awaiting_address";
    return bot.sendMessage(chatId, "📍 Enter your address:");
  }

  if (userState.state === "awaiting_address") {
    userState.address = text;

    const orderId =
      "NFC-" + Math.random().toString(36).substr(2, 8).toUpperCase();
    const orderData = {
      name: userState.name,
      phone: userState.phone,
      address: userState.address,
      status: "Pending",
      date: format(new Date(), "yyyy-MM-dd HH:mm:ss"),
      orderId,
    };

    await saveOrder(orderId, orderData);

    bot.sendMessage(chatId, `✅ Order placed! Your order ID is: *${orderId}*`, {
      parse_mode: "Markdown",
    });

    if (adminChatId) {
      bot.sendMessage(
        adminChatId,
        `📬 New order:\nName: ${orderData.name}\nPhone: ${orderData.phone}\nAddress: ${orderData.address}\nOrder ID: ${orderId}`
      );
    }

    showMainMenu(chatId);
  }
}

// --- Handle Order Tracking ---
async function handleTrackingInput(chatId, text) {
  const orderId = text.trim().toUpperCase();
  const order = await getOrder(orderId);

  if (order) {
    const msg = `📦 Order ID: ${orderId}\n👤 Name: ${order.name}\n📞 Phone: ${order.phone}\n📍 Address: ${order.address}\n📅 Date: ${order.date}\n🚚 Status: *${order.status}*`;
    bot.sendMessage(chatId, msg, { parse_mode: "Markdown" });
  } else {
    bot.sendMessage(
      chatId,
      "❌ Order not found. Please check the ID and try again."
    );
  }

  showMainMenu(chatId);
}

// --- Start Live Chat ---
function startLiveChat(chatId, userName) {
  userStates[chatId] = { state: "chatting" };
  adminChatSessions[chatId] = adminChatId;

  bot.sendMessage(
    chatId,
    "💬 You are now connected to a support agent. Type your message below."
  );

  if (adminChatId) {
    bot.sendMessage(adminChatId, `👤 ${userName} started a live chat.`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "Reply", callback_data: `reply_${chatId}` }],
        ],
      },
    });
  }
}

// --- End Live Chat ---
function endLiveChat(chatId, userName) {
  userStates[chatId] = { state: "main_menu" };
  delete adminChatSessions[chatId];

  bot.sendMessage(chatId, "✅ Live chat ended.");

  if (adminChatId) {
    bot.sendMessage(adminChatId, `❌ ${userName} ended the live chat.`);
  }

  showMainMenu(chatId);
}

// --- Message Handler ---
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  const userName = msg.from.first_name || "User";

  if (!userStates[chatId]) userStates[chatId] = { state: "main_menu" };

  // Admin replying
  if (userStates[chatId]?.state === "admin_replying") {
    const customerId = userStates[chatId].customerId;
    if (customerId) {
      bot.sendMessage(customerId, `👤 Support: ${text}`);
      await saveChatMessage(customerId, text, "admin");
    }
    return;
  }

  // End user chat
  if (text === "/end") {
    return endLiveChat(chatId, userName);
  }

  // Admin ends chat
  if (text === "/endchat" && userStates[chatId]?.state === "admin_replying") {
    const customerId = userStates[chatId].customerId;
    if (customerId) {
      bot.sendMessage(customerId, "❌ The support agent ended the chat.");
    }
    bot.sendMessage(chatId, "✅ Chat closed.");
    delete adminChatSessions[customerId];
    userStates[chatId] = { state: "main_menu" };
    return;
  }

  switch (text) {
    case "/start":
      return showMainMenu(chatId);
    case "📦 Order NFC Card":
      userStates[chatId].state = "awaiting_name";
      return bot.sendMessage(chatId, "👤 Enter your full name:");
    case "📍 Track Order":
      userStates[chatId].state = "awaiting_tracking";
      return bot.sendMessage(
        chatId,
        "🔎 Enter your order ID (e.g., NFC-XXXXXX):"
      );
    case "💬 Live Chat":
      return startLiveChat(chatId, userName);
    default:
      if (userStates[chatId].state?.startsWith("awaiting_")) {
        if (userStates[chatId].state === "awaiting_tracking") {
          return await handleTrackingInput(chatId, text);
        } else {
          return await handleOrder(chatId, text);
        }
      } else if (userStates[chatId].state === "chatting") {
        const supportMessage = `📨 ${userName}: ${text}`;
        if (adminChatId) bot.sendMessage(adminChatId, supportMessage);
        await saveChatMessage(chatId, text, "user");
      }
      break;
  }
});

// --- Admin Button Handler ---
bot.on("callback_query", (query) => {
  const data = query.data;
  const chatId = query.message.chat.id;

  if (data.startsWith("reply_")) {
    const customerId = data.split("_")[1];
    adminChatSessions[customerId] = chatId;
    userStates[chatId] = { state: "admin_replying", customerId };

    bot.sendMessage(
      chatId,
      `✉️ You can now reply to the customer. Type your message.`
    );
  }

  bot.answerCallbackQuery(query.id);
});
