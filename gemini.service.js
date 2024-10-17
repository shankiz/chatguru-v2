const { GoogleGenerativeAI } = require("@google/generative-ai");
const { FSDB } = require("file-system-db");
const { downloadImage } = require("./utilities.service");
const genAI = new GoogleGenerativeAI(process.env.GEMINI_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });

async function ask(chatId, message) {
  try {
    const db = new FSDB(`./db/${chatId}.json`, false);
    const history = db.get("history") || [];

    const newMessage = {
      role: "user",
      parts: [],
    };
    if (message.text) {
      newMessage.parts.push({ text: message.text });
    }
    if (message.image_url) {
      const { data, mimeType } = await downloadImage(message.image_url);
      newMessage.parts.push({
        inlineData: {
          data,
          mimeType,
        },
      });
    }
    history.push(newMessage);

    const chat = model.startChat({
      history: history.slice(),
      generationConfig: {
        maxOutputTokens: 1000,
      },
    });
    const result = await chat.sendMessage(newMessage.parts);
    const response = await result.response;
    const text = response.text();
    history.push({
      role: "model",
      parts: [{ text }],
    });
    db.set("history", history);
    return text;
  } catch (error) {
    console.error(error);
    return error.message || "An error occurred";
  }
}

module.exports = { ask };
