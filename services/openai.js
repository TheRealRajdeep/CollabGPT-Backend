const OpenAI = require("openai");
require("dotenv").config();

// Initialize OpenAI with API key from environment variables
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Default model to use
const defaultModel = process.env.MODEL || "gpt-4-turbo";

/**
 * Generate a response using OpenAI API
 * @param {string} prompt - The user prompt
 * @param {Array} previousMessages - Previous messages for context
 * @returns {Promise<string>} - The AI generated response
 */
async function generateResponse(prompt, previousMessages = []) {
  try {
    // Format previous messages for OpenAI context
    const formattedMessages = previousMessages.map((msg) => ({
      role: msg.role,
      content: msg.content,
    }));

    // Add the current prompt
    formattedMessages.push({
      role: "user",
      content: prompt,
    });

    // Make API call to OpenAI
    const response = await openai.chat.completions.create({
      model: defaultModel,
      messages: formattedMessages,
      temperature: 0.7,
      max_tokens: 2000,
      top_p: 1,
      frequency_penalty: 0,
      presence_penalty: 0,
    });

    // Return the generated text
    return response.choices[0].message.content;
  } catch (error) {
    console.error("Error generating AI response:", error);
    throw new Error(`Failed to generate AI response: ${error.message}`);
  }
}

module.exports = {
  generateResponse,
};
